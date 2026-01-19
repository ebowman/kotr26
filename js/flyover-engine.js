/**
 * KOTR 2026 - Flyover Engine
 * Smooth 3D route visualization using Mapbox FreeCamera API
 *
 * Key techniques:
 * - Dual-path pattern (camera path separate from focal path)
 * - LERP smoothing to eliminate jitter
 * - Fixed timestep animation for consistent frame rate
 * - Pre-smoothed camera path
 * - Progressive route reveal
 *
 * Based on: https://docs.mapbox.com/mapbox-gl-js/example/free-camera-path/
 */

(function() {
    'use strict';

    // Mapbox access token - replace with your own for production
    const MAPBOX_TOKEN = 'pk.eyJ1IjoiZWJvd21hbiIsImEiOiJjbWE1ZWVwdzYwODhwMmlzZnU4NTlyem1rIn0.E10X5hj2NTgViJexKpvrOg';

    // Animation configuration
    const CONFIG = {
        // Camera settings (legacy - now in CameraModeConfig)
        cameraAltitude: 300,           // Base altitude above terrain (meters)
        cameraOffset: 200,              // Offset behind current position (meters)
        lookAheadDistance: 50,          // How far ahead camera looks (meters) - small to keep dot centered

        // Animation timing
        baseDuration: 600,              // Base duration in seconds for 100km (10 min)
        minDuration: 180,               // Minimum duration (3 min)

        // Route visualization
        routeLineWidth: 4,
        routeLineColor: '#FFD700',  // Bright gold/yellow - constant color
        trailWidth: 6,

        // Speed multipliers (adjusted so tiles can keep up)
        // Display label -> actual multiplier
        speeds: {
            '0.5': 0.125,   // Half speed
            '1': 0.25,      // Normal (what was 1/4x)
            '2': 0.5,       // 2x (what was 1/2x)
            '4': 1          // Max (what was 1x)
        }
    };

    // Camera Mode System
    const CameraModes = {
        CHASE: 'chase',
        BIRDS_EYE: 'birds_eye',
        SIDE_VIEW: 'side_view',
        CINEMATIC: 'cinematic'
    };

    const CameraModeConfig = {
        chase: {
            offsetBehind: 200,      // meters behind the dot
            offsetUp: 300,          // meters above terrain (matches original CONFIG.cameraAltitude)
            offsetSide: 0,          // meters to the side
            pitch: -15,             // degrees (negative = looking down)
            transitionDuration: 1000 // ms
        },
        birds_eye: {
            offsetBehind: 0,
            offsetUp: 800,
            offsetSide: 0,
            pitch: -75,
            transitionDuration: 1000
        },
        side_view: {
            offsetBehind: 0,
            offsetUp: 100,
            offsetSide: 400,        // meters to the side
            pitch: -10,
            transitionDuration: 1000
        },
        cinematic: {
            orbitRadius: 300,       // meters from dot
            orbitSpeed: 0.15,       // radians per second
            pitchMin: -30,
            pitchMax: -5,
            heightMin: 100,
            heightMax: 400,
            transitionDuration: 1500
        }
    };

    // Camera mode state
    let currentCameraMode = CameraModes.CINEMATIC;
    let targetCameraMode = CameraModes.CINEMATIC;
    let modeTransitionProgress = 1; // 0 = transitioning, 1 = complete
    let transitionStartState = null;
    let cinematicAngle = 0; // For cinematic orbit

    // Chase cam pitch adjustment (stored in localStorage)
    const PITCH_MIN = -75;  // Maximum downward (transitions to bird's eye)
    const PITCH_MAX = -5;   // Most horizontal
    const PITCH_STEP = 5;   // Degrees per arrow key press
    const PITCH_BIRDS_EYE_THRESHOLD = -70; // Switch to bird's eye when pitch goes below this
    let chaseCamPitch = loadPitchFromStorage();

    // User override state
    let userOverrideActive = false;
    let userOverrideTimeout = null;
    let returnProgress = 1;
    let lastUserCameraState = null;
    let userIsInteracting = false; // True when user has mouse/touch down on map

    // Mont Ventoux detection
    const VENTOUX_SUMMIT = {
        lat: 44.1739,
        lng: 5.2784,
        elevation: 1909,
        radius: 0.5 // km radius for detection
    };

    // State
    let map = null;
    let routeData = null;
    let elevationProfile = null;

    // Animation state
    let isPlaying = false;
    let animationId = null;
    let progress = 0;
    let speedMultiplier = 0.25; // Default to 1x speed (matches CONFIG.speeds['1'])
    let lastTimestamp = 0;

    // Previous position for bearing calculation
    let lastDotPoint = null;

    // Route geometry
    let routeLine = null;
    let cameraPath = null;
    let totalDistance = 0;

    /**
     * Load pitch from localStorage
     */
    function loadPitchFromStorage() {
        try {
            const stored = localStorage.getItem('kotr-flyover-pitch');
            if (stored !== null) {
                const pitch = parseFloat(stored);
                if (!isNaN(pitch) && pitch >= PITCH_MIN && pitch <= PITCH_MAX) {
                    return pitch;
                }
            }
        } catch (e) {
            // localStorage not available
        }
        return -15; // Default pitch
    }

    /**
     * Save pitch to localStorage
     */
    function savePitchToStorage(pitch) {
        try {
            localStorage.setItem('kotr-flyover-pitch', pitch.toString());
        } catch (e) {
            // localStorage not available
        }
    }

    /**
     * Linear interpolation
     */
    function lerp(start, end, t) {
        return start + (end - start) * t;
    }

    /**
     * Spherical linear interpolation for coordinates
     */
    function lerpCoord(start, end, t) {
        return {
            lng: lerp(start.lng, end.lng, t),
            lat: lerp(start.lat, end.lat, t),
            alt: lerp(start.alt || 0, end.alt || 0, t)
        };
    }

    /**
     * Ease-out cubic for smooth deceleration
     */
    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    /**
     * Ease-in-out cubic for smooth both ends
     */
    function easeInOutCubic(t) {
        return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    /**
     * Camera state object for transitions
     */
    function createCameraState(lng, lat, alt, bearing, pitch) {
        return { lng, lat, alt, bearing, pitch };
    }

    /**
     * Interpolate between two camera states
     */
    function lerpCameraState(start, end, t) {
        // Handle bearing wrap-around (e.g., 350 to 10 degrees)
        let startBearing = start.bearing;
        let endBearing = end.bearing;
        let bearingDiff = endBearing - startBearing;

        if (bearingDiff > 180) startBearing += 360;
        else if (bearingDiff < -180) endBearing += 360;

        return {
            lng: lerp(start.lng, end.lng, t),
            lat: lerp(start.lat, end.lat, t),
            alt: lerp(start.alt, end.alt, t),
            bearing: (lerp(startBearing, endBearing, t) + 360) % 360,
            pitch: lerp(start.pitch, end.pitch, t)
        };
    }

    /**
     * Get current camera state from map
     */
    function getCurrentCameraState() {
        try {
            const camera = map.getFreeCameraOptions();
            const pos = camera.position;
            const lngLat = pos.toLngLat();
            const center = map.getCenter();
            const bearing = map.getBearing();
            const pitch = map.getPitch();

            return createCameraState(
                lngLat.lng,
                lngLat.lat,
                pos.toAltitude(),
                bearing,
                pitch
            );
        } catch (e) {
            // Fallback
            return createCameraState(
                map.getCenter().lng,
                map.getCenter().lat,
                1000,
                map.getBearing(),
                map.getPitch()
            );
        }
    }

    /**
     * Calculate bearing between two points
     */
    function calculateBearing(start, end) {
        const startLat = start.lat * Math.PI / 180;
        const startLng = start.lng * Math.PI / 180;
        const endLat = end.lat * Math.PI / 180;
        const endLng = end.lng * Math.PI / 180;

        const y = Math.sin(endLng - startLng) * Math.cos(endLat);
        const x = Math.cos(startLat) * Math.sin(endLat) -
            Math.sin(startLat) * Math.cos(endLat) * Math.cos(endLng - startLng);

        let bearing = Math.atan2(y, x) * 180 / Math.PI;
        return (bearing + 360) % 360;
    }

    /**
     * Get point at distance along route using Turf.js
     */
    function getPointAlongRoute(distance) {
        if (!routeLine || !routeData) return null;

        try {
            const point = turf.along(routeLine, distance, { units: 'kilometers' });
            const lng = point.geometry.coordinates[0];
            const lat = point.geometry.coordinates[1];

            // Interpolate altitude from original 3D coordinates
            const alt = interpolateAltitude(distance);

            return { lng, lat, alt };
        } catch (e) {
            return null;
        }
    }

    /**
     * Interpolate altitude at a given distance along the route
     */
    function interpolateAltitude(targetDistance) {
        if (!routeData || !routeData.coordinates) return 0;

        const coords = routeData.coordinates;
        let cumulativeDistance = 0;

        for (let i = 1; i < coords.length; i++) {
            const segmentLength = turf.distance(
                turf.point([coords[i - 1][0], coords[i - 1][1]]),
                turf.point([coords[i][0], coords[i][1]]),
                { units: 'kilometers' }
            );

            if (cumulativeDistance + segmentLength >= targetDistance) {
                // Interpolate within this segment
                const ratio = (targetDistance - cumulativeDistance) / segmentLength;
                const alt1 = coords[i - 1][2] || 0;
                const alt2 = coords[i][2] || 0;
                return alt1 + (alt2 - alt1) * ratio;
            }

            cumulativeDistance += segmentLength;
        }

        // Return last point's altitude if beyond route
        return coords[coords.length - 1][2] || 0;
    }

    /**
     * Get camera position offset from route point (legacy - used as fallback)
     */
    function getCameraPosition(routePoint, nextPoint, altitude) {
        if (!routePoint || !nextPoint) return routePoint;

        // Calculate bearing from current to next point
        const bearing = calculateBearing(routePoint, nextPoint);

        // Offset camera behind and above the route
        const offsetDistance = CONFIG.cameraOffset / 1000; // Convert to km

        // Calculate offset position (behind the current point)
        const offsetBearing = (bearing + 180) % 360; // Opposite direction
        const offsetPoint = turf.destination(
            turf.point([routePoint.lng, routePoint.lat]),
            offsetDistance,
            offsetBearing,
            { units: 'kilometers' }
        );

        return {
            lng: offsetPoint.geometry.coordinates[0],
            lat: offsetPoint.geometry.coordinates[1],
            alt: routePoint.alt + altitude
        };
    }

    /**
     * Calculate camera state for a given mode
     */
    function calculateCameraForMode(mode, dotPoint, nextPoint, deltaTime) {
        if (!dotPoint || !nextPoint) return null;

        const config = CameraModeConfig[mode];
        const forwardBearing = calculateBearing(dotPoint, nextPoint);

        let cameraLng, cameraLat, cameraAlt, cameraBearing, cameraPitch;

        switch (mode) {
            case CameraModes.CHASE: {
                // Chase cam: behind and above the dot
                // Calculate altitude based on desired pitch angle
                // tan(pitch) = altitude / horizontal_distance
                // So: altitude = horizontal_distance * tan(|pitch|)
                const pitchRadians = Math.abs(chaseCamPitch) * Math.PI / 180;
                const calculatedAltitude = config.offsetBehind * Math.tan(pitchRadians);

                const behindBearing = (forwardBearing + 180) % 360;
                const offsetPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    config.offsetBehind / 1000,
                    behindBearing,
                    { units: 'kilometers' }
                );
                cameraLng = offsetPoint.geometry.coordinates[0];
                cameraLat = offsetPoint.geometry.coordinates[1];
                // Use calculated altitude based on pitch, plus terrain following
                cameraAlt = dotPoint.alt + calculatedAltitude + (dotPoint.alt * 0.1);
                cameraBearing = forwardBearing;
                cameraPitch = chaseCamPitch;
                break;
            }

            case CameraModes.BIRDS_EYE: {
                // Bird's eye: nearly above, looking down at the dot
                // Offset slightly behind (south) to avoid gimbal lock with lookAtPoint
                const behindOffset = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    0.05, // 50 meters behind
                    (forwardBearing + 180) % 360, // behind the direction of travel
                    { units: 'kilometers' }
                );
                cameraLng = behindOffset.geometry.coordinates[0];
                cameraLat = behindOffset.geometry.coordinates[1];
                cameraAlt = dotPoint.alt + config.offsetUp;
                cameraBearing = forwardBearing; // Face direction of travel
                cameraPitch = config.pitch;
                break;
            }

            case CameraModes.SIDE_VIEW: {
                // Side view: perpendicular to route direction
                const sideBearing = (forwardBearing + 90) % 360;
                const offsetPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    config.offsetSide / 1000,
                    sideBearing,
                    { units: 'kilometers' }
                );
                cameraLng = offsetPoint.geometry.coordinates[0];
                cameraLat = offsetPoint.geometry.coordinates[1];
                cameraAlt = dotPoint.alt + config.offsetUp;
                // Look at the dot from the side
                cameraBearing = (sideBearing + 180) % 360;
                cameraPitch = config.pitch;
                break;
            }

            case CameraModes.CINEMATIC: {
                // Cinematic: orbiting around the dot
                if (deltaTime) {
                    cinematicAngle += config.orbitSpeed * deltaTime;
                }
                const orbitBearing = (cinematicAngle * 180 / Math.PI) % 360;
                const offsetPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    config.orbitRadius / 1000,
                    orbitBearing,
                    { units: 'kilometers' }
                );
                cameraLng = offsetPoint.geometry.coordinates[0];
                cameraLat = offsetPoint.geometry.coordinates[1];
                // Vary height sinusoidally
                const heightT = (Math.sin(cinematicAngle * 0.5) + 1) / 2;
                cameraAlt = dotPoint.alt + lerp(config.heightMin, config.heightMax, heightT);
                // Look at the dot
                cameraBearing = (orbitBearing + 180) % 360;
                // Vary pitch
                const pitchT = (Math.sin(cinematicAngle * 0.3) + 1) / 2;
                cameraPitch = lerp(config.pitchMin, config.pitchMax, pitchT);
                break;
            }

            default:
                return null;
        }

        return createCameraState(cameraLng, cameraLat, cameraAlt, cameraBearing, cameraPitch);
    }

    // Flag for free navigation mode when animation is paused
    let freeNavigationEnabled = false;

    /**
     * Transition to a new camera mode
     */
    function transitionToMode(newMode) {
        if (newMode === currentCameraMode && modeTransitionProgress >= 1) return;

        // Cancel user override and free navigation
        userOverrideActive = false;
        userIsInteracting = false;
        freeNavigationEnabled = false;
        clearTimeout(userOverrideTimeout);
        returnProgress = 1;
        lastUserCameraState = null;

        // Hide user control indicator if showing
        hideUserControlIndicator();

        targetCameraMode = newMode;
        modeTransitionProgress = 0;
        transitionStartState = getCurrentCameraState();

        // Update UI
        updateCameraModeUI(newMode);

        // Immediately update camera position (works whether playing or not)
        // Complete the transition instantly when not playing
        if (!isPlaying) {
            // Fast-forward the transition
            modeTransitionProgress = 1;
            currentCameraMode = targetCameraMode;
            transitionStartState = null;

            // Temporarily disable free navigation to allow camera update
            freeNavigationEnabled = false;
            updateCamera(0.016);

            // Enable free navigation mode when animation is paused
            // This allows user to pan/zoom/rotate freely after mode change
            freeNavigationEnabled = true;
        }
    }

    /**
     * Mode display names
     */
    const CameraModeNames = {
        chase: 'Chase Cam',
        birds_eye: "Bird's Eye",
        side_view: 'Side View',
        cinematic: 'Cinematic'
    };

    /**
     * Update camera mode button UI and indicator
     */
    function updateCameraModeUI(mode) {
        const btns = document.querySelectorAll('.mode-btn');
        btns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // Update mode indicator
        const indicator = document.getElementById('camera-mode-indicator');
        const label = indicator?.querySelector('.mode-label');
        if (label) {
            label.textContent = CameraModeNames[mode] || mode;
        }
        indicator?.classList.remove('user-control');
    }

    /**
     * Show user control indicator
     */
    function showUserControlIndicator() {
        const indicator = document.getElementById('camera-mode-indicator');
        const label = indicator?.querySelector('.mode-label');
        if (label) {
            label.textContent = 'Free Look';
        }
        indicator?.classList.add('user-control');
    }

    /**
     * Hide user control indicator and restore mode name
     */
    function hideUserControlIndicator() {
        const indicator = document.getElementById('camera-mode-indicator');
        const label = indicator?.querySelector('.mode-label');
        if (label) {
            label.textContent = CameraModeNames[currentCameraMode] || currentCameraMode;
        }
        indicator?.classList.remove('user-control');
    }

    /**
     * Handle user starting interaction with the map (mousedown/touchstart)
     */
    function handleUserInteractionStart() {
        userIsInteracting = true;
        userOverrideActive = true;
        returnProgress = 1;
        clearTimeout(userOverrideTimeout);

        // Show user control indicator
        showUserControlIndicator();
    }

    /**
     * Handle user ending interaction with the map (mouseup/touchend)
     */
    function handleUserInteractionEnd() {
        userIsInteracting = false;

        // After 2 seconds of no interaction, start smooth return
        clearTimeout(userOverrideTimeout);
        userOverrideTimeout = setTimeout(() => {
            if (!userIsInteracting) {
                userOverrideActive = false;
                returnProgress = 0;
                lastUserCameraState = getCurrentCameraState();
                hideUserControlIndicator();
            }
        }, 2000);
    }

    /**
     * Generate smoothed camera path from route
     * Uses Douglas-Peucker simplification to reduce jitter
     */
    function generateCameraPath(coordinates) {
        // Convert 3D coordinates to 2D for Turf.js compatibility
        const coords2D = coordinates.map(c => [c[0], c[1]]);

        // Create a GeoJSON line
        const line = turf.lineString(coords2D);

        try {
            // Simplify the path (tolerance in degrees, ~0.0001 = ~10m)
            const simplified = turf.simplify(line, {
                tolerance: 0.0001,
                highQuality: true
            });
            return simplified;
        } catch (e) {
            // If simplification fails, return original line
            console.warn('Path simplification failed, using original path:', e);
            return line;
        }
    }

    /**
     * Initialize the map
     */
    function initMap() {
        mapboxgl.accessToken = MAPBOX_TOKEN;

        map = new mapboxgl.Map({
            container: 'map',
            style: 'mapbox://styles/mapbox/satellite-streets-v12',
            center: [4.8055, 43.9493], // Avignon
            zoom: 12,
            pitch: 75,
            bearing: 0,
            antialias: true
        });

        map.on('load', async () => {
            // Add terrain source (optional - gracefully handle failures)
            try {
                map.addSource('mapbox-dem', {
                    type: 'raster-dem',
                    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                    tileSize: 512,
                    maxzoom: 14
                });

                // Set terrain with exaggeration
                map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.3 });
            } catch (e) {
                console.warn('3D terrain not available:', e);
            }

            // Add atmosphere/fog
            try {
                map.setFog({
                    color: 'rgb(186, 210, 235)',
                    'high-color': 'rgb(36, 92, 223)',
                    'horizon-blend': 0.02,
                    'space-color': 'rgb(11, 11, 25)',
                    'star-intensity': 0.6
                });

                // Add sky layer
                map.addLayer({
                    id: 'sky',
                    type: 'sky',
                    paint: {
                        'sky-type': 'atmosphere',
                        'sky-atmosphere-sun': [0.0, 90.0],
                        'sky-atmosphere-sun-intensity': 15
                    }
                });
            } catch (e) {
                console.warn('Atmosphere effects not available:', e);
            }

            // Load the route
            await loadRoute();
        });

        // Add navigation controls
        map.addControl(new mapboxgl.NavigationControl(), 'top-right');

        // Handle tile loading errors gracefully
        map.on('error', (e) => {
            // Ignore terrain tile loading errors - they're not critical
            if (e.error && e.error.message && e.error.message.includes('Load failed')) {
                console.warn('Tile loading error (non-critical):', e.error.message);
                return;
            }
            console.error('Map error:', e);
        });
    }

    /**
     * Load route from URL parameter
     */
    async function loadRoute() {
        const params = new URLSearchParams(window.location.search);
        const routeFile = params.get('route');

        if (!routeFile) {
            showError('No route specified');
            return;
        }

        try {
            // Parse FIT file
            console.log('Loading route file:', routeFile);
            routeData = await FitParser.loadFitFile(`routes/${routeFile}`);
            console.log('Route data loaded:', {
                points: routeData.coordinates?.length,
                distance: routeData.distance,
                elevation: routeData.elevationGain,
                bounds: routeData.bounds
            });

            // Check if we have valid coordinates
            if (!routeData.coordinates || routeData.coordinates.length === 0) {
                throw new Error('No coordinates found in route file');
            }

            // Generate route line for Turf.js (2D coordinates for compatibility)
            const coords2D = routeData.coordinates.map(c => [c[0], c[1]]);
            routeLine = turf.lineString(coords2D);
            totalDistance = turf.length(routeLine, { units: 'kilometers' });
            console.log('Total distance:', totalDistance, 'km');

            // Generate smoothed camera path
            cameraPath = generateCameraPath(routeData.coordinates);

            // Update UI
            updateRouteInfo(routeFile);

            // Add route to map
            addRouteToMap();

            // Initialize elevation profile
            initElevationProfile();

            // Fit map to route bounds
            fitMapToBounds();

            // Reset last dot point
            lastDotPoint = null;

            // Hide loading overlay
            hideLoading();

            // Setup controls
            setupControls();

        } catch (error) {
            console.error('Failed to load route:', error);
            showError(`Failed to load route: ${error.message}`);
        }
    }

    /**
     * Add route visualization to map
     */
    function addRouteToMap() {
        // Add route source
        map.addSource('route', {
            type: 'geojson',
            data: routeLine,
            lineMetrics: true
        });

        // Main route layer - constant bright yellow
        map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            paint: {
                'line-color': CONFIG.routeLineColor,
                'line-width': CONFIG.trailWidth,
                'line-opacity': 1
            },
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            }
        });

        // Current position marker
        map.addSource('current-position', {
            type: 'geojson',
            data: {
                type: 'Point',
                coordinates: routeData.coordinates[0]
            }
        });

        map.addLayer({
            id: 'current-position',
            type: 'circle',
            source: 'current-position',
            paint: {
                'circle-radius': 12,
                'circle-color': '#FF4444',
                'circle-stroke-width': 4,
                'circle-stroke-color': '#FFFFFF',
                'circle-pitch-alignment': 'viewport',  // Always face camera
                'circle-pitch-scale': 'viewport'       // Constant size regardless of zoom
            }
        });
    }

    /**
     * Fit map to route bounds
     */
    function fitMapToBounds() {
        if (!routeData || !routeData.bounds) return;

        map.fitBounds(routeData.bounds, {
            padding: 100,
            pitch: 60,
            bearing: calculateInitialBearing()
        });
    }

    /**
     * Calculate initial bearing based on route direction
     */
    function calculateInitialBearing() {
        if (!routeData || routeData.coordinates.length < 2) return 0;

        const start = {
            lat: routeData.coordinates[0][1],
            lng: routeData.coordinates[0][0]
        };
        const end = {
            lat: routeData.coordinates[Math.min(10, routeData.coordinates.length - 1)][1],
            lng: routeData.coordinates[Math.min(10, routeData.coordinates.length - 1)][0]
        };

        return calculateBearing(start, end);
    }

    /**
     * Update route info in UI
     */
    function updateRouteInfo(routeFile) {
        // Extract route name from filename
        let name = routeFile.replace('.fit', '').replace(/_/g, ' ');

        // Special handling for known routes
        if (routeFile.includes('Ventoux')) {
            name = 'Day 3 - Mont Ventoux';
        } else if (routeFile.includes('D1')) {
            name = 'Day 1 - Avignon Exploration';
        } else if (routeFile.includes('D2')) {
            name = 'Day 2 - Wine Country';
        } else if (routeFile.includes('D3')) {
            name = 'Day 3 - Luberon Villages';
        } else if (routeFile.includes('D4')) {
            name = 'Day 4 - Final Celebration';
        }

        document.getElementById('route-title').textContent = name;
    }

    /**
     * Initialize elevation profile
     */
    function initElevationProfile() {
        elevationProfile = new ElevationProfile.ElevationProfileRenderer('elevation-canvas');
        elevationProfile.setRouteData(routeData);

        // Handle clicks on elevation profile to seek
        elevationProfile.onPositionChange = (newPosition) => {
            seekToPosition(newPosition);
        };
    }

    /**
     * Setup playback controls
     */
    function setupControls() {
        const playBtn = document.getElementById('btn-play');
        const rewindBtn = document.getElementById('btn-rewind');
        const forwardBtn = document.getElementById('btn-forward');
        const speedBtns = document.querySelectorAll('.speed-btn');
        const progressBar = document.getElementById('progress-bar');
        const modeBtns = document.querySelectorAll('.mode-btn');
        const shortcutsHelp = document.getElementById('shortcuts-help');
        const shortcutsClose = document.getElementById('shortcuts-close');

        playBtn.addEventListener('click', togglePlay);
        rewindBtn.addEventListener('click', () => seekToPosition(Math.max(0, progress - 0.05)));
        forwardBtn.addEventListener('click', () => seekToPosition(Math.min(1, progress + 0.05)));

        speedBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                speedBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                speedMultiplier = CONFIG.speeds[btn.dataset.speed] || 1;
            });
        });

        // Profile track click to seek
        const profileTrack = document.getElementById('profile-track');
        if (profileTrack) {
            profileTrack.addEventListener('click', (e) => {
                const rect = profileTrack.getBoundingClientRect();
                const position = (e.clientX - rect.left) / rect.width;
                seekToPosition(position);
            });
        }

        // Draggable scrubber
        const scrubber = document.getElementById('scrubber-handle');
        if (scrubber && profileTrack) {
            let isDragging = false;

            const startDrag = (e) => {
                isDragging = true;
                e.preventDefault();
                document.body.style.cursor = 'grabbing';
                scrubber.style.cursor = 'grabbing';
            };

            const doDrag = (e) => {
                if (!isDragging) return;
                e.preventDefault();

                const rect = profileTrack.getBoundingClientRect();
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                let position = (clientX - rect.left) / rect.width;
                position = Math.max(0, Math.min(1, position));
                seekToPosition(position);
            };

            const endDrag = () => {
                if (isDragging) {
                    isDragging = false;
                    document.body.style.cursor = '';
                    scrubber.style.cursor = 'grab';
                }
            };

            // Mouse events
            scrubber.addEventListener('mousedown', startDrag);
            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', endDrag);

            // Touch events
            scrubber.addEventListener('touchstart', startDrag, { passive: false });
            document.addEventListener('touchmove', doDrag, { passive: false });
            document.addEventListener('touchend', endDrag);
        }

        // Camera mode buttons
        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode && Object.values(CameraModes).includes(mode)) {
                    transitionToMode(mode);
                }
            });
        });

        // Shortcuts help toggle
        const progressWidget = document.getElementById('unified-progress-widget');

        const updateProgressWidgetForHelp = () => {
            const isHelpVisible = shortcutsHelp && !shortcutsHelp.classList.contains('hidden');
            if (progressWidget) {
                progressWidget.classList.toggle('help-visible', isHelpVisible);
            }
        };

        // Initialize based on current help state
        updateProgressWidgetForHelp();

        if (shortcutsClose) {
            shortcutsClose.addEventListener('click', () => {
                shortcutsHelp?.classList.add('hidden');
                updateProgressWidgetForHelp();
            });
        }

        // Fullscreen button
        const fullscreenBtn = document.getElementById('btn-fullscreen');
        if (fullscreenBtn) {
            fullscreenBtn.addEventListener('click', toggleFullscreen);
        }

        // Map interaction detection for user override
        // Use direct DOM events on map canvas for reliable detection
        const mapCanvas = map.getCanvas();
        mapCanvas.addEventListener('mousedown', handleUserInteractionStart);
        mapCanvas.addEventListener('touchstart', handleUserInteractionStart, { passive: true });
        document.addEventListener('mouseup', handleUserInteractionEnd);
        document.addEventListener('touchend', handleUserInteractionEnd);

        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            // Ignore if typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'ArrowLeft':
                    seekToPosition(Math.max(0, progress - 0.02));
                    break;
                case 'ArrowRight':
                    seekToPosition(Math.min(1, progress + 0.02));
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    adjustChasePitch(-PITCH_STEP); // More downward (more negative)
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    adjustChasePitch(PITCH_STEP); // More horizontal (less negative)
                    break;
                case '1':
                case '2':
                case '3':
                case '4':
                    // Map 1-4 to the speed options: ½x, 1x, 2x, 4x
                    const speeds = ['0.5', '1', '2', '4'];
                    const speedIdx = parseInt(e.key) - 1;
                    if (speeds[speedIdx]) {
                        speedMultiplier = CONFIG.speeds[speeds[speedIdx]];
                        speedBtns.forEach(b => b.classList.toggle('active', b.dataset.speed === speeds[speedIdx]));
                    }
                    break;
                // Camera mode shortcuts
                case 'c':
                case 'C':
                    transitionToMode(CameraModes.CHASE);
                    break;
                case 'b':
                case 'B':
                    transitionToMode(CameraModes.BIRDS_EYE);
                    break;
                case 's':
                case 'S':
                    transitionToMode(CameraModes.SIDE_VIEW);
                    break;
                case 'v':
                case 'V':
                    transitionToMode(CameraModes.CINEMATIC);
                    break;
                // Fullscreen toggle
                case 'f':
                case 'F':
                    toggleFullscreen();
                    break;
                // Help toggle
                case '?':
                    shortcutsHelp?.classList.toggle('hidden');
                    updateProgressWidgetForHelp();
                    break;
            }
        });
    }

    /**
     * Adjust chase cam pitch with up/down arrows
     * Also handles auto-switching between Chase and Bird's Eye
     */
    function adjustChasePitch(delta) {
        // If in Bird's Eye and pressing down (making pitch less negative/more horizontal)
        if ((currentCameraMode === CameraModes.BIRDS_EYE || targetCameraMode === CameraModes.BIRDS_EYE) && delta > 0) {
            // Switch to Chase mode with pitch just above the threshold
            chaseCamPitch = PITCH_BIRDS_EYE_THRESHOLD + PITCH_STEP;
            savePitchToStorage(chaseCamPitch);
            transitionToMode(CameraModes.CHASE);
            // transitionToMode already handles camera update when not playing
            return;
        }

        // Only adjust pitch in Chase mode (check both current and target)
        if (currentCameraMode !== CameraModes.CHASE && targetCameraMode !== CameraModes.CHASE) {
            // If pressing up in another mode, switch to chase first
            if (delta < 0) {
                transitionToMode(CameraModes.CHASE);
                // transitionToMode already handles camera update when not playing
            }
            return;
        }

        // Ensure we're in chase mode
        if (currentCameraMode !== CameraModes.CHASE) {
            currentCameraMode = CameraModes.CHASE;
            modeTransitionProgress = 1;
        }

        // Adjust pitch
        const newPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, chaseCamPitch + delta));

        // Check if we should switch to Bird's Eye
        if (newPitch <= PITCH_BIRDS_EYE_THRESHOLD) {
            transitionToMode(CameraModes.BIRDS_EYE);
            // transitionToMode already handles camera update when not playing
            return;
        }

        chaseCamPitch = newPitch;
        savePitchToStorage(chaseCamPitch);

        // Force camera update to apply the new pitch immediately
        // Temporarily disable free navigation to allow this update
        freeNavigationEnabled = false;
        updateCamera(0.016);
        // Re-enable free navigation if paused
        if (!isPlaying) {
            freeNavigationEnabled = true;
        }
    }

    /**
     * Toggle fullscreen mode
     */
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.warn('Fullscreen not available:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }

    /**
     * Toggle play/pause
     */
    function togglePlay() {
        isPlaying = !isPlaying;
        const playBtn = document.getElementById('btn-play');

        if (isPlaying) {
            playBtn.innerHTML = '⏸️';
            // Disable free navigation when animation starts
            freeNavigationEnabled = false;
            userOverrideActive = false;
            clearTimeout(userOverrideTimeout);
            lastTimestamp = performance.now();
            animate(lastTimestamp);
        } else {
            playBtn.innerHTML = '▶️';
            // Enable free navigation when animation stops
            freeNavigationEnabled = true;
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
        }
    }

    /**
     * Seek to specific position
     */
    function seekToPosition(newPosition) {
        progress = Math.max(0, Math.min(1, newPosition));

        // Cancel user override when seeking
        if (userOverrideActive) {
            userOverrideActive = false;
            clearTimeout(userOverrideTimeout);
        }
        returnProgress = 1;
        lastUserCameraState = null;

        // Complete any in-progress mode transition immediately
        if (modeTransitionProgress < 1) {
            modeTransitionProgress = 1;
            currentCameraMode = targetCameraMode;
            transitionStartState = null;
        }

        // Temporarily disable free navigation to update camera during seek
        freeNavigationEnabled = false;

        // Update camera immediately (use small deltaTime for cinematic mode)
        updateCamera(0.016); // ~60fps frame time

        // Re-enable free navigation if we're paused
        if (!isPlaying) {
            freeNavigationEnabled = true;
        }

        // Update UI
        updateProgress();
    }

    /**
     * Main animation loop - simple delta time, no fixed timestep
     */
    function animate(timestamp) {
        if (!isPlaying) return;

        // Calculate delta time in seconds
        const deltaTime = (timestamp - lastTimestamp) / 1000;
        lastTimestamp = timestamp;

        // Calculate progress increment based on route length and speed
        const duration = Math.max(CONFIG.minDuration, (totalDistance / 100) * CONFIG.baseDuration);
        const increment = deltaTime / duration * speedMultiplier;

        progress += increment;

        // Check for completion
        if (progress >= 1) {
            progress = 1;
            isPlaying = false;
            document.getElementById('btn-play').innerHTML = '▶️';
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
        }

        // Update camera and dot with delta time for smooth transitions
        updateCamera(deltaTime);

        // Update UI
        updateProgress();

        // Continue animation
        if (isPlaying) {
            animationId = requestAnimationFrame(animate);
        }
    }

    /**
     * Update camera position using FreeCamera API with mode support
     * Handles mode transitions and user override with smooth return
     */
    function updateCamera(deltaTime = 0) {
        // Dot position from turf.along() - constant speed along the path
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        // Direction point for camera bearing (slightly ahead)
        const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
        const directionPoint = getPointAlongRoute(directionDistance);

        if (!dotPoint || !directionPoint) return;

        // Calculate target camera state for the current/target mode
        const targetState = calculateCameraForMode(targetCameraMode, dotPoint, directionPoint, deltaTime);
        if (!targetState) return;

        let finalState;

        // Handle free navigation mode (when paused, user can navigate freely)
        // Only update dot and UI, don't control camera
        if (freeNavigationEnabled && !isPlaying) {
            updateDotAndUI(dotPoint);
            return;
        }

        // Handle user override with smooth return
        if (userOverrideActive) {
            // User is interacting - don't move the camera
            updateDotAndUI(dotPoint);
            return;
        }

        // Handle smooth return from user override
        if (returnProgress < 1 && lastUserCameraState) {
            returnProgress += deltaTime * 0.5; // ~2 second return
            returnProgress = Math.min(1, returnProgress);
            const t = easeOutCubic(returnProgress);
            finalState = lerpCameraState(lastUserCameraState, targetState, t);
        }
        // Handle mode transition
        else if (modeTransitionProgress < 1 && transitionStartState) {
            const transitionDuration = CameraModeConfig[targetCameraMode].transitionDuration / 1000;
            modeTransitionProgress += deltaTime / transitionDuration;
            modeTransitionProgress = Math.min(1, modeTransitionProgress);

            const t = easeOutCubic(modeTransitionProgress);
            finalState = lerpCameraState(transitionStartState, targetState, t);

            if (modeTransitionProgress >= 1) {
                currentCameraMode = targetCameraMode;
            }
        }
        // Normal guided mode
        else {
            finalState = targetState;
            currentCameraMode = targetCameraMode;
        }

        // Apply camera state
        applyCameraState(finalState, dotPoint);

        // Update dot and UI
        updateDotAndUI(dotPoint);
    }

    /**
     * Apply a camera state to the map
     */
    function applyCameraState(state, lookAtPoint) {
        try {
            const camera = map.getFreeCameraOptions();

            // Set camera position
            camera.position = mapboxgl.MercatorCoordinate.fromLngLat(
                [state.lng, state.lat],
                state.alt
            );

            // Look at the dot position
            if (lookAtPoint) {
                camera.lookAtPoint([lookAtPoint.lng, lookAtPoint.lat]);
            }

            // Apply camera settings
            map.setFreeCameraOptions(camera);
        } catch (e) {
            // Fallback to standard camera if FreeCamera fails
            map.easeTo({
                center: lookAtPoint ? [lookAtPoint.lng, lookAtPoint.lat] : [state.lng, state.lat],
                zoom: 14,
                pitch: Math.abs(state.pitch),
                bearing: state.bearing,
                duration: 0
            });
        }
    }

    /**
     * Update dot position and UI elements
     */
    function updateDotAndUI(dotPoint) {
        // Update current position marker
        map.getSource('current-position')?.setData({
            type: 'Point',
            coordinates: [dotPoint.lng, dotPoint.lat, dotPoint.alt]
        });

        // Update route gradient to show progress
        updateRouteGradient(progress);

        // Update elevation profile and stats
        if (elevationProfile) {
            const data = elevationProfile.setPosition(progress);

            // Update grade stat with color coding
            const gradeEl = document.getElementById('stat-grade');
            const gradeGroup = gradeEl?.closest('.stat-group');
            if (gradeEl) {
                const grade = data.grade || 0;
                gradeEl.textContent = grade.toFixed(1);

                // Update grade color class
                if (gradeGroup) {
                    gradeGroup.classList.remove('climbing', 'steep', 'descending');
                    if (grade > 8) {
                        gradeGroup.classList.add('steep');
                    } else if (grade > 3) {
                        gradeGroup.classList.add('climbing');
                    } else if (grade < -2) {
                        gradeGroup.classList.add('descending');
                    }
                }
            }

            // Update elevation climbed/remaining
            const elevClimbed = document.getElementById('stat-elev-climbed');
            const elevLeft = document.getElementById('stat-elev-left');
            if (elevClimbed && routeData) {
                // Calculate cumulative elevation gain up to current position
                const climbedSoFar = calculateElevationGainToPosition(progress);
                const totalGain = routeData.elevationGain || 0;
                const remaining = Math.max(0, totalGain - climbedSoFar);

                elevClimbed.textContent = Math.round(climbedSoFar);
                if (elevLeft) elevLeft.textContent = `${Math.round(remaining)} m to go`;
            }
        }

        // Check for Ventoux summit
        checkVentouxSummit(dotPoint);
    }

    /**
     * Calculate cumulative elevation gain up to a position (0-1)
     */
    function calculateElevationGainToPosition(position) {
        if (!routeData || !routeData.coordinates) return 0;

        const coords = routeData.coordinates;
        const targetIndex = Math.floor(position * (coords.length - 1));
        let totalGain = 0;

        for (let i = 1; i <= targetIndex && i < coords.length; i++) {
            const elevDiff = (coords[i][2] || 0) - (coords[i - 1][2] || 0);
            if (elevDiff > 0) {
                totalGain += elevDiff;
            }
        }

        return totalGain;
    }

    /**
     * Update route gradient to show progress
     * (Currently no-op since route is constant color)
     */
    function updateRouteGradient(progress) {
        // Route color is now constant - no gradient needed
    }

    /**
     * Update unified progress widget
     */
    function updateProgress() {
        const currentDistance = progress * totalDistance;
        const remainingDistance = totalDistance - currentDistance;
        const progressPercent = progress * 100;

        // Update scrubber position and progress overlay
        const scrubber = document.getElementById('scrubber-handle');
        const overlay = document.getElementById('progress-overlay');
        if (scrubber) {
            scrubber.style.left = `${progressPercent}%`;
        }
        if (overlay) {
            overlay.style.width = `${progressPercent}%`;
        }

        // Update distance stats
        const distDone = document.getElementById('stat-distance-done');
        const distLeft = document.getElementById('stat-distance-left');
        if (distDone) distDone.textContent = currentDistance.toFixed(1);
        if (distLeft) distLeft.textContent = `${remainingDistance.toFixed(1)} km left`;

        // Grade and elevation stats are updated in updateDotAndUI via elevationProfile
    }

    /**
     * Check if near Ventoux summit
     */
    function checkVentouxSummit(currentPoint) {
        const distance = turf.distance(
            turf.point([currentPoint.lng, currentPoint.lat]),
            turf.point([VENTOUX_SUMMIT.lng, VENTOUX_SUMMIT.lat]),
            { units: 'kilometers' }
        );

        const badge = document.getElementById('summit-badge');
        if (distance < VENTOUX_SUMMIT.radius && currentPoint.alt > 1800) {
            badge.classList.add('visible');
        } else {
            badge.classList.remove('visible');
        }
    }

    /**
     * Show loading overlay
     */
    function showLoading(message = 'Loading route...') {
        const overlay = document.getElementById('loading');
        overlay.querySelector('.loading-text').textContent = message;
        overlay.classList.remove('hidden');
    }

    /**
     * Hide loading overlay
     */
    function hideLoading() {
        const overlay = document.getElementById('loading');
        overlay.classList.add('hidden');
    }

    /**
     * Show error message
     */
    function showError(message) {
        const overlay = document.getElementById('loading');
        overlay.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                <div style="font-size: 18px; margin-bottom: 8px;">${message}</div>
                <a href="index.html" style="color: #E6B800;">← Back to Routes</a>
            </div>
        `;
    }

    /**
     * Initialize on page load
     */
    function init() {
        initMap();
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

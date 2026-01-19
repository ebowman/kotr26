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
        // Camera settings
        cameraAltitude: 300,           // Base altitude above terrain (meters)
        cameraOffset: 200,              // Offset behind current position (meters)
        lookAheadDistance: 50,          // How far ahead camera looks (meters) - small to keep dot centered

        // Animation timing
        baseDuration: 600,              // Base duration in seconds for 100km (10 min)
        minDuration: 180,               // Minimum duration (3 min)

        // Route visualization
        routeLineWidth: 4,
        routeLineColor: '#E6B800',
        trailColor: '#7B3F00',
        trailWidth: 6,

        // Speed multipliers
        speeds: {
            '0.25': 0.25,
            '0.5': 0.5,
            '1': 1,
            '2': 2,
            '4': 4
        }
    };

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
    let speedMultiplier = 1;
    let lastTimestamp = 0;

    // Previous position for bearing calculation
    let lastDotPoint = null;

    // Route geometry
    let routeLine = null;
    let cameraPath = null;
    let totalDistance = 0;

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
     * Get camera position offset from route point
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

        // Trail layer (what's been traveled)
        map.addLayer({
            id: 'route-trail',
            type: 'line',
            source: 'route',
            paint: {
                'line-color': CONFIG.trailColor,
                'line-width': CONFIG.trailWidth,
                'line-opacity': 0.8
            }
        });

        // Main route layer with gradient
        map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            paint: {
                'line-color': CONFIG.routeLineColor,
                'line-width': CONFIG.routeLineWidth,
                'line-opacity': 1,
                'line-gradient': [
                    'interpolate',
                    ['linear'],
                    ['line-progress'],
                    0, CONFIG.routeLineColor,
                    1, CONFIG.routeLineColor
                ]
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
        document.getElementById('stat-distance').textContent = routeData.distance.toFixed(1);
        document.getElementById('stat-elevation').textContent = routeData.elevationGain;

        document.getElementById('elev-min').textContent = `Min: ${routeData.minElevation}m`;
        document.getElementById('elev-max').textContent = `Max: ${routeData.maxElevation}m`;
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

        progressBar.addEventListener('click', (e) => {
            const rect = progressBar.getBoundingClientRect();
            const position = (e.clientX - rect.left) / rect.width;
            seekToPosition(position);
        });

        // Keyboard controls
        document.addEventListener('keydown', (e) => {
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
                case '1':
                case '2':
                case '3':
                case '4':
                    const speeds = ['0.5', '1', '2', '4'];
                    const speedIdx = parseInt(e.key) - 1;
                    if (speeds[speedIdx]) {
                        speedMultiplier = CONFIG.speeds[speeds[speedIdx]];
                        speedBtns.forEach(b => b.classList.toggle('active', b.dataset.speed === speeds[speedIdx]));
                    }
                    break;
            }
        });
    }

    /**
     * Toggle play/pause
     */
    function togglePlay() {
        isPlaying = !isPlaying;
        const playBtn = document.getElementById('btn-play');

        if (isPlaying) {
            playBtn.innerHTML = '⏸️';
            lastTimestamp = performance.now();
            animate(lastTimestamp);
        } else {
            playBtn.innerHTML = '▶️';
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

        // Update camera immediately
        updateCamera();

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

        // Update camera and dot
        updateCamera();

        // Update UI
        updateProgress();

        // Continue animation
        if (isPlaying) {
            animationId = requestAnimationFrame(animate);
        }
    }

    /**
     * Update camera position using FreeCamera API
     * No smoothing - camera and dot move together to prevent relative jitter
     */
    function updateCamera() {
        // Dot position from turf.along() - constant speed along the path
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        // Direction point for camera bearing (slightly ahead)
        const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
        const directionPoint = getPointAlongRoute(directionDistance);

        if (!dotPoint || !directionPoint) return;

        // Calculate camera altitude
        const cameraAltitude = CONFIG.cameraAltitude + (dotPoint.alt * 0.3);

        // Get camera position (behind and above the dot)
        const cameraPos = getCameraPosition(dotPoint, directionPoint, cameraAltitude);

        // Use FreeCamera API - no smoothing, direct positioning
        try {
            const camera = map.getFreeCameraOptions();

            // Set camera position directly
            camera.position = mapboxgl.MercatorCoordinate.fromLngLat(
                [cameraPos.lng, cameraPos.lat],
                cameraPos.alt
            );

            // Look at the dot position
            camera.lookAtPoint([dotPoint.lng, dotPoint.lat]);

            // Apply camera settings
            map.setFreeCameraOptions(camera);
        } catch (e) {
            // Fallback to standard camera if FreeCamera fails
            map.easeTo({
                center: [dotPoint.lng, dotPoint.lat],
                zoom: 14,
                pitch: 70,
                bearing: calculateBearing(dotPoint, directionPoint),
                duration: 0
            });
        }

        // Update current position marker - dotPoint is already on the route path
        map.getSource('current-position')?.setData({
            type: 'Point',
            coordinates: [dotPoint.lng, dotPoint.lat, dotPoint.alt]
        });

        // Update route gradient to show progress
        updateRouteGradient(progress);

        // Update elevation profile
        if (elevationProfile) {
            const data = elevationProfile.setPosition(progress);
            document.getElementById('elev-current').textContent = `Current: ${Math.round(data.elevation)}m`;
        }

        // Check for Ventoux summit
        checkVentouxSummit(dotPoint);
    }

    /**
     * Update route gradient to show progress
     */
    function updateRouteGradient(progress) {
        // Ensure progress values are strictly ascending
        const p = Math.max(0.001, Math.min(0.999, progress));
        const trailEnd = Math.max(0.0001, p - 0.01);

        try {
            // Update the line gradient to show traveled portion
            map.setPaintProperty('route-line', 'line-gradient', [
                'interpolate',
                ['linear'],
                ['line-progress'],
                0, CONFIG.trailColor,
                trailEnd, CONFIG.trailColor,
                p, CONFIG.routeLineColor,
                1, CONFIG.routeLineColor
            ]);
        } catch (e) {
            // Gradient not supported, fallback
            console.warn('Gradient update failed:', e.message);
        }
    }

    /**
     * Update progress UI elements
     */
    function updateProgress() {
        const currentDistance = progress * totalDistance;

        document.getElementById('progress-fill').style.width = `${progress * 100}%`;
        document.getElementById('progress-distance').textContent = `${currentDistance.toFixed(1)} km`;
        document.getElementById('progress-percent').textContent = `${Math.round(progress * 100)}%`;
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

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

    // Zoom level control (camera distance from rider)
    const ZOOM_MIN = 0.3;   // Closest zoom (30% of default distance)
    const ZOOM_MAX = 3.0;   // Farthest zoom (300% of default distance)
    const ZOOM_STEP = 0.15; // Per key/scroll increment
    const ZOOM_DEFAULT = 1.0;
    let zoomLevel = loadZoomFromStorage();

    // Side view direction control
    // 'auto' = automatically pick lower terrain side, 'left' = +90°, 'right' = -90°
    const SideViewModes = { AUTO: 'auto', LEFT: 'left', RIGHT: 'right' };
    let sideViewMode = SideViewModes.AUTO;

    // Camera stability detection - auto-fallback to bird's eye when chaotic
    const STABILITY_HISTORY_SIZE = 10;          // Number of frames to track
    const STABILITY_JITTER_THRESHOLD = 50;      // Max acceptable bearing change per frame (degrees)
    const STABILITY_ALTITUDE_THRESHOLD = 200;   // Max acceptable altitude change per frame (meters)
    const VISIBILITY_LOST_FRAMES = 15;          // Frames before considering rider "lost"
    let cameraHistory = [];                     // Recent camera states for jitter detection
    let framesWithRiderOutOfView = 0;           // Counter for visibility detection
    let stabilityFallbackActive = false;        // Whether we auto-switched to bird's eye
    let previousCameraMode = null;              // Mode to return to after stabilization

    // Scrubber drag state for Google Earth-style transitions
    let isScrubberDragging = false;
    let overviewTransitionProgress = 0; // 0 = normal view, 1 = full overview
    let overviewTargetState = null; // Cached overview camera state
    let shouldReturnFromOverview = false; // Whether to zoom back after drag
    let scrubStartPoint = null; // Position where scrubbing began
    let scrubBearing = 0; // Consistent bearing during scrub
    let scrubAnimationId = null; // Animation frame ID for scrub transitions

    // User override state
    let userOverrideActive = false;
    let userOverrideTimeout = null;
    let returnProgress = 1;
    let lastUserCameraState = null;
    let userIsInteracting = false; // True when user has mouse/touch down on map

    // Auto-hide UI state
    let autoHideTimeout = null;
    const AUTO_HIDE_DELAY = 3000; // ms before hiding UI during playback

    // Camera watchdog state - detects and fixes stuck/jittering camera
    const WATCHDOG_MAX_ALT_DIFF = 500;      // Alert if actual vs expected altitude differs by this much
    const WATCHDOG_STUCK_FRAMES = 30;       // Frames before considering camera "stuck"
    const WATCHDOG_JITTER_THRESHOLD = 100;  // m/frame altitude change threshold
    let watchdogStuckFrames = 0;
    let watchdogLastAppliedAlt = null;      // For debug API
    let watchdogAltitudeHistory = [];

    // Post-transition settling period - skip terrain collision to prevent jitter
    const SETTLING_DURATION = 60;        // frames to skip terrain collision after transition
    let settlingFramesRemaining = 0;     // countdown for settling period

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
     * Load zoom level from localStorage
     */
    function loadZoomFromStorage() {
        try {
            const stored = localStorage.getItem('kotr-flyover-zoom');
            if (stored !== null) {
                const zoom = parseFloat(stored);
                if (!isNaN(zoom) && zoom >= ZOOM_MIN && zoom <= ZOOM_MAX) {
                    return zoom;
                }
            }
        } catch (e) {
            // localStorage not available
        }
        return ZOOM_DEFAULT;
    }

    /**
     * Save zoom level to localStorage
     */
    function saveZoomToStorage(zoom) {
        try {
            localStorage.setItem('kotr-flyover-zoom', zoom.toString());
        } catch (e) {
            // localStorage not available
        }
    }

    /**
     * Adjust zoom level
     */
    function adjustZoom(delta) {
        const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel + delta));
        if (newZoom !== zoomLevel) {
            zoomLevel = newZoom;
            saveZoomToStorage(zoomLevel);
            updateZoomIndicator();

            // Force immediate camera update
            if (!isPlaying) {
                freeNavigationEnabled = false;
                updateCamera(0.016);
                freeNavigationEnabled = true;
            }
        }
    }

    /**
     * Update zoom indicator in UI
     */
    function updateZoomIndicator() {
        const indicator = document.getElementById('zoom-indicator');
        if (indicator) {
            const percentage = Math.round(zoomLevel * 100);
            indicator.textContent = `${percentage}%`;
            indicator.classList.add('flash');
            setTimeout(() => indicator.classList.remove('flash'), 300);
        }
    }

    /**
     * Linear interpolation
     */
    function lerp(start, end, t) {
        return start + (end - start) * t;
    }

    /**
     * Smooth a value by clamping change per frame
     * Returns the smoothed value, or current if no previous value exists
     */
    function smoothValue(current, previous, maxChange) {
        if (previous == null) return current;
        const delta = current - previous;
        if (Math.abs(delta) <= maxChange) return current;
        return previous + Math.sign(delta) * maxChange;
    }

    /**
     * Smooth bearing with wrap-around handling (0-360 degrees)
     * Returns the smoothed bearing, or current if no previous value exists
     */
    function smoothBearing(current, previous, maxChange) {
        if (previous == null) return current;
        let delta = current - previous;
        // Handle wrap-around (e.g., 350 to 10 should be +20, not -340)
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        if (Math.abs(delta) <= maxChange) return current;
        let smoothed = previous + Math.sign(delta) * maxChange;
        // Normalize to 0-360
        if (smoothed < 0) smoothed += 360;
        if (smoothed >= 360) smoothed -= 360;
        return smoothed;
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
     * Applies zoomLevel multiplier to all distance/height parameters
     */
    /**
     * Calculate camera state for a given mode
     * @param {string} mode - Camera mode
     * @param {object} dotPoint - Current rider position
     * @param {object} nextPoint - Look-ahead point for bearing
     * @param {number} deltaTime - Time since last frame
     * @param {boolean} skipSmoothing - Skip cache-based smoothing (use during lerp transitions)
     */
    function calculateCameraForMode(mode, dotPoint, nextPoint, deltaTime, skipSmoothing = false) {
        if (!dotPoint || !nextPoint) return null;

        const config = CameraModeConfig[mode];
        const forwardBearing = calculateBearing(dotPoint, nextPoint);

        // Apply zoom level to all camera distances
        const zoom = zoomLevel;

        let cameraLng, cameraLat, cameraAlt, cameraBearing, cameraPitch;

        switch (mode) {
            case CameraModes.CHASE: {
                // Chase cam: behind and above the dot
                // Calculate altitude based on desired pitch angle
                // tan(pitch) = altitude / horizontal_distance
                // So: altitude = horizontal_distance * tan(|pitch|)
                const offsetBehind = config.offsetBehind * zoom;
                const pitchRadians = Math.abs(chaseCamPitch) * Math.PI / 180;
                const calculatedAltitude = offsetBehind * Math.tan(pitchRadians);

                const behindBearing = (forwardBearing + 180) % 360;
                const offsetPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    offsetBehind / 1000,
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
                // Position directly above for maximum smoothness (no bearing-dependent offset)
                // Small fixed south offset avoids gimbal lock with lookAtPoint
                const offsetUp = config.offsetUp * zoom;
                const southOffset = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    0.03 * zoom, // Small fixed offset south (not bearing-dependent)
                    180, // Always south - no position jumps when bearing changes
                    { units: 'kilometers' }
                );
                cameraLng = southOffset.geometry.coordinates[0];
                cameraLat = southOffset.geometry.coordinates[1];
                cameraAlt = dotPoint.alt + offsetUp;
                cameraBearing = forwardBearing; // Will be heavily smoothed (0.08°/frame)
                cameraPitch = config.pitch;
                break;
            }

            case CameraModes.SIDE_VIEW: {
                // Side view: perpendicular to route direction
                // Intelligently chooses the lower terrain side (valley) or uses manual override
                // Uses hysteresis to prevent flip-flopping between sides
                const offsetSide = config.offsetSide * zoom;
                const offsetUp = config.offsetUp * zoom;

                // Calculate both potential side positions
                const leftBearing = (forwardBearing + 90) % 360;
                const rightBearing = (forwardBearing - 90 + 360) % 360;

                const leftPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    offsetSide / 1000,
                    leftBearing,
                    { units: 'kilometers' }
                );
                const rightPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    offsetSide / 1000,
                    rightBearing,
                    { units: 'kilometers' }
                );

                // Track current side with hysteresis (stored outside this function)
                if (!window._sideViewCurrentSide) {
                    window._sideViewCurrentSide = 'left';
                }
                // Track last side switch time for cooldown
                if (!window._sideViewLastSwitchTime) {
                    window._sideViewLastSwitchTime = 0;
                }

                let chosenSide = window._sideViewCurrentSide; // Start with current side
                let sideBearing = leftBearing;
                let offsetPoint = leftPoint;

                if (sideViewMode === SideViewModes.LEFT) {
                    // Force left side (+90°)
                    chosenSide = 'left';
                } else if (sideViewMode === SideViewModes.RIGHT) {
                    // Force right side (-90°)
                    chosenSide = 'right';
                } else {
                    // Auto mode: query terrain on both sides and pick the lower one
                    // Only switch sides if the other side is significantly lower (hysteresis)
                    // AND stays better for at least LOOK_AHEAD_DISTANCE (prevents flip-flop on hairpins)
                    // AND enough time has passed since last switch (cooldown)
                    const SIDE_SWITCH_THRESHOLD = 200; // meters - must be this much lower to switch (increased for stability)
                    const LOOK_AHEAD_DISTANCE = 500; // meters - check terrain this far ahead (increased)
                    const LOOK_AHEAD_SAMPLES = 5; // number of points to check ahead (increased)
                    const SIDE_SWITCH_COOLDOWN = 3000; // ms - minimum time between side switches

                    try {
                        const leftTerrain = map.queryTerrainElevation(leftPoint.geometry.coordinates);
                        const rightTerrain = map.queryTerrainElevation(rightPoint.geometry.coordinates);
                        const now = performance.now();
                        const timeSinceLastSwitch = now - window._sideViewLastSwitchTime;

                        if (leftTerrain !== null && rightTerrain !== null) {
                            const currentSide = window._sideViewCurrentSide;
                            let shouldSwitch = false;
                            let newSide = currentSide;

                            // Only consider switching if cooldown has passed
                            if (timeSinceLastSwitch >= SIDE_SWITCH_COOLDOWN) {
                                // Check if we should consider switching
                                if (currentSide === 'left' && rightTerrain < leftTerrain - SIDE_SWITCH_THRESHOLD) {
                                    newSide = 'right';
                                    shouldSwitch = true;
                                } else if (currentSide === 'right' && leftTerrain < rightTerrain - SIDE_SWITCH_THRESHOLD) {
                                    newSide = 'left';
                                    shouldSwitch = true;
                                }
                            }

                            // If considering a switch, look ahead to see if it stays better
                            if (shouldSwitch && routeLine) {
                                const currentDistance = progress * totalDistance;
                                let switchStaysGood = true;

                                for (let i = 1; i <= LOOK_AHEAD_SAMPLES; i++) {
                                    const aheadDist = currentDistance + (LOOK_AHEAD_DISTANCE / 1000) * (i / LOOK_AHEAD_SAMPLES);
                                    if (aheadDist > totalDistance) break;

                                    const aheadPoint = getPointAlongRoute(aheadDist);
                                    if (!aheadPoint) continue;

                                    // Get bearing at ahead point
                                    const aheadNextDist = Math.min(aheadDist + 0.05, totalDistance);
                                    const aheadNextPoint = getPointAlongRoute(aheadNextDist);
                                    if (!aheadNextPoint) continue;

                                    const aheadBearing = calculateBearing(aheadPoint, aheadNextPoint);
                                    const aheadLeftBearing = (aheadBearing + 90) % 360;
                                    const aheadRightBearing = (aheadBearing - 90 + 360) % 360;

                                    // Calculate side points at ahead position
                                    const aheadLeftPoint = turf.destination(
                                        turf.point([aheadPoint.lng, aheadPoint.lat]),
                                        offsetAside / 1000,
                                        aheadLeftBearing,
                                        { units: 'kilometers' }
                                    );
                                    const aheadRightPoint = turf.destination(
                                        turf.point([aheadPoint.lng, aheadPoint.lat]),
                                        offsetAside / 1000,
                                        aheadRightBearing,
                                        { units: 'kilometers' }
                                    );

                                    const aheadLeftTerrain = map.queryTerrainElevation(aheadLeftPoint.geometry.coordinates);
                                    const aheadRightTerrain = map.queryTerrainElevation(aheadRightPoint.geometry.coordinates);

                                    if (aheadLeftTerrain !== null && aheadRightTerrain !== null) {
                                        // Check if the new side is still better ahead
                                        if (newSide === 'right' && aheadLeftTerrain < aheadRightTerrain - SIDE_SWITCH_THRESHOLD / 2) {
                                            // Left would be better ahead - don't switch, we'd flip back
                                            switchStaysGood = false;
                                            break;
                                        } else if (newSide === 'left' && aheadRightTerrain < aheadLeftTerrain - SIDE_SWITCH_THRESHOLD / 2) {
                                            // Right would be better ahead - don't switch, we'd flip back
                                            switchStaysGood = false;
                                            break;
                                        }
                                    }
                                }

                                // Only switch if it stays good for the look-ahead distance
                                if (switchStaysGood) {
                                    chosenSide = newSide;
                                }
                            }
                            // Otherwise stay on current side
                        }
                    } catch (e) {
                        // Terrain query failed, stay on current side
                    }
                }

                // Check if side changed - record the switch time for cooldown
                const previousSide = window._sideViewCurrentSide;
                if (chosenSide !== previousSide) {
                    // Side switch - record time for cooldown
                    // NOTE: We do NOT reset smoothing caches anymore - let the lerping handle
                    // the smooth transition to the new side position. This prevents jarring jumps.
                    window._sideViewLastSwitchTime = performance.now();
                }

                // Remember chosen side for next frame
                window._sideViewCurrentSide = chosenSide;

                // Apply chosen side
                if (chosenSide === 'right') {
                    sideBearing = rightBearing;
                    offsetPoint = rightPoint;
                }

                cameraLng = offsetPoint.geometry.coordinates[0];
                cameraLat = offsetPoint.geometry.coordinates[1];
                cameraAlt = dotPoint.alt + offsetUp;
                // Look at the dot from the side
                cameraBearing = (sideBearing + 180) % 360;
                cameraPitch = config.pitch;
                break;
            }

            case CameraModes.CINEMATIC: {
                // Cinematic: orbiting around the dot
                const orbitRadius = config.orbitRadius * zoom;
                const heightMin = config.heightMin * zoom;
                const heightMax = config.heightMax * zoom;

                if (deltaTime) {
                    cinematicAngle += config.orbitSpeed * deltaTime;
                }
                const orbitBearing = (cinematicAngle * 180 / Math.PI) % 360;
                const offsetPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    orbitRadius / 1000,
                    orbitBearing,
                    { units: 'kilometers' }
                );
                cameraLng = offsetPoint.geometry.coordinates[0];
                cameraLat = offsetPoint.geometry.coordinates[1];

                // Vary height sinusoidally above the rider
                // Terrain collision and altitude smoothing are applied after all modes
                const heightT = (Math.sin(cinematicAngle * 0.5) + 1) / 2;
                cameraAlt = dotPoint.alt + lerp(heightMin, heightMax, heightT);

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

        // Terrain collision detection: ensure camera is above terrain at its position
        // AND above the rider - this prevents the camera from going below the rider
        // when orbiting over valleys on steep mountainsides
        // Use higher clearance to avoid camera looking into cliff faces on steep terrain
        const minTerrainClearance = 100; // meters above terrain at camera position
        const minRiderClearance = 100;   // meters above rider - camera should never be below rider
        let terrainElevation = null;
        let terrainAdjusted = false;
        let originalCameraAlt = cameraAlt;

        // Initialize terrain cache if needed
        if (!window._terrainCache) {
            window._terrainCache = {
                lastElevation: null,
                lastCameraAlt: null,
                lastPosition: null
            };
        }

        // During transitions (skipSmoothing=true) or settling period, use simplified collision
        // Only ensure camera is above the rider - skip terrain queries which cause jitter
        // on steep terrain where the terrain elevation changes rapidly
        const useSimplifiedCollision = skipSmoothing || settlingFramesRemaining > 0;
        if (settlingFramesRemaining > 0) {
            settlingFramesRemaining--;
        }

        if (useSimplifiedCollision) {
            const minFromRider = dotPoint.alt + minRiderClearance;
            if (cameraAlt < minFromRider) {
                cameraAlt = minFromRider;
                terrainAdjusted = true;
            }
        } else {
            // Normal mode: full terrain collision detection
            try {
                terrainElevation = map.queryTerrainElevation([cameraLng, cameraLat]);

                if (terrainElevation !== null && terrainElevation !== undefined) {
                    // Valid terrain data - use it and cache it
                    window._terrainCache.lastElevation = terrainElevation;
                    window._terrainCache.lastPosition = { lng: cameraLng, lat: cameraLat };
                } else if (window._terrainCache.lastElevation !== null) {
                    // Terrain query returned null - use cached value
                    terrainElevation = window._terrainCache.lastElevation;
                }
            } catch (e) {
                // Terrain query not available, try to use cached value
                if (window._terrainCache.lastElevation !== null) {
                    terrainElevation = window._terrainCache.lastElevation;
                }
            }

            // Calculate minimum altitude from two constraints:
            // 1. Must be above terrain at camera position
            // 2. Must be above rider (prevents camera going into valley below rider on steep slopes)
            // 3. On steep uphill terrain, add extra clearance proportional to elevation difference
            //    to help camera see OVER cliff faces between camera and rider
            let dynamicClearance = minTerrainClearance;
            if (terrainElevation !== null && terrainElevation > dotPoint.alt) {
                // Camera terrain is higher than rider - add extra clearance to see over slope
                // Add 50% of the elevation difference as extra clearance
                const elevationDiff = terrainElevation - dotPoint.alt;
                dynamicClearance = minTerrainClearance + elevationDiff * 0.5;
            }
            const minFromTerrain = terrainElevation !== null ? terrainElevation + dynamicClearance : 0;
            const minFromRider = dotPoint.alt + minRiderClearance;
            const minAltitude = Math.max(minFromTerrain, minFromRider);

            if (cameraAlt < minAltitude) {
                cameraAlt = minAltitude;
                terrainAdjusted = true;
            }
        }

        // Skip smoothing during lerp transitions or settling period
        // Lerp transitions provide their own smoothing; cache-based smoothing fights them
        if (!useSimplifiedCollision) {
            const isBirdsEye = mode === CameraModes.BIRDS_EYE;

            // Altitude smoothing - applied AFTER terrain collision to prevent jarring jumps
            // Bird's Eye uses lower limit for ultra-smooth flight
            const maxAltChange = isBirdsEye ? 8 : 30;
            cameraAlt = smoothValue(cameraAlt, window._terrainCache.lastCameraAlt, maxAltChange);
            window._terrainCache.lastCameraAlt = cameraAlt;

            // Position smoothing - prevent camera from jumping around on hairpin turns
            const maxPosChange = isBirdsEye ? 5 : 20; // meters
            if (window._terrainCache.lastLng != null && window._terrainCache.lastLat != null) {
                const cosLat = Math.cos(cameraLat * Math.PI / 180);
                const dLng = (cameraLng - window._terrainCache.lastLng) * 111000 * cosLat;
                const dLat = (cameraLat - window._terrainCache.lastLat) * 111000;
                const posDist = Math.sqrt(dLng * dLng + dLat * dLat);
                if (posDist > maxPosChange) {
                    const scale = maxPosChange / posDist;
                    cameraLng = window._terrainCache.lastLng + (cameraLng - window._terrainCache.lastLng) * scale;
                    cameraLat = window._terrainCache.lastLat + (cameraLat - window._terrainCache.lastLat) * scale;
                }
            }
            window._terrainCache.lastLng = cameraLng;
            window._terrainCache.lastLat = cameraLat;

            // Bearing smoothing - prevent jarring camera swings on hairpin turns
            // Bird's Eye: 0.08 deg/frame (~5 deg/sec), others: 4 deg/frame
            const maxBearingChange = isBirdsEye ? 0.08 : 4;
            cameraBearing = smoothBearing(cameraBearing, window._terrainCache.lastBearing, maxBearingChange);
            window._terrainCache.lastBearing = cameraBearing;

            // Pitch smoothing - prevent jarring pitch changes on terrain transitions
            // Bird's Eye: 0.1 deg/frame, others: 2 deg/frame
            const maxPitchChange = isBirdsEye ? 0.1 : 2;
            cameraPitch = smoothValue(cameraPitch, window._terrainCache.lastPitch, maxPitchChange);
            window._terrainCache.lastPitch = cameraPitch;
        }

        // Debug logging for camera terrain issues with jitter detection
        if (window.FLYOVER_DEBUG) {
            // Calculate deltas from previous frame
            let bearingDelta = 0;
            let altDelta = 0;
            let posDelta = 0;
            if (window._lastCameraState) {
                const last = window._lastCameraState;
                bearingDelta = cameraBearing - last.bearing;
                // Handle bearing wrap-around
                if (bearingDelta > 180) bearingDelta -= 360;
                if (bearingDelta < -180) bearingDelta += 360;
                altDelta = cameraAlt - last.alt;
                // Position delta in meters (approximate)
                const dLng = (cameraLng - last.lng) * 111000 * Math.cos(cameraLat * Math.PI / 180);
                const dLat = (cameraLat - last.lat) * 111000;
                posDelta = Math.sqrt(dLng * dLng + dLat * dLat);
            }
            window._lastCameraState = { lng: cameraLng, lat: cameraLat, alt: cameraAlt, bearing: cameraBearing };

            // Flag significant jitter
            const isJittery = Math.abs(bearingDelta) > 10 || Math.abs(altDelta) > 50 || posDelta > 100;

            const debugInfo = {
                mode: mode,
                dotAlt: dotPoint.alt.toFixed(1),
                cameraPos: { lng: cameraLng.toFixed(5), lat: cameraLat.toFixed(5) },
                terrainAtCamera: terrainElevation !== null ? terrainElevation.toFixed(1) : 'null',
                originalCameraAlt: originalCameraAlt.toFixed(1),
                finalCameraAlt: cameraAlt.toFixed(1),
                terrainAdjusted: terrainAdjusted,
                clearance: terrainElevation !== null ? (cameraAlt - terrainElevation).toFixed(1) : 'n/a',
                bearing: cameraBearing.toFixed(1),
                pitch: cameraPitch.toFixed(1),
                delta: {
                    bearing: bearingDelta.toFixed(1),
                    alt: altDelta.toFixed(1),
                    pos: posDelta.toFixed(1)
                },
                JITTER: isJittery
            };

            // Only log if jittery or every 30th frame to reduce noise
            if (isJittery) {
                console.warn('[CAMERA JITTER]', JSON.stringify(debugInfo));
            } else if (!window._cameraLogCount) {
                window._cameraLogCount = 0;
            }
            window._cameraLogCount++;
            if (window._cameraLogCount % 30 === 0) {
                console.log('[CAMERA]', JSON.stringify(debugInfo));
            }
        }

        return createCameraState(cameraLng, cameraLat, cameraAlt, cameraBearing, cameraPitch);
    }

    /**
     * Check if camera is experiencing chaotic jitter
     * Returns true if the camera should fall back to a stable mode
     */
    function detectCameraInstability(currentState) {
        if (!currentState || cameraHistory.length < 2) return false;

        // Don't check stability if we're already in bird's eye (the stable fallback)
        if (currentCameraMode === CameraModes.BIRDS_EYE) return false;

        // Calculate bearing change from last frame
        const lastState = cameraHistory[cameraHistory.length - 1];
        if (!lastState) return false;

        // Bearing difference (handle wrap-around)
        let bearingDiff = Math.abs(currentState.bearing - lastState.bearing);
        if (bearingDiff > 180) bearingDiff = 360 - bearingDiff;

        // Altitude difference
        const altDiff = Math.abs(currentState.alt - lastState.alt);

        // Check for extreme single-frame changes
        if (bearingDiff > STABILITY_JITTER_THRESHOLD || altDiff > STABILITY_ALTITUDE_THRESHOLD) {
            return true;
        }

        // Check for sustained jitter over multiple frames
        if (cameraHistory.length >= STABILITY_HISTORY_SIZE) {
            let totalBearingChange = 0;
            let directionReversals = 0;
            let lastBearingDelta = 0;

            for (let i = 1; i < cameraHistory.length; i++) {
                let bDiff = cameraHistory[i].bearing - cameraHistory[i - 1].bearing;
                // Normalize to -180 to 180
                if (bDiff > 180) bDiff -= 360;
                if (bDiff < -180) bDiff += 360;

                totalBearingChange += Math.abs(bDiff);

                // Count direction reversals (sign changes)
                if (lastBearingDelta !== 0 && Math.sign(bDiff) !== Math.sign(lastBearingDelta)) {
                    directionReversals++;
                }
                lastBearingDelta = bDiff;
            }

            // High total change with many reversals = jitter
            const avgBearingChange = totalBearingChange / cameraHistory.length;
            if (avgBearingChange > 15 && directionReversals >= STABILITY_HISTORY_SIZE / 2) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if the rider/dot is visible in the viewport
     * Returns true if rider is visible
     */
    function isRiderVisible(dotPoint) {
        if (!dotPoint || !map) return true; // Assume visible if we can't check

        try {
            // Project the rider's position to screen coordinates
            const screenPos = map.project([dotPoint.lng, dotPoint.lat]);
            const canvas = map.getCanvas();
            const width = canvas.width;
            const height = canvas.height;

            // Check if within viewport (with some margin)
            const margin = 50; // pixels
            const visible = screenPos.x >= -margin &&
                           screenPos.x <= width + margin &&
                           screenPos.y >= -margin &&
                           screenPos.y <= height + margin;

            return visible;
        } catch (e) {
            return true; // Assume visible on error
        }
    }

    /**
     * Update camera history for stability tracking
     */
    function updateCameraHistory(state) {
        if (!state) return;

        cameraHistory.push({
            lng: state.lng,
            lat: state.lat,
            alt: state.alt,
            bearing: state.bearing,
            pitch: state.pitch,
            timestamp: performance.now()
        });

        // Keep only recent history
        while (cameraHistory.length > STABILITY_HISTORY_SIZE) {
            cameraHistory.shift();
        }
    }

    /**
     * Handle stability fallback - DISABLED
     * Previously switched to bird's eye when camera was chaotic, but now we rely on
     * proper terrain collision detection instead of this workaround.
     */
    function handleStabilityFallback(originalState, dotPoint, nextPoint, deltaTime) {
        // Stability fallback disabled - terrain collision detection handles camera placement
        return originalState;
    }

    /**
     * Reset stability fallback (called when user manually changes camera mode)
     */
    function resetStabilityFallback() {
        stabilityFallbackActive = false;
        previousCameraMode = null;
        framesWithRiderOutOfView = 0;
        cameraHistory = [];
    }

    /**
     * Camera watchdog - detects and fixes stuck/jittering camera
     *
     * The smoothing cache in _terrainCache can desync during lerp transitions.
     * This watchdog detects altitude drift and jitter, resetting the cache as needed.
     *
     * @param {object} appliedState - The actual camera state that was applied
     * @param {boolean} isTransitioning - Whether we're in a lerp transition
     * @returns {boolean} true if watchdog triggered a reset
     */
    function cameraWatchdog(appliedState, isTransitioning) {
        if (!appliedState || !window._terrainCache) return false;

        const appliedAlt = appliedState.alt;

        // Track altitude history for jitter detection
        watchdogAltitudeHistory.push(appliedAlt);
        if (watchdogAltitudeHistory.length > 10) {
            watchdogAltitudeHistory.shift();
        }

        // During transitions, sync the cache to actual applied position
        // This prevents the cache from drifting during lerp interpolation
        if (isTransitioning) {
            window._terrainCache.lastCameraAlt = appliedAlt;
            window._terrainCache.lastLng = appliedState.lng;
            window._terrainCache.lastLat = appliedState.lat;
            window._terrainCache.lastBearing = appliedState.bearing;
            window._terrainCache.lastPitch = appliedState.pitch;
            watchdogStuckFrames = 0;
            return false;
        }

        // Check for jitter - rapid altitude oscillations
        if (watchdogAltitudeHistory.length >= 4) {
            let oscillations = 0;
            let lastDelta = 0;
            for (let i = 1; i < watchdogAltitudeHistory.length; i++) {
                const delta = watchdogAltitudeHistory[i] - watchdogAltitudeHistory[i-1];
                if (Math.abs(delta) > WATCHDOG_JITTER_THRESHOLD) {
                    if (lastDelta !== 0 && Math.sign(delta) !== Math.sign(lastDelta)) {
                        oscillations++;
                    }
                }
                lastDelta = delta;
            }

            // Multiple oscillations = jitter, reset everything
            if (oscillations >= 2) {
                console.warn('[WATCHDOG] Jitter detected, resetting camera caches');
                resetCameraCaches();
                watchdogAltitudeHistory = [];
                return true;
            }
        }

        // Check for stuck camera - cache says one thing but reality is different
        const cachedAlt = window._terrainCache.lastCameraAlt;
        if (cachedAlt !== null && Math.abs(appliedAlt - cachedAlt) > WATCHDOG_MAX_ALT_DIFF) {
            watchdogStuckFrames++;

            if (watchdogStuckFrames >= WATCHDOG_STUCK_FRAMES) {
                console.warn('[WATCHDOG] Camera stuck detected (applied:', appliedAlt.toFixed(0),
                           ', cached:', cachedAlt.toFixed(0), '), resetting');
                resetCameraCaches();
                watchdogStuckFrames = 0;
                return true;
            }
        } else {
            watchdogStuckFrames = 0;
        }

        // Track what we actually applied
        watchdogLastAppliedAlt = appliedAlt;

        return false;
    }

    /**
     * Reset smoothing-related cache fields (altitude, bearing, pitch)
     * Used when transitioning or seeking to prevent false jitter detection
     */
    function resetSmoothingCache() {
        window._lastCameraState = null;
        window._cinematicState = null;
        if (window._terrainCache) {
            window._terrainCache.lastCameraAlt = null;
            window._terrainCache.lastBearing = null;
            window._terrainCache.lastPitch = null;
        }
    }

    /**
     * Reset all camera caches including position and terrain data
     * Use when camera gets stuck or after major transitions
     */
    function resetCameraCaches() {
        resetSmoothingCache();
        if (window._terrainCache) {
            window._terrainCache.lastLng = null;
            window._terrainCache.lastLat = null;
            window._terrainCache.lastElevation = null;
        }
        cameraHistory = [];
        watchdogAltitudeHistory = [];
    }

    // Flag for free navigation mode when animation is paused
    let freeNavigationEnabled = false;

    /**
     * Transition to a new camera mode
     */
    function transitionToMode(newMode) {
        if (newMode === currentCameraMode && modeTransitionProgress >= 1) return;

        // Reset smoothing state to prevent false jitter detection from mode transitions
        resetSmoothingCache();

        // Reset stability fallback when user manually changes mode
        // This allows them to try other modes after an auto-fallback
        resetStabilityFallback();

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
        updateCameraModeIndicator();
    }

    /**
     * Update the camera mode indicator text
     * Shows side view direction when in side view mode
     */
    function updateCameraModeIndicator() {
        const indicator = document.getElementById('camera-mode-indicator');
        const label = indicator?.querySelector('.mode-label');
        if (label) {
            // Use targetCameraMode so indicator updates immediately when user changes mode
            const displayMode = targetCameraMode || currentCameraMode;
            let modeName = CameraModeNames[displayMode] || displayMode;

            // Add side view direction indicator
            if (displayMode === CameraModes.SIDE_VIEW) {
                const directionLabel = sideViewMode === SideViewModes.AUTO ? 'Auto' :
                                       sideViewMode === SideViewModes.LEFT ? 'Left' : 'Right';
                modeName = `Side View (${directionLabel})`;
            }

            label.textContent = modeName;
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
        updateCameraModeIndicator();
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

            // Initialize stats at position 0
            initializeStats();

            // Hide loading overlay
            hideLoading();

            // Setup controls
            setupControls();

            // Setup climb analysis panel
            setupClimbAnalysis();

            // Handle URL parameters for position and mode (for debugging)
            applyUrlParameters(params);

        } catch (error) {
            console.error('Failed to load route:', error);
            showError(`Failed to load route: ${error.message}`);
        }
    }

    /**
     * Apply URL parameters for debugging (position, mode, debug)
     * Supported parameters:
     *   pos=0.6      - Position as fraction (0-1)
     *   km=78.5      - Position in kilometers
     *   mode=chase   - Camera mode (chase, birds_eye, side_view, cinematic)
     *   debug=1      - Enable debug logging
     *   play=1       - Auto-start playback
     */
    function applyUrlParameters(params) {
        // Enable debug mode if requested
        if (params.get('debug') === '1') {
            window.FLYOVER_DEBUG = true;
            console.log('Debug mode enabled via URL parameter');
        }

        // Set position from km parameter
        const kmParam = params.get('km');
        if (kmParam !== null) {
            const km = parseFloat(kmParam);
            if (!isNaN(km) && km >= 0 && km <= totalDistance) {
                progress = km / totalDistance;
                console.log(`Position set to ${km.toFixed(2)} km (${(progress * 100).toFixed(1)}%) via URL parameter`);
            }
        }

        // Set position from pos parameter (overrides km if both specified)
        const posParam = params.get('pos');
        if (posParam !== null) {
            const pos = parseFloat(posParam);
            if (!isNaN(pos) && pos >= 0 && pos <= 1) {
                progress = pos;
                console.log(`Position set to ${(progress * 100).toFixed(1)}% (${(progress * totalDistance).toFixed(2)} km) via URL parameter`);
            }
        }

        // Set camera mode
        const modeParam = params.get('mode');
        if (modeParam !== null) {
            const modes = {
                'chase': CameraModes.CHASE,
                'birds_eye': CameraModes.BIRDS_EYE,
                'birdseye': CameraModes.BIRDS_EYE,
                'side_view': CameraModes.SIDE_VIEW,
                'sideview': CameraModes.SIDE_VIEW,
                'side': CameraModes.SIDE_VIEW,
                'cinematic': CameraModes.CINEMATIC
            };
            const targetMode = modes[modeParam.toLowerCase()];
            if (targetMode) {
                // Directly set mode without transition for instant positioning
                currentCameraMode = targetMode;
                targetCameraMode = targetMode;
                modeTransitionProgress = 1;
                updateCameraModeUI(targetMode);
                console.log(`Camera mode set to ${modeParam} via URL parameter`);
            }
        }

        // Update camera to reflect new position/mode
        if (posParam !== null || kmParam !== null || modeParam !== null) {
            // Small delay to ensure map is ready
            setTimeout(() => {
                updateCamera(0);
                updateProgress();
            }, 100);
        }

        // Auto-start playback if requested
        if (params.get('play') === '1') {
            setTimeout(() => {
                if (!isPlaying) togglePlayPause();
            }, 500);
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

        // Load rider profile if available and apply to elevation profile
        if (typeof RiderProfile !== 'undefined') {
            RiderProfile.load();
            const profile = RiderProfile.get();
            if (profile.isConfigured) {
                elevationProfile.setRiderProfile(profile.weight, profile.ftp);
            }
        }
    }

    /**
     * Setup effort zone toggle for elevation profile
     */
    function setupEffortToggle() {
        const toggle = document.getElementById('effort-toggle');
        const toggleContainer = document.getElementById('color-mode-toggle');
        const legend = document.getElementById('effort-legend');

        if (!toggle || !toggleContainer || !elevationProfile) return;

        // Check if rider profile is configured
        const updateToggleState = () => {
            if (typeof RiderProfile !== 'undefined') {
                RiderProfile.load();
                const profile = RiderProfile.get();
                if (profile.isConfigured) {
                    toggleContainer.classList.remove('disabled');
                    toggleContainer.title = 'Toggle effort zone coloring';
                    elevationProfile.setRiderProfile(profile.weight, profile.ftp);
                } else {
                    toggleContainer.classList.add('disabled');
                    toggleContainer.title = 'Set rider profile to enable';
                    // Switch back to grade mode if profile is cleared
                    if (elevationProfile.getColorMode() === ElevationProfile.COLOR_MODES.EFFORT) {
                        elevationProfile.setColorMode(ElevationProfile.COLOR_MODES.GRADE);
                        toggle.classList.remove('active');
                        legend.classList.remove('visible');
                    }
                }
            }
        };

        // Initial check
        updateToggleState();

        // Listen for profile changes
        if (typeof RiderProfile !== 'undefined') {
            RiderProfile.setOnChange(() => {
                updateToggleState();
                // Refresh the elevation profile render
                if (elevationProfile.getColorMode() === ElevationProfile.COLOR_MODES.EFFORT) {
                    elevationProfile.render();
                }
            });
        }

        // Toggle click handler
        toggle.addEventListener('click', () => {
            if (toggleContainer.classList.contains('disabled')) return;

            const isEffortMode = toggle.classList.toggle('active');
            const mode = isEffortMode ?
                ElevationProfile.COLOR_MODES.EFFORT :
                ElevationProfile.COLOR_MODES.GRADE;

            elevationProfile.setColorMode(mode);
            legend.classList.toggle('visible', isEffortMode);
        });
    }

    // Climb analysis state
    let detectedClimbs = [];
    let activeClimbIndex = -1;
    let selectedClimbIndex = -1;

    /**
     * Setup climb markers overlay on elevation profile
     */
    function setupClimbAnalysis() {
        if (!routeData || typeof PowerCalculator === 'undefined') {
            return;
        }

        const markersContainer = document.getElementById('climb-markers');
        const popup = document.getElementById('climb-popup');
        const popupClose = document.getElementById('climb-popup-close');

        if (!markersContainer || !popup) {
            return;
        }

        // Detect climbs using PowerCalculator
        detectedClimbs = PowerCalculator.detectClimbs(routeData);

        if (detectedClimbs.length === 0) {
            return;
        }

        // Use module-level totalDistance (calculated during route load)
        // or fall back to routeData.distance
        const climbTotalDistance = totalDistance || routeData.distance || 0;

        if (!climbTotalDistance) return;

        // Create climb markers
        detectedClimbs.forEach((climb, index) => {
            const marker = document.createElement('div');
            marker.className = 'climb-marker';
            marker.dataset.climbIndex = index;

            // Position marker based on start/end distance
            const leftPercent = (climb.startDistance / climbTotalDistance) * 100;
            const widthPercent = ((climb.endDistance - climb.startDistance) / climbTotalDistance) * 100;

            marker.style.left = `${leftPercent}%`;
            marker.style.width = `${Math.max(widthPercent, 0.5)}%`; // Min width for visibility

            // Set difficulty class based on avg grade
            if (climb.avgGrade < 5) {
                marker.classList.add('easy');
            } else if (climb.avgGrade < 8) {
                marker.classList.add('moderate');
            } else {
                marker.classList.add('hard');
            }

            // Hover handlers to show/hide popup
            marker.addEventListener('mouseenter', () => {
                showClimbPopup(climb, index, marker);
            });

            marker.addEventListener('mouseleave', (e) => {
                // Don't hide if moving into the popup
                const relatedTarget = e.relatedTarget;
                if (relatedTarget && (relatedTarget.closest('.climb-popup') || relatedTarget.closest('.climb-marker'))) {
                    return;
                }
                hideClimbPopup();
            });

            markersContainer.appendChild(marker);
        });

        // Allow popup to stay visible when hovering over it
        popup.addEventListener('mouseenter', () => {
            // Keep popup visible
        });

        popup.addEventListener('mouseleave', (e) => {
            // Hide when leaving popup (unless going back to marker)
            const relatedTarget = e.relatedTarget;
            if (relatedTarget && relatedTarget.closest('.climb-marker')) {
                return;
            }
            hideClimbPopup();
        });

        // Close popup handler (for manual close)
        popupClose.addEventListener('click', () => {
            hideClimbPopup();
        });

        // Update on profile change
        if (typeof RiderProfile !== 'undefined') {
            RiderProfile.setOnChange(() => {
                // If popup is visible, refresh it
                if (selectedClimbIndex >= 0 && popup.classList.contains('visible')) {
                    const marker = markersContainer.querySelector(`[data-climb-index="${selectedClimbIndex}"]`);
                    if (marker) {
                        showClimbPopup(detectedClimbs[selectedClimbIndex], selectedClimbIndex, marker);
                    }
                }
            });
        }
    }

    /**
     * Format time in minutes to a readable string (e.g., "46min" or "1h 12min")
     */
    function formatClimbTime(minutes) {
        if (minutes < 60) {
            return `${Math.round(minutes)}min`;
        }
        const hours = Math.floor(minutes / 60);
        const mins = Math.round(minutes % 60);
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }

    /**
     * Power-duration model: max sustainable %FTP for a given duration
     * Based on standard cycling physiology
     */
    function maxSustainableFtpPercent(durationMinutes) {
        if (durationMinutes <= 5) return 1.20;      // VO2max efforts
        if (durationMinutes <= 20) return 1.10;     // Threshold+
        if (durationMinutes <= 60) return 1.00;     // FTP definition
        if (durationMinutes <= 120) return 0.90;    // Sub-threshold
        if (durationMinutes <= 180) return 0.85;    // Tempo
        if (durationMinutes <= 240) return 0.80;    // Sweet spot
        return 0.75;                                 // Endurance
    }

    /**
     * Calculate speed from power, grade, and rider weight
     * Inverts the power equation to solve for speed
     */
    function speedFromPower(powerWatts, gradePercent, riderWeight) {
        const bikeWeight = 9;
        const totalMass = riderWeight + bikeWeight;
        const g = 9.81;
        const Crr = 0.005;
        const CdA = 0.35;
        const rho = 1.2;
        const gradeDecimal = gradePercent / 100;

        // P = v * (m*g*grade + m*g*Crr + 0.5*CdA*rho*v^2)
        // This is cubic in v, so we'll solve numerically
        // Binary search for speed that matches power
        let low = 1, high = 50; // km/h range
        for (let i = 0; i < 20; i++) {
            const mid = (low + high) / 2;
            const v = mid / 3.6; // convert to m/s
            const P = v * (totalMass * g * gradeDecimal + totalMass * g * Crr * Math.cos(Math.atan(gradeDecimal)))
                    + 0.5 * CdA * rho * Math.pow(v, 3);
            if (P < powerWatts) {
                low = mid;
            } else {
                high = mid;
            }
        }
        return (low + high) / 2;
    }

    /**
     * Calculate realistic effort options for a climb
     * Returns array of { label, ftpPercent, watts, wkg, speed, time, sustainable }
     */
    function calculateRealisticEfforts(climb, riderWeight, riderFTP) {
        const distanceKm = climb.distance / 1000;
        const grade = climb.avgGrade;

        // Define effort levels to evaluate
        const effortLevels = [
            { label: 'Race', ftpPercent: 0.95 },
            { label: 'Hard', ftpPercent: 0.88 },
            { label: 'Tempo', ftpPercent: 0.80 },
            { label: 'Easy', ftpPercent: 0.70 }
        ];

        const results = [];

        for (const effort of effortLevels) {
            const watts = Math.round(riderFTP * effort.ftpPercent);
            const wkg = (watts / riderWeight).toFixed(2);
            const speed = speedFromPower(watts, grade, riderWeight);
            const timeMinutes = (distanceKm / speed) * 60;

            // Check if this effort is sustainable for the duration
            const maxFtpForDuration = maxSustainableFtpPercent(timeMinutes);
            const sustainable = effort.ftpPercent <= maxFtpForDuration;

            // Only include if reasonably achievable (within 10% of sustainable)
            if (effort.ftpPercent <= maxFtpForDuration * 1.1) {
                results.push({
                    label: effort.label,
                    ftpPercent: Math.round(effort.ftpPercent * 100),
                    watts,
                    wkg,
                    speed: speed.toFixed(1),
                    timeMinutes,
                    sustainable
                });
            }
        }

        return results;
    }

    /**
     * Show climb popup near the marker
     */
    function showClimbPopup(climb, index, marker) {
        const popup = document.getElementById('climb-popup');
        const markersContainer = document.getElementById('climb-markers');

        if (!popup || !markersContainer) return;

        selectedClimbIndex = index;

        // Update marker active state
        markersContainer.querySelectorAll('.climb-marker').forEach((m, i) => {
            m.classList.toggle('active', i === index);
        });

        // Update popup content
        const distanceKm = (climb.distance / 1000).toFixed(1);
        const avgGrade = climb.avgGrade.toFixed(1);
        const elevGain = Math.round(climb.elevationGain);
        const startKm = climb.startDistance.toFixed(1);

        document.getElementById('climb-popup-title').textContent = `Climb ${index + 1} @ ${startKm}km`;
        document.getElementById('climb-popup-distance').textContent = distanceKm;
        document.getElementById('climb-popup-grade').textContent = `${avgGrade}%`;
        document.getElementById('climb-popup-gain').textContent = elevGain;

        // Get rider profile for power info
        const powerContainer = document.getElementById('climb-popup-power');
        let hasProfile = false;
        let riderWeight = 75;
        let riderFTP = 200;

        if (typeof RiderProfile !== 'undefined') {
            const profile = RiderProfile.get();
            if (profile.isConfigured) {
                riderWeight = profile.weight;
                riderFTP = profile.ftp;
                hasProfile = true;
            }
        }

        // Show power analysis based on realistic effort levels
        if (hasProfile) {
            const efforts = calculateRealisticEfforts(climb, riderWeight, riderFTP);

            if (efforts.length > 0) {
                // Header row
                const headerRow = `
                    <div class="climb-popup-power-row header">
                        <span class="effort-label"></span>
                        <span class="watts">Watts</span>
                        <span class="wkg">W/kg</span>
                        <span class="speed">km/h</span>
                        <span class="time">Time</span>
                    </div>
                `;

                // Data rows
                const dataRows = efforts.map(effort => {
                    const diffClass = effort.sustainable ? 'sustainable' : 'hard';
                    const timeStr = formatClimbTime(effort.timeMinutes);

                    return `
                        <div class="climb-popup-power-row ${diffClass}">
                            <span class="effort-label">${effort.label}</span>
                            <span class="watts">${effort.watts}W</span>
                            <span class="wkg">${effort.wkg}</span>
                            <span class="speed">${effort.speed}</span>
                            <span class="time">${timeStr}</span>
                        </div>
                    `;
                }).join('');

                powerContainer.innerHTML = headerRow + dataRows;
                powerContainer.classList.add('visible');
            } else {
                // Climb is too hard for any sustainable effort
                powerContainer.innerHTML = `
                    <div class="climb-popup-notice">
                        This climb requires efforts beyond sustainable power for the duration.
                    </div>
                `;
                powerContainer.classList.add('visible');
            }
        } else {
            // Without profile, just show distance-based time estimates
            const climbDistanceKm = climb.distance / 1000;
            const speeds = [8, 12, 16];
            powerContainer.innerHTML = speeds.map(speed => {
                const timeMinutes = (climbDistanceKm / speed) * 60;
                const timeStr = formatClimbTime(timeMinutes);
                return `
                    <div class="climb-popup-power-row">
                        <span class="effort-label">&nbsp;</span>
                        <span class="watts">&nbsp;</span>
                        <span class="wkg">&nbsp;</span>
                        <span class="speed">${speed} km/h</span>
                        <span class="time">${timeStr}</span>
                    </div>
                `;
            }).join('');
            powerContainer.classList.add('visible');
        }

        // Position popup above the progress widget
        const widgetRect = document.getElementById('unified-progress-widget').getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();

        popup.style.bottom = `${window.innerHeight - widgetRect.top + 16}px`;
        popup.style.left = `${Math.max(20, Math.min(markerRect.left - 150, window.innerWidth - 360))}px`;

        popup.classList.add('visible');
    }

    /**
     * Hide climb popup
     */
    function hideClimbPopup() {
        const popup = document.getElementById('climb-popup');
        const markersContainer = document.getElementById('climb-markers');

        if (popup) {
            popup.classList.remove('visible');
        }

        if (markersContainer) {
            markersContainer.querySelectorAll('.climb-marker').forEach(m => {
                m.classList.remove('active');
            });
        }

        selectedClimbIndex = -1;
    }

    /**
     * Update active climb highlight based on current position
     */
    function updateActiveClimb(currentDistance) {
        const markersContainer = document.getElementById('climb-markers');
        if (!markersContainer || detectedClimbs.length === 0) return;

        // Find current climb (currentDistance is in km)
        let newActiveIndex = -1;
        for (let i = 0; i < detectedClimbs.length; i++) {
            const climb = detectedClimbs[i];
            // startDistance and endDistance are in km
            if (currentDistance >= climb.startDistance && currentDistance <= climb.endDistance) {
                newActiveIndex = i;
                break;
            }
        }

        // Only update if changed (and not overriding selected state)
        if (newActiveIndex !== activeClimbIndex) {
            activeClimbIndex = newActiveIndex;

            // Update marker styling (but don't override selected state)
            if (selectedClimbIndex < 0) {
                markersContainer.querySelectorAll('.climb-marker').forEach((marker, index) => {
                    marker.classList.toggle('active', index === activeClimbIndex);
                });
            }
        }
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
                // Account for 10px canvas padding on each side
                const chartPadding = 10;
                const chartWidth = rect.width - 2 * chartPadding;
                const position = (e.clientX - rect.left - chartPadding) / chartWidth;
                seekToPosition(Math.max(0, Math.min(1, position)));
            });
        }

        // Draggable scrubber with overview zoom
        const scrubber = document.getElementById('scrubber-handle');
        if (scrubber && profileTrack) {
            let isDragging = false;

            const startDrag = (e) => {
                isDragging = true;
                isScrubberDragging = true;
                e.preventDefault();
                document.body.style.cursor = 'grabbing';
                scrubber.style.cursor = 'grabbing';

                // Start transition to overview (zoom out to see whole route)
                startOverviewTransition();
            };

            const doDrag = (e) => {
                if (!isDragging) return;
                e.preventDefault();

                const rect = profileTrack.getBoundingClientRect();
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                // Account for 10px canvas padding on each side
                const chartPadding = 10;
                const chartWidth = rect.width - 2 * chartPadding;
                let position = (clientX - rect.left - chartPadding) / chartWidth;
                position = Math.max(0, Math.min(1, position));
                seekToPositionDuringDrag(position);
            };

            const endDrag = () => {
                if (isDragging) {
                    isDragging = false;
                    isScrubberDragging = false;
                    document.body.style.cursor = '';
                    scrubber.style.cursor = 'grab';

                    // End overview transition
                    endOverviewTransition();
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
                case 'x':
                case 'X':
                    // Cycle side view direction: auto -> left -> right -> auto
                    cycleSideViewMode();
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
                // Zoom controls (j/k like vim navigation)
                case 'j':
                case 'J':
                    e.preventDefault();
                    adjustZoom(ZOOM_STEP); // Zoom out = larger zoom value = farther
                    break;
                case 'k':
                case 'K':
                    e.preventDefault();
                    adjustZoom(-ZOOM_STEP); // Zoom in = smaller zoom value = closer
                    break;
                case '0':
                    e.preventDefault();
                    zoomLevel = ZOOM_DEFAULT;
                    saveZoomToStorage(zoomLevel);
                    updateZoomIndicator();
                    if (!isPlaying) {
                        freeNavigationEnabled = false;
                        updateCamera(0.016);
                        freeNavigationEnabled = true;
                    }
                    break;
            }
        });

        // Scroll wheel zoom control (when over the map)
        mapCanvas.addEventListener('wheel', (e) => {
            // Only handle scroll if not in free navigation mode or during playback
            if (!freeNavigationEnabled || isPlaying) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? ZOOM_STEP : -ZOOM_STEP;
                adjustZoom(delta);
            }
        }, { passive: false });

        // Effort zone toggle for elevation profile
        setupEffortToggle();

        // Auto-hide UI during playback
        setupAutoHide();
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
     * Cycle through side view modes: auto -> left -> right -> auto
     * Updates the camera mode indicator to show current mode
     * Also switches to side view if not already in it
     */
    function cycleSideViewMode() {
        // Cycle through modes
        if (sideViewMode === SideViewModes.AUTO) {
            sideViewMode = SideViewModes.LEFT;
        } else if (sideViewMode === SideViewModes.LEFT) {
            sideViewMode = SideViewModes.RIGHT;
        } else {
            sideViewMode = SideViewModes.AUTO;
        }

        // If not in side view, switch to it
        if (currentCameraMode !== CameraModes.SIDE_VIEW && targetCameraMode !== CameraModes.SIDE_VIEW) {
            transitionToMode(CameraModes.SIDE_VIEW);
        }

        // Update the camera mode indicator
        updateCameraModeIndicator();

        // Force camera update to apply the new side immediately
        freeNavigationEnabled = false;
        updateCamera(0.016);
        if (!isPlaying) {
            freeNavigationEnabled = true;
        }
    }

    /**
     * Calculate overview camera state that shows the entire route
     */
    function calculateOverviewCameraState() {
        if (!routeData || !routeData.bounds) return null;

        const bounds = routeData.bounds;
        // Calculate center of the route
        const centerLng = (bounds[0][0] + bounds[1][0]) / 2;
        const centerLat = (bounds[0][1] + bounds[1][1]) / 2;

        // Calculate the extent of the route for altitude
        const lngSpan = Math.abs(bounds[1][0] - bounds[0][0]);
        const latSpan = Math.abs(bounds[1][1] - bounds[0][1]);

        // Approximate meters: 1 degree lat ~= 111km, 1 degree lng ~= 111km * cos(lat)
        const latMeters = latSpan * 111000;
        const lngMeters = lngSpan * 111000 * Math.cos(centerLat * Math.PI / 180);
        const maxSpan = Math.max(latMeters, lngMeters);

        // Calculate altitude to see the whole route (roughly 1.2x the span)
        // Account for field of view (~60 degrees, so tan(30) ~= 0.577)
        const altitude = maxSpan * 0.8;

        // Get average elevation of the route for the center look-at point
        const avgElevation = routeData.coordinates.reduce((sum, c) => sum + (c[2] || 0), 0) / routeData.coordinates.length;

        // Calculate initial bearing from start of route for consistency
        const initialBearing = calculateInitialBearing();

        return createCameraState(
            centerLng,
            centerLat,
            altitude + avgElevation,
            initialBearing,
            -60 // Looking down at a good angle
        );
    }

    /**
     * Calculate camera state that frames the scrub start and current positions.
     * Creates a local overview showing just the segment being scrubbed through.
     */
    // Fixed scrub altitude for Google Earth-style transitions
    const SCRUB_ALTITUDE = 2500; // meters above terrain

    /**
     * Calculate camera state for scrubbing - simple fixed altitude, centered on point
     */
    function calculateScrubCameraState(point) {
        if (!point) return calculateOverviewCameraState();

        // Simple: fixed altitude above the current point, looking straight down
        return createCameraState(
            point.lng,
            point.lat,
            SCRUB_ALTITUDE + (point.alt || 0),
            scrubBearing, // Maintain consistent bearing during scrub
            -70 // Looking down at steep angle
        );
    }

    /**
     * Start transition to overview mode when scrubber drag begins
     * Google Earth style: fast zoom UP to fixed altitude
     */
    function startOverviewTransition() {
        overviewTransitionProgress = 0;
        shouldReturnFromOverview = isPlaying;

        // Cancel any existing animation
        if (scrubAnimationId) {
            cancelAnimationFrame(scrubAnimationId);
            scrubAnimationId = null;
        }

        // Capture current state
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);
        scrubStartPoint = dotPoint ? { lng: dotPoint.lng, lat: dotPoint.lat, alt: dotPoint.alt } : null;

        // Store current camera state and bearing for smooth transition
        transitionStartState = getCurrentCameraState();
        scrubBearing = transitionStartState ? transitionStartState.bearing : 0;

        // Target is scrub camera at current point
        overviewTargetState = scrubStartPoint ? calculateScrubCameraState(scrubStartPoint) : calculateOverviewCameraState();

        // Start fast zoom-up animation
        animateScrubZoomUp();
    }

    /**
     * Fast zoom-up animation for Google Earth-style scrubbing
     */
    function animateScrubZoomUp() {
        const ZOOM_UP_SPEED = 16; // Very fast! Complete in ~0.06 seconds

        overviewTransitionProgress = Math.min(1, overviewTransitionProgress + ZOOM_UP_SPEED * 0.016);

        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        if (dotPoint && transitionStartState) {
            const currentPoint = { lng: dotPoint.lng, lat: dotPoint.lat, alt: dotPoint.alt };
            const targetState = calculateScrubCameraState(currentPoint);

            // Use easeOutCubic for fast start, gentle finish (like shooting up)
            const t = easeOutCubic(overviewTransitionProgress);
            const currentState = lerpCameraState(transitionStartState, targetState, t);

            applyCameraState(currentState, dotPoint, true); // isTransitioning=true
            updateDotAndUI(dotPoint);

            if (overviewTransitionProgress >= 1) {
                overviewTargetState = targetState;
            }
        }

        // Continue if not done and still dragging
        if (overviewTransitionProgress < 1 && isScrubberDragging) {
            scrubAnimationId = requestAnimationFrame(animateScrubZoomUp);
        } else {
            scrubAnimationId = null;
        }
    }

    /**
     * Fast zoom-down animation when scrubbing ends
     */
    function animateScrubZoomDown() {
        const ZOOM_DOWN_SPEED = 12; // Very fast swoop down

        overviewTransitionProgress = Math.max(0, overviewTransitionProgress - ZOOM_DOWN_SPEED * 0.016);

        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        if (dotPoint && transitionStartState && overviewTargetState) {
            // Interpolate from overview back to normal camera
            // Use easeInOutCubic for smooth swoop
            const t = easeInOutCubic(1 - overviewTransitionProgress);

            // Calculate what the normal camera would be at this position
            // Skip smoothing during transition - the lerp provides smooth interpolation
            const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
            const directionPoint = getPointAlongRoute(directionDistance);
            const normalCameraState = directionPoint
                ? calculateCameraForMode(currentCameraMode, dotPoint, directionPoint, 0, true) // skipSmoothing=true
                : transitionStartState;

            if (normalCameraState) {
                const currentState = lerpCameraState(overviewTargetState, normalCameraState, t);
                applyCameraState(currentState, dotPoint, true); // isTransitioning=true
            }
            updateDotAndUI(dotPoint);
        }

        // Continue if not done
        if (overviewTransitionProgress > 0) {
            scrubAnimationId = requestAnimationFrame(animateScrubZoomDown);
        } else {
            // Clean up - reset caches and start settling period
            // Settling period skips terrain collision to prevent jitter
            scrubAnimationId = null;
            overviewTransitionProgress = 0;
            transitionStartState = null;
            overviewTargetState = null;
            shouldReturnFromOverview = false;
            resetCameraCaches();
            settlingFramesRemaining = SETTLING_DURATION;
        }
    }

    /**
     * End overview transition when scrubber drag ends
     * Google Earth style: fast swoop DOWN to normal camera
     */
    function endOverviewTransition() {
        scrubStartPoint = null;

        // Cancel any in-progress zoom-up animation
        if (scrubAnimationId) {
            cancelAnimationFrame(scrubAnimationId);
            scrubAnimationId = null;
        }

        // Store current overview state for the swoop-down
        overviewTargetState = getCurrentCameraState();

        if (!isPlaying) {
            // When paused, swoop down to normal camera at current position
            overviewTransitionProgress = 1;
            shouldReturnFromOverview = false;
            animateScrubZoomDown();
        } else {
            // When playing, animation loop handles return
            // IMPORTANT: Set overviewTransitionProgress = 1 so the return transition triggers
            // Without this, a quick click would leave it at 0 and skip the transition entirely
            overviewTransitionProgress = 1;
            shouldReturnFromOverview = true;
            transitionStartState = overviewTargetState;
        }
    }

    /**
     * Seek to position during scrubber drag
     * Google Earth style: camera tracks dot at fixed altitude, fast and smooth
     */
    function seekToPositionDuringDrag(newPosition) {
        progress = Math.max(0, Math.min(1, newPosition));
        resetSmoothingCache();

        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        if (dotPoint) {
            updateDotAndUI(dotPoint);

            const currentPoint = { lng: dotPoint.lng, lat: dotPoint.lat, alt: dotPoint.alt };
            const newTargetState = calculateScrubCameraState(currentPoint);

            // If still zooming up, let the animation handle camera
            if (overviewTransitionProgress < 1 && scrubAnimationId) {
                // Animation is handling it
            } else {
                // At scrub altitude: INSTANT tracking of the dot (Google Earth style)
                // No lerping here - camera should snap to target position immediately
                applyCameraState(newTargetState, dotPoint, true); // isTransitioning=true during scrub
                overviewTargetState = newTargetState;
            }
        }

        updateProgress();
    }

    /**
     * Show UI elements (progress widget and help panel)
     */
    function showUI() {
        const progressWidget = document.getElementById('unified-progress-widget');
        const shortcutsHelp = document.getElementById('shortcuts-help');

        if (progressWidget) progressWidget.classList.remove('auto-hidden');
        if (shortcutsHelp) shortcutsHelp.classList.remove('auto-hidden');
    }

    /**
     * Hide UI elements (progress widget and help panel)
     */
    function hideUI() {
        const progressWidget = document.getElementById('unified-progress-widget');
        const shortcutsHelp = document.getElementById('shortcuts-help');

        if (progressWidget) progressWidget.classList.add('auto-hidden');
        if (shortcutsHelp) shortcutsHelp.classList.add('auto-hidden');
    }

    /**
     * Reset auto-hide timer - call on user interaction
     */
    function resetAutoHideTimer() {
        // Always show UI immediately on interaction
        showUI();

        // Clear existing timer
        if (autoHideTimeout) {
            clearTimeout(autoHideTimeout);
            autoHideTimeout = null;
        }

        // Only set new timer if playing
        if (isPlaying) {
            autoHideTimeout = setTimeout(() => {
                hideUI();
            }, AUTO_HIDE_DELAY);
        }
    }

    /**
     * Setup auto-hide behavior for UI elements
     */
    function setupAutoHide() {
        // Track mouse movement
        document.addEventListener('mousemove', resetAutoHideTimer);
        document.addEventListener('touchstart', resetAutoHideTimer, { passive: true });

        // Also reset on any click/interaction
        document.addEventListener('click', resetAutoHideTimer);
        document.addEventListener('keydown', resetAutoHideTimer);
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

            // When starting playback after seeking while paused, the terrain cache
            // may be stale (from the old position). Use the user override return mechanism
            // to smoothly lerp from current camera position to the target state.
            // This prevents the jarring altitude/pitch jumps at playback start.
            if (window._terrainCache &&
                (window._terrainCache.lastCameraAlt === null || window._terrainCache.lastBearing === null)) {
                // Cache was reset by a seek - set up smooth transition from current position
                lastUserCameraState = getCurrentCameraState();
                returnProgress = 0; // Start lerp from 0 (current state) to 1 (target)
                settlingFramesRemaining = SETTLING_DURATION;
            }

            // If we're in overview mode (from paused scrubber drag), start returning
            if (overviewTransitionProgress > 0) {
                shouldReturnFromOverview = true;
                // Store current overview state as start point for return transition
                transitionStartState = getCurrentCameraState();
            }

            // Start auto-hide timer
            resetAutoHideTimer();

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

            // Show UI and clear auto-hide timer when paused
            showUI();
            if (autoHideTimeout) {
                clearTimeout(autoHideTimeout);
                autoHideTimeout = null;
            }
        }
    }

    /**
     * Seek to specific position
     * Uses smooth transition to prevent camera jitter
     */
    function seekToPosition(newPosition) {
        const oldProgress = progress;
        progress = Math.max(0, Math.min(1, newPosition));

        // Calculate how far we're seeking (as fraction of route)
        const seekDelta = Math.abs(progress - oldProgress);
        const significantSeek = seekDelta > 0.01; // More than 1% of route

        resetSmoothingCache();

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

        // For significant seeks, use smooth transition to prevent jitter
        if (significantSeek && isPlaying) {
            // Cancel any in-progress scrub animation
            if (scrubAnimationId) {
                cancelAnimationFrame(scrubAnimationId);
                scrubAnimationId = null;
            }

            // Capture current camera state as the start point
            transitionStartState = getCurrentCameraState();

            // Set up return transition from current position to new target
            // Start at "1" (overview) and animate down to "0" (normal camera)
            overviewTransitionProgress = 1;
            shouldReturnFromOverview = true;

            // Start settling period to skip terrain collision during transition
            settlingFramesRemaining = SETTLING_DURATION;

            // The animation loop will handle the smooth swoop-down transition
            // It calculates the target state from the current progress
        } else {
            // Small seek or not playing - update immediately
            // Temporarily disable free navigation to update camera during seek
            freeNavigationEnabled = false;

            // Update camera immediately (use small deltaTime for cinematic mode)
            updateCamera(0.016); // ~60fps frame time

            // Re-enable free navigation if we're paused
            if (!isPlaying) {
                freeNavigationEnabled = true;
            }
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
     * Handles mode transitions, user override, and overview return with smooth transitions
     */
    function updateCamera(deltaTime = 0) {
        // Dot position from turf.along() - constant speed along the path
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        // Direction point for camera bearing (slightly ahead)
        const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
        const directionPoint = getPointAlongRoute(directionDistance);

        if (!dotPoint || !directionPoint) return;

        // Handle free navigation mode (when paused, user can navigate freely)
        // Only update dot and UI, don't control camera
        if (freeNavigationEnabled && !isPlaying) {
            updateDotAndUI(dotPoint);
            return;
        }

        // Handle scrubber dragging - stay in overview mode
        if (isScrubberDragging) {
            // During drag, the seekToPositionDuringDrag handles camera
            return;
        }

        // Detect if we're in any kind of lerp transition BEFORE calculating target state
        // This determines whether to skip smoothing in calculateCameraForMode
        const inOverviewReturn = shouldReturnFromOverview && overviewTransitionProgress > 0;
        const inUserOverrideReturn = returnProgress < 1 && lastUserCameraState;
        const inModeTransition = modeTransitionProgress < 1 && transitionStartState;
        const isInAnyTransition = inOverviewReturn || inUserOverrideReturn || inModeTransition;

        // Calculate target camera state for the current/target mode
        // Skip smoothing during transitions - the lerp provides its own smoothing
        let targetState = calculateCameraForMode(targetCameraMode, dotPoint, directionPoint, deltaTime, isInAnyTransition);
        if (!targetState) return;

        // Check for camera stability and apply fallback if needed
        // This detects jitter/chaos and rider visibility issues
        targetState = handleStabilityFallback(targetState, dotPoint, directionPoint, deltaTime);

        // Update camera history for stability tracking
        updateCameraHistory(targetState);

        let finalState;

        // Handle return from overview mode (after scrubber drag ends during playback)
        if (inOverviewReturn) {
            // Smooth transition - easeInOutCubic needs more time to ramp up
            overviewTransitionProgress -= deltaTime * 4; // ~0.25 second return
            overviewTransitionProgress = Math.max(0, overviewTransitionProgress);

            const stillTransitioning = overviewTransitionProgress > 0;
            if (stillTransitioning && transitionStartState) {
                // Use easeInOutCubic for smoother start (less jarring initial jump)
                const t = easeInOutCubic(1 - overviewTransitionProgress);
                finalState = lerpCameraState(transitionStartState, targetState, t);
            } else {
                // Transition complete - reset caches and start settling period
                // Settling period skips terrain collision to prevent jitter
                finalState = targetState;
                shouldReturnFromOverview = false;
                overviewTransitionProgress = 0;
                transitionStartState = null;
                overviewTargetState = null;
                resetCameraCaches();
                settlingFramesRemaining = SETTLING_DURATION;
            }

            // Apply camera state - mark as transitioning to sync watchdog cache
            applyCameraState(finalState, dotPoint, stillTransitioning);
            updateDotAndUI(dotPoint);
            return;
        }

        // Handle user override with smooth return
        if (userOverrideActive) {
            // User is interacting - don't move the camera
            updateDotAndUI(dotPoint);
            return;
        }

        // Track whether we're in any kind of transition
        let isInTransition = false;

        // Handle smooth return from user override
        if (returnProgress < 1 && lastUserCameraState) {
            returnProgress += deltaTime * 0.5; // ~2 second return
            returnProgress = Math.min(1, returnProgress);
            const t = easeOutCubic(returnProgress);
            finalState = lerpCameraState(lastUserCameraState, targetState, t);
            isInTransition = true;
        }
        // Handle mode transition
        else if (modeTransitionProgress < 1 && transitionStartState) {
            const transitionDuration = CameraModeConfig[targetCameraMode].transitionDuration / 1000;
            modeTransitionProgress += deltaTime / transitionDuration;
            modeTransitionProgress = Math.min(1, modeTransitionProgress);

            const t = easeOutCubic(modeTransitionProgress);
            finalState = lerpCameraState(transitionStartState, targetState, t);
            isInTransition = true;

            if (modeTransitionProgress >= 1) {
                currentCameraMode = targetCameraMode;
            }
        }
        // Normal guided mode
        else {
            finalState = targetState;
            currentCameraMode = targetCameraMode;
        }

        // Apply camera state - pass transition flag to sync watchdog cache
        applyCameraState(finalState, dotPoint, isInTransition);

        // Update dot and UI
        updateDotAndUI(dotPoint);
    }

    /**
     * Apply a camera state to the map
     * @param {object} state - Camera state to apply
     * @param {object} lookAtPoint - Point to look at (rider position)
     * @param {boolean} isTransitioning - Whether we're in a lerp transition (scrub return, mode change)
     */
    // Track last applied state for jitter detection logging
    let _lastAppliedState = null;
    let _jitterLogCount = 0;

    function applyCameraState(state, lookAtPoint, isTransitioning = false) {
        try {
            // Jitter detection logging
            if (_lastAppliedState && window.FLYOVER_DEBUG) {
                const altDelta = Math.abs(state.alt - _lastAppliedState.alt);
                let bearingDelta = Math.abs(state.bearing - _lastAppliedState.bearing);
                if (bearingDelta > 180) bearingDelta = 360 - bearingDelta;
                const lngDelta = Math.abs(state.lng - _lastAppliedState.lng) * 111000;
                const latDelta = Math.abs(state.lat - _lastAppliedState.lat) * 111000;
                const posDelta = Math.sqrt(lngDelta * lngDelta + latDelta * latDelta);

                // Log if any significant change
                if (altDelta > 20 || bearingDelta > 5 || posDelta > 50) {
                    _jitterLogCount++;
                    if (_jitterLogCount % 5 === 1) { // Log every 5th to reduce spam
                        console.log('[JITTER]', {
                            altDelta: altDelta.toFixed(0),
                            bearingDelta: bearingDelta.toFixed(1),
                            posDelta: posDelta.toFixed(0),
                            settling: settlingFramesRemaining,
                            transitioning: isTransitioning,
                            mode: currentCameraMode
                        });
                    }
                }
            }
            _lastAppliedState = { ...state };

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

            // Run watchdog to detect/fix stuck camera
            // Pass the actual applied state so watchdog can sync caches during transitions
            cameraWatchdog(state, isTransitioning);
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
     * Uses the same Strava-style algorithm as fit-parser.js for consistency:
     * - Smooths elevations with 5-point moving average
     * - Uses 3.5m threshold to filter GPS noise
     * - Only counts direction changes that exceed threshold
     */
    function calculateElevationGainToPosition(position) {
        if (!routeData || !routeData.coordinates) return 0;

        const coords = routeData.coordinates;
        const targetIndex = Math.floor(position * (coords.length - 1));
        if (targetIndex < 1) return 0;

        // Extract elevations
        const elevations = coords.slice(0, targetIndex + 1).map(c => c[2] || 0);

        // Smooth elevations using 5-point moving average (same as fit-parser)
        const windowSize = 5;
        const smoothed = [];
        for (let i = 0; i < elevations.length; i++) {
            let sum = 0;
            let count = 0;
            for (let j = Math.max(0, i - windowSize); j <= Math.min(elevations.length - 1, i + windowSize); j++) {
                sum += elevations[j];
                count++;
            }
            smoothed.push(sum / count);
        }

        // Apply Strava-style threshold algorithm
        const THRESHOLD = 3.5;
        let totalGain = 0;
        let lastExtreme = smoothed[0];
        let wasClimbing = smoothed.length > 1 ? smoothed[1] > smoothed[0] : false;

        for (let i = 1; i < smoothed.length; i++) {
            const isClimbing = smoothed[i] > smoothed[i - 1];

            // Direction change detected - we found a local extremum
            if (isClimbing !== wasClimbing) {
                const change = smoothed[i - 1] - lastExtreme;
                if (change >= THRESHOLD) {
                    totalGain += change;
                }
                if (Math.abs(change) >= THRESHOLD) {
                    lastExtreme = smoothed[i - 1];
                }
                wasClimbing = isClimbing;
            }
        }

        // Handle final segment
        const finalChange = smoothed[smoothed.length - 1] - lastExtreme;
        if (finalChange >= THRESHOLD) {
            totalGain += finalChange;
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
     * Initialize stats display at position 0
     */
    function initializeStats() {
        if (!routeData) return;

        // Initialize distance stats
        const distDone = document.getElementById('stat-distance-done');
        const distLeft = document.getElementById('stat-distance-left');
        if (distDone) distDone.textContent = '0.0';
        if (distLeft) distLeft.textContent = `${totalDistance.toFixed(1)} km left`;

        // Initialize grade
        const gradeEl = document.getElementById('stat-grade');
        if (gradeEl) gradeEl.textContent = '0.0';

        // Initialize elevation stats
        const elevClimbed = document.getElementById('stat-elev-climbed');
        const elevLeft = document.getElementById('stat-elev-left');
        if (elevClimbed) elevClimbed.textContent = '0';
        if (elevLeft) elevLeft.textContent = `${routeData.elevationGain || 0} m to go`;

        // Initialize scrubber position (accounts for 10px canvas padding)
        const scrubber = document.getElementById('scrubber-handle');
        const overlay = document.getElementById('progress-overlay');
        if (scrubber) scrubber.style.left = 'calc(10px)';  // Align with chart start
        if (overlay) overlay.style.width = '0%';

        // Set elevation profile to position 0
        if (elevationProfile) {
            elevationProfile.setPosition(0);
        }
    }

    /**
     * Update unified progress widget
     */
    function updateProgress() {
        const currentDistance = progress * totalDistance;
        const remainingDistance = totalDistance - currentDistance;
        const progressPercent = progress * 100;

        // Update scrubber position - aligned with canvas chart area (10px padding)
        // Formula: left = 10px + progress * (100% - 20px)
        // Simplified: calc(10px + X% - X*0.2px) where X = progressPercent
        const scrubber = document.getElementById('scrubber-handle');
        const overlay = document.getElementById('progress-overlay');
        if (scrubber) {
            scrubber.style.left = `calc(10px + ${progressPercent}% - ${progressPercent * 0.2}px)`;
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

        // Update active climb highlight (distance in meters for climb detection)
        updateActiveClimb(currentDistance * 1000);
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

    // Debug API exposed to window for development
    window.flyoverDebug = {
        // Enable/disable debug logging
        enable: () => { window.FLYOVER_DEBUG = true; console.log('Flyover debug enabled'); },
        disable: () => { window.FLYOVER_DEBUG = false; console.log('Flyover debug disabled'); },

        // Get current state
        getState: () => ({
            progress: progress,
            isPlaying: isPlaying,
            currentMode: currentCameraMode,
            targetMode: targetCameraMode,
            zoomLevel: zoomLevel,
            cinematicAngle: cinematicAngle,
            totalDistance: totalDistance,
            distanceKm: progress * totalDistance
        }),

        // Seek to a specific position (0-1)
        seekTo: (pos) => {
            resetSmoothingCache();
            progress = Math.max(0, Math.min(1, pos));
            updateCamera(0);
            console.log(`Seeked to ${(progress * 100).toFixed(1)}% (${(progress * totalDistance).toFixed(2)} km)`);
        },

        // Seek to a specific distance in km
        seekToKm: (km) => {
            resetSmoothingCache();
            progress = Math.max(0, Math.min(1, km / totalDistance));
            updateCamera(0);
            console.log(`Seeked to ${km.toFixed(2)} km (${(progress * 100).toFixed(1)}%)`);
        },

        // Set camera mode
        setMode: (mode) => {
            const modes = { chase: CameraModes.CHASE, birds_eye: CameraModes.BIRDS_EYE, side_view: CameraModes.SIDE_VIEW, cinematic: CameraModes.CINEMATIC };
            if (modes[mode]) {
                switchCameraMode(modes[mode]);
                console.log(`Switched to ${mode} mode`);
            } else {
                console.log('Available modes: chase, birds_eye, side_view, cinematic');
            }
        },

        // Query terrain at a point
        queryTerrain: (lng, lat) => {
            const elev = map.queryTerrainElevation([lng, lat]);
            console.log(`Terrain at [${lng}, ${lat}]: ${elev !== null ? elev.toFixed(1) + 'm' : 'null'}`);
            return elev;
        },

        // Get map instance for direct inspection
        getMap: () => map,

        // Pause/play
        pause: () => { if (isPlaying) togglePlayPause(); },
        play: () => { if (!isPlaying) togglePlayPause(); },

        // Watchdog status and controls
        watchdog: {
            status: () => ({
                stuckFrames: watchdogStuckFrames,
                lastAppliedAlt: watchdogLastAppliedAlt,
                altitudeHistory: [...watchdogAltitudeHistory],
                terrainCache: window._terrainCache ? {
                    lastCameraAlt: window._terrainCache.lastCameraAlt,
                    lastBearing: window._terrainCache.lastBearing,
                    lastElevation: window._terrainCache.lastElevation
                } : null
            }),
            reset: () => {
                resetCameraCaches();
                console.log('Camera caches reset by watchdog');
            }
        }
    };
    console.log('Flyover debug API available: window.flyoverDebug (try .enable() for logging)');
})();

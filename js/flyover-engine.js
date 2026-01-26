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

    // Adaptive smoothing for intentional seeks
    // When user seeks to a distant position, we use larger smoothing limits
    // that decay exponentially back to normal. This allows fast camera catch-up
    // without causing jitter during normal playback.
    let _seekTimestamp = 0;              // When last seek occurred (performance.now())
    let _seekDistance = 0;               // Distance of last seek in meters
    const ADAPTIVE_WINDOW = 5000;        // ms to apply adaptive smoothing after seek
    const BASE_POS_LIMIT = 30;           // meters/frame baseline (normal playback)
    const MAX_POS_LIMIT = 10000;         // meters/frame maximum (fast catch-up after large seeks)
    const BASE_ALT_LIMIT = 50;           // meters/frame baseline for altitude
    const MAX_ALT_LIMIT = 2000;          // meters/frame maximum for altitude
    const DECAY_CONSTANT = 3000;         // ms for exponential decay (63% reduction at this time)

    // Terrain collision constants
    const TERRAIN_MIN_CLEARANCE = 100;   // meters above terrain at camera position
    const RIDER_MIN_CLEARANCE = 100;     // meters above rider - camera should never be below rider

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
        const oldZoom = zoomLevel;
        const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel + delta));
        if (newZoom !== zoomLevel) {
            zoomLevel = newZoom;
            saveZoomToStorage(zoomLevel);

            // Record input for panic button replay
            if (stateRecorder && stateRecorder.isEnabled) {
                stateRecorder.recordInput('zoom', { from: oldZoom, to: newZoom });
            }
            updateZoomIndicator();

            // Reset predictive camera spring so zoom change is immediate
            // Without this, the spring would slowly transition to the new zoom level
            if (predictiveCameraController) {
                predictiveCameraController.getCameraSpring().reset(null);
            }

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
     * Normalize a bearing to [0, 360) range
     */
    function normalizeBearing(bearing) {
        if (bearing < 0) return bearing + 360;
        if (bearing >= 360) return bearing - 360;
        return bearing;
    }

    /**
     * Calculate bearing delta with wrap-around handling
     * Returns delta in range (-180, 180]
     */
    function bearingDelta(current, previous) {
        let delta = current - previous;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return delta;
    }

    /**
     * Create a new exponential smoothing state for position tracking
     */
    function createSmoothState(point, mode) {
        return {
            lng: point.lng,
            lat: point.lat,
            alt: point.alt,
            mode: mode
        };
    }

    /**
     * Apply exponential smoothing to a position state
     * Returns the smoothed position as { lng, lat, alt }
     */
    function applySmoothPosition(state, target, alpha) {
        state.lng += alpha * (target.lng - state.lng);
        state.lat += alpha * (target.lat - state.lat);
        state.alt += alpha * (target.alt - state.alt);
        return { lng: state.lng, lat: state.lat, alt: state.alt };
    }

    /**
     * Get or initialize a global smoothing state, resetting if mode changed
     */
    function getOrInitSmoothState(stateKey, point, mode) {
        if (!window[stateKey] || window[stateKey].mode !== mode) {
            window[stateKey] = createSmoothState(point, mode);
        }
        return window[stateKey];
    }

    /**
     * Get smoothing alpha value for a camera mode
     * Lower alpha = more aggressive smoothing (slower response)
     */
    function getRiderSmoothingAlpha(mode) {
        switch (mode) {
            case CameraModes.SIDE_VIEW: return 0.008;  // Maximum smoothing for side view
            case CameraModes.CHASE: return 0.015;
            default: return 0.03;
        }
    }

    /**
     * Get camera position smoothing alpha value for a camera mode
     */
    function getCameraSmoothingAlpha(mode) {
        switch (mode) {
            case CameraModes.SIDE_VIEW: return 0.015;  // Maximum smoothing for side view
            case CameraModes.CHASE: return 0.02;
            default: return 0.04;
        }
    }

    /**
     * Calculate position delta in meters between two camera states
     */
    function calculatePositionDelta(current, previous) {
        const cosLat = Math.cos(current.lat * Math.PI / 180);
        const lngDeltaM = (current.lng - previous.lng) * 111000 * cosLat;
        const latDeltaM = (current.lat - previous.lat) * 111000;
        return Math.sqrt(lngDeltaM * lngDeltaM + latDeltaM * latDeltaM);
    }

    /**
     * Calculate mean and standard deviation of an array
     */
    function calculateStats(arr) {
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const variance = arr.reduce((sum, val) => sum + (val - mean) ** 2, 0) / arr.length;
        return { mean, stddev: Math.sqrt(variance) };
    }

    /**
     * Calculate smoothness score from standard deviation
     * Returns a 0-100 score where 100 is perfectly smooth
     */
    function calculateSmoothnessScore(stddev, factor, useSqrt = false) {
        const penalty = useSqrt ? Math.sqrt(stddev) * factor : stddev * factor;
        return Math.max(0, 100 - penalty);
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
     * Query terrain elevation at a position, with cache fallback.
     * Returns null if terrain data is unavailable.
     */
    function queryTerrainElevationWithCache(lng, lat) {
        let elevation = null;

        try {
            elevation = map.queryTerrainElevation([lng, lat]);
            if (elevation !== null && elevation !== undefined) {
                // Valid terrain data - cache it with position
                if (window._terrainCache) {
                    window._terrainCache.lastElevation = elevation;
                    window._terrainCache.lastElevationLng = lng;
                    window._terrainCache.lastElevationLat = lat;
                }
            } else if (window._terrainCache && window._terrainCache.lastElevation !== null) {
                // Terrain query returned null - only use cache if query is near cached position.
                // Using a distant cached value causes jitter when moving through varying terrain
                // because the fallback value doesn't match the actual terrain at the query point.
                const cachedLng = window._terrainCache.lastElevationLng;
                const cachedLat = window._terrainCache.lastElevationLat;
                if (cachedLng != null && cachedLat != null) {
                    const cosLat = Math.cos(lat * Math.PI / 180);
                    const dLng = (lng - cachedLng) * 111000 * cosLat;
                    const dLat = (lat - cachedLat) * 111000;
                    const distance = Math.sqrt(dLng * dLng + dLat * dLat);
                    // Only use cache if within 50m - terrain can vary significantly beyond that
                    if (distance < 50) {
                        elevation = window._terrainCache.lastElevation;
                    }
                    // If too far, return null - better to skip collision than use wrong value
                }
            }
        } catch (e) {
            // Terrain query not available - same position-aware cache logic
            if (window._terrainCache && window._terrainCache.lastElevation !== null) {
                const cachedLng = window._terrainCache.lastElevationLng;
                const cachedLat = window._terrainCache.lastElevationLat;
                if (cachedLng != null && cachedLat != null) {
                    const cosLat = Math.cos(lat * Math.PI / 180);
                    const dLng = (lng - cachedLng) * 111000 * cosLat;
                    const dLat = (lat - cachedLat) * 111000;
                    const distance = Math.sqrt(dLng * dLng + dLat * dLat);
                    if (distance < 50) {
                        elevation = window._terrainCache.lastElevation;
                    }
                }
            }
        }

        // Record terrain query for deterministic replay
        if (stateRecorder && stateRecorder.isEnabled) {
            stateRecorder.recordTerrainQuery(elevation);
        }

        return elevation;
    }

    /**
     * Calculate minimum safe altitude above terrain and rider.
     * Applies dynamic clearance when terrain is higher than rider (steep slopes).
     */
    function calculateMinimumAltitude(terrainElevation, riderAltitude) {
        // Calculate dynamic clearance - add extra for steep terrain
        // where terrain at camera position is higher than the rider
        let dynamicClearance = TERRAIN_MIN_CLEARANCE;
        if (terrainElevation !== null && terrainElevation > riderAltitude) {
            const elevationDiff = terrainElevation - riderAltitude;
            dynamicClearance = TERRAIN_MIN_CLEARANCE + elevationDiff * 0.5;
        }

        const minFromTerrain = terrainElevation !== null ? terrainElevation + dynamicClearance : 0;
        const minFromRider = riderAltitude + RIDER_MIN_CLEARANCE;

        return Math.max(minFromTerrain, minFromRider);
    }

    /**
     * Apply terrain collision to an altitude, ensuring it stays above terrain and rider.
     * Returns the adjusted altitude and whether adjustment was made.
     */
    function applyTerrainCollision(cameraLng, cameraLat, cameraAlt, riderAltitude) {
        const terrainElevation = queryTerrainElevationWithCache(cameraLng, cameraLat);
        const minAltitude = calculateMinimumAltitude(terrainElevation, riderAltitude);

        if (cameraAlt < minAltitude) {
            return { altitude: minAltitude, adjusted: true };
        }
        return { altitude: cameraAlt, adjusted: false };
    }

    /**
     * Interpolate between two camera states with smooth altitude handling
     * Uses an "arc" approach when there's a significant altitude difference
     * to avoid the jarring zoom-in/zoom-out effect during camera mode transitions
     */
    function lerpCameraState(start, end, t) {
        // Normalize bearings to 0-360 range first
        let startBearing = ((start.bearing % 360) + 360) % 360;
        let endBearing = ((end.bearing % 360) + 360) % 360;

        // Handle bearing wrap-around - take the shorter path
        let bearingDiff = endBearing - startBearing;
        if (bearingDiff > 180) {
            startBearing += 360;
        } else if (bearingDiff < -180) {
            endBearing += 360;
        }

        // Calculate altitude difference
        const altDiff = Math.abs(end.alt - start.alt);
        const goingDown = end.alt < start.alt;

        // For large altitude differences (>200m), use arc interpolation
        // This creates a smooth "rise up, move, descend" motion instead of diving
        // ONLY apply arc when going UP - when going DOWN (like returning from scrub),
        // we want direct descent, not an arc that goes even higher first
        let finalAlt;
        if (altDiff > 200 && !goingDown) {
            // Use higher of the two altitudes as the peak, plus a boost based on altitude difference
            const peakAlt = Math.max(start.alt, end.alt) + altDiff * 0.3;

            // Create arc using sine curve - peaks at t=0.5
            const arcFactor = Math.sin(t * Math.PI);
            const linearAlt = lerp(start.alt, end.alt, t);
            const arcBoost = (peakAlt - linearAlt) * arcFactor;
            finalAlt = linearAlt + arcBoost * 0.5; // Blend 50% arc for subtle effect
        } else {
            // Linear interpolation for going down or small differences
            finalAlt = lerp(start.alt, end.alt, t);
        }

        // For large bearing differences (>90 degrees), use eased bearing interpolation
        // This prevents the camera from feeling like it's "spinning wildly"
        const normalizedBearingDiff = Math.abs(bearingDiff > 180 ? bearingDiff - 360 : bearingDiff);
        let bearingT = t;
        if (normalizedBearingDiff > 90) {
            // Use ease-in-out for large rotations - slower at start/end, faster in middle
            bearingT = easeInOutCubic(t);
        }

        return {
            lng: lerp(start.lng, end.lng, t),
            lat: lerp(start.lat, end.lat, t),
            alt: finalAlt,
            bearing: (lerp(startBearing, endBearing, bearingT) + 360) % 360,
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
            let altitude = pos.toAltitude();

            // Sanity check: altitude should be positive and reasonable
            // Mapbox FreeCamera can return invalid values during transitions
            if (!altitude || altitude < 0 || altitude > 50000) {
                // Use a sensible fallback based on current zoom level
                altitude = Math.max(500, 10000 / Math.pow(2, map.getZoom() - 10));
            }

            return createCameraState(
                lngLat.lng,
                lngLat.lat,
                altitude,
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
                // Guard against very short segments (< 1m) which could cause division issues
                if (segmentLength < 0.001) { // Less than 1 meter
                    const alt1 = coords[i - 1][2] || 0;
                    const alt2 = coords[i][2] || 0;
                    return (alt1 + alt2) / 2; // Just average the two altitudes
                }
                const ratio = (targetDistance - cumulativeDistance) / segmentLength;
                // Clamp ratio to [0, 1] to prevent extrapolation
                const clampedRatio = Math.max(0, Math.min(1, ratio));
                const alt1 = coords[i - 1][2] || 0;
                const alt2 = coords[i][2] || 0;
                return alt1 + (alt2 - alt1) * clampedRatio;
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

    // =========================================================================
    // PREDICTIVE CAMERA SYSTEM
    // Instead of reactively following the rider and applying post-hoc smoothing,
    // this system samples future rider positions, computes a weighted centroid,
    // and uses critically damped springs for smooth camera movement.
    // The key insight: local path variations (zigzags, S-curves) mathematically
    // cancel out in the weighted centroid - the camera moves smoothly while
    // the rider follows the actual path.
    // =========================================================================

    /**
     * Critically Damped Spring - provides smooth, natural motion without oscillation
     * This is the gold standard for game camera smoothing.
     *
     * @param {number} omega - Angular frequency (higher = faster response, typical: 1.0-2.0)
     */
    class CriticallyDampedSpring {
        constructor(omega = 1.5) {
            this.omega = omega;
            this.position = null;  // { lng, lat, alt }
            this.velocity = { lng: 0, lat: 0, alt: 0 };
        }

        /**
         * Update the spring toward a target position
         * @param {object} target - Target position { lng, lat, alt }
         * @param {number} deltaTime - Time step in seconds
         * @returns {object} - Smoothed position { lng, lat, alt }
         */
        update(target, deltaTime) {
            if (!this.position) {
                this.position = { ...target };
                if (window.FLYOVER_DEBUG) {
                    console.log('[SPRING] Teleported to target (position was null) target=(' +
                        target.lng.toFixed(4) + ',' + target.lat.toFixed(4) + ')');
                }
                return this.position;
            }

            // Clamp deltaTime to prevent instability
            const dt = Math.min(deltaTime, 0.1);
            const omega = this.omega;
            const omega2 = omega * omega;

            // Critically damped spring: zeta = 1.0
            // Formula: a = -omega^2 * displacement - 2 * omega * velocity
            for (const axis of ['lng', 'lat', 'alt']) {
                const displacement = this.position[axis] - target[axis];
                const acceleration = -omega2 * displacement - 2 * omega * this.velocity[axis];

                this.velocity[axis] += acceleration * dt;
                this.position[axis] += this.velocity[axis] * dt;
            }

            return { ...this.position };
        }

        /**
         * Reset the spring to a specific position (for mode changes, etc.)
         */
        reset(position) {
            this.position = position ? { ...position } : null;
            this.velocity = { lng: 0, lat: 0, alt: 0 };
        }

        /**
         * Check if spring has settled (velocity near zero)
         */
        isSettled(threshold = 0.001) {
            return Math.abs(this.velocity.lng) < threshold &&
                   Math.abs(this.velocity.lat) < threshold &&
                   Math.abs(this.velocity.alt) < threshold;
        }

        /**
         * Teleport to a new position instantly (for seeks)
         * Resets velocity to zero to prevent overshoot
         */
        teleportTo(position) {
            this.position = position ? { ...position } : null;
            this.velocity = { lng: 0, lat: 0, alt: 0 };
            if (window.CAMERA_CHAOS_DEBUG) {
                console.log('[SPRING] Teleported to:', position);
            }
        }

        /**
         * Get current velocity magnitude in meters (approximate)
         */
        getVelocityMagnitude() {
            // Convert lng/lat velocity to approximate meters
            const vLng = this.velocity.lng * 111320; // rough m/deg at equator
            const vLat = this.velocity.lat * 111320;
            const vAlt = this.velocity.alt;
            return Math.sqrt(vLng * vLng + vLat * vLat + vAlt * vAlt);
        }
    }

    /**
     * Circular Spring for Angular Values
     * Handles 0-360 degree wraparound using critically damped spring physics.
     * Ensures smooth transitions across the 0/360 boundary.
     */
    class CircularSpring {
        constructor(omega = 3.0) {
            this.omega = omega;
            this.value = null;
            this.velocity = 0;
        }

        /**
         * Update the spring toward a target angle
         * @param {number} target - Target angle in degrees (0-360)
         * @param {number} deltaTime - Time step in seconds
         * @returns {number} - Smoothed angle in degrees (0-360)
         */
        update(target, deltaTime) {
            if (this.value === null) {
                this.value = target;
                this.velocity = 0;
                return target;
            }

            // Clamp deltaTime to prevent instability
            const dt = Math.min(deltaTime, 0.1);

            // Calculate shortest angular distance (handles wraparound)
            let delta = target - this.value;
            // Normalize to -180 to +180
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;

            // Critically damped spring physics for angle
            const omega = this.omega;
            const omega2 = omega * omega;
            const acceleration = -omega2 * (-delta) - 2 * omega * this.velocity;

            this.velocity += acceleration * dt;
            this.value += this.velocity * dt;

            // Normalize result to 0-360
            while (this.value < 0) this.value += 360;
            while (this.value >= 360) this.value -= 360;

            return this.value;
        }

        /**
         * Teleport to a specific angle (zero velocity)
         */
        teleportTo(angle) {
            this.value = angle;
            this.velocity = 0;
        }

        /**
         * Reset to uninitialized state
         */
        reset() {
            this.value = null;
            this.velocity = 0;
        }

        /**
         * Check if spring has settled
         */
        isSettled(threshold = 0.1) {
            return Math.abs(this.velocity) < threshold;
        }
    }

    /**
     * Outlier-Rejecting Exponential Moving Average
     * Filters out sudden large changes (like terrain tile loads) while
     * allowing gradual adaptation to genuine terrain changes.
     */
    class OutlierRejectingEMA {
        /**
         * @param {number} alpha - Normal smoothing factor (0-1, higher = faster adaptation)
         * @param {number} outlierThreshold - Changes larger than this use reduced alpha
         * @param {number} reducedAlphaFactor - Multiplier for alpha when outlier detected
         */
        constructor(alpha = 0.2, outlierThreshold = 50, reducedAlphaFactor = 0.1) {
            this.alpha = alpha;
            this.outlierThreshold = outlierThreshold;
            this.reducedAlphaFactor = reducedAlphaFactor;
            this.value = null;
            this.lastRawValue = null;
        }

        /**
         * Update with a new value
         * @param {number|null} rawValue - New measurement (null = no data, hold previous)
         * @returns {number|null} - Filtered value
         */
        update(rawValue) {
            this.lastRawValue = rawValue;

            // Handle null input - hold previous value
            if (rawValue === null) {
                return this.value;
            }

            // First value - initialize
            if (this.value === null) {
                this.value = rawValue;
                return this.value;
            }

            // Check for outlier
            const delta = Math.abs(rawValue - this.value);
            let effectiveAlpha = this.alpha;

            if (delta > this.outlierThreshold) {
                // Outlier detected - use much slower adaptation
                effectiveAlpha = this.alpha * this.reducedAlphaFactor;
                if (window.CAMERA_CHAOS_DEBUG) {
                    console.log(`[TERRAIN FILTER] Outlier detected: delta=${delta.toFixed(1)}m, using reduced alpha=${effectiveAlpha.toFixed(3)}`);
                }
            }

            // Exponential moving average
            this.value = this.value + effectiveAlpha * (rawValue - this.value);
            return this.value;
        }

        /**
         * Reset filter state
         */
        reset() {
            this.value = null;
            this.lastRawValue = null;
        }

        /**
         * Force set to a specific value (for teleports)
         */
        teleportTo(value) {
            this.value = value;
            this.lastRawValue = value;
        }

        /**
         * Get current filtered value
         */
        getValue() {
            return this.value;
        }
    }

    /**
     * Unified Camera Controller
     * Single source of truth for camera smoothing - replaces multiple competing systems.
     *
     * Design principles:
     * 1. ONE spring for position, ONE for orientation
     * 2. Constraints applied to TARGET before spring, not output after
     * 3. Disruptions (seeks, mode changes) handled as explicit events
     * 4. No post-processing of spring output
     */
    /**
     * State Machine States for Unified Camera Controller
     */
    const CameraState = {
        NORMAL: 'NORMAL',           // Spring active, normal tracking
        TRANSITIONING: 'TRANSITIONING', // Lerp + spring during mode changes
        SEEKING: 'SEEKING'          // Teleport/sync after large seeks
    };

    class UnifiedCameraController {
        constructor() {
            // THE ONLY SMOOTHING SPRINGS
            this.positionSpring = new CriticallyDampedSpring(2.0);  // {lng, lat, alt}
            this.bearingSpring = new CircularSpring(3.0);          // handles 0-360 wraparound
            this.pitchSpring = { value: null, velocity: 0, omega: 3.0 }; // 1D spring for pitch

            // TERRAIN FILTERING
            this.terrainFilter = new OutlierRejectingEMA(0.15, 50, 0.05);

            // STATE MACHINE
            this.state = CameraState.NORMAL;

            // TRANSITION STATE
            this.transition = null; // { startState, targetMode, progress, duration }

            // MODE
            this.currentMode = CameraModes.CHASE;

            // Tracking
            this.lastRiderPosition = null;
            this.lastTarget = null;
            this.isEnabled = false;

            // Configuration
            this.config = {
                teleportThreshold: 500,     // meters - seeks larger than this teleport
                smallSeekThreshold: 100,    // meters - seeks smaller than this, spring catches up
                minTerrainClearance: 100,   // meters above terrain
                minRiderClearance: 100,     // meters above rider
                transitionDuration: 1.0,    // seconds for mode transitions
            };
        }

        /**
         * Update pitch using 1D spring physics
         */
        smoothPitch(targetPitch, deltaTime) {
            if (this.pitchSpring.value === null) {
                this.pitchSpring.value = targetPitch;
                this.pitchSpring.velocity = 0;
                return targetPitch;
            }

            const dt = Math.min(deltaTime, 0.1);
            const omega = this.pitchSpring.omega;
            const omega2 = omega * omega;
            const delta = targetPitch - this.pitchSpring.value;
            const acceleration = -omega2 * (-delta) - 2 * omega * this.pitchSpring.velocity;

            this.pitchSpring.velocity += acceleration * dt;
            this.pitchSpring.value += this.pitchSpring.velocity * dt;

            return this.pitchSpring.value;
        }

        /**
         * Main update - call once per frame
         * Replaces ALL other smoothing systems when enabled.
         *
         * @param {object} riderPos - Current rider position {lng, lat, alt}
         * @param {number} terrainElevation - Terrain at camera position (can be null)
         * @param {string} mode - Current camera mode
         * @param {number} deltaTime - Seconds since last frame
         * @param {object} idealTarget - Pre-calculated ideal camera position {lng, lat, alt, bearing, pitch}
         * @returns {object} - Smoothed camera state {lng, lat, alt, bearing, pitch}
         */
        update(riderPos, terrainElevation, mode, deltaTime, idealTarget) {
            // Auto-enable when called (USE_UNIFIED_CAMERA routes here)
            if (!this.isEnabled) {
                this.isEnabled = true;
            }

            if (!idealTarget) {
                return idealTarget;
            }

            // Handle mode change - start transition
            if (mode !== this.currentMode) {
                this.startTransition(mode);
            }

            // Update state machine
            if (this.state === CameraState.SEEKING) {
                // Seeking state - teleport already happened, return to normal
                this.state = CameraState.NORMAL;
            }

            // 1. Filter terrain to absorb async tile load surprises
            const filteredTerrain = this.terrainFilter.update(terrainElevation);

            // 2. Apply terrain constraint to TARGET (not output!)
            let constrainedTarget = { ...idealTarget };
            if (filteredTerrain !== null) {
                const minAlt = filteredTerrain + this.config.minTerrainClearance;
                const minFromRider = riderPos.alt + this.config.minRiderClearance;
                constrainedTarget.alt = Math.max(constrainedTarget.alt, minAlt, minFromRider);
            }

            // 3. Handle transition state
            if (this.state === CameraState.TRANSITIONING && this.transition) {
                return this.updateTransition(constrainedTarget, deltaTime);
            }

            // 4. Spring updates - THE ONLY SMOOTHING
            const smoothedPos = this.positionSpring.update(constrainedTarget, deltaTime);
            const smoothedBearing = this.bearingSpring.update(idealTarget.bearing, deltaTime);
            const smoothedPitch = this.smoothPitch(idealTarget.pitch, deltaTime);

            // Debug logging
            if (window.CAMERA_CHAOS_DEBUG) {
                const springLag = this.calculateDistance(idealTarget, smoothedPos);
                if (springLag > 50) {
                    console.log(`[UNIFIED] Spring lag: ${springLag.toFixed(1)}m, state=${this.state}`);
                }
            }

            this.lastTarget = constrainedTarget;
            this.lastRiderPosition = riderPos;

            // Return smoothed state - NO POST-PROCESSING
            return {
                lng: smoothedPos.lng,
                lat: smoothedPos.lat,
                alt: smoothedPos.alt,
                bearing: smoothedBearing,
                pitch: smoothedPitch
            };
        }

        /**
         * Start a mode transition
         */
        startTransition(newMode) {
            const startState = this.getCurrentState();

            // If springs aren't properly initialized (position is 0,0), skip transition
            // This prevents the camera from flying from the Atlantic Ocean
            const hasValidPosition = this.positionSpring.position &&
                (Math.abs(this.positionSpring.position.lng) > 0.001 ||
                 Math.abs(this.positionSpring.position.lat) > 0.001);

            if (!hasValidPosition) {
                if (window.CAMERA_CHAOS_DEBUG) {
                    console.log(`[UNIFIED] Skipping transition (no valid position): ${this.currentMode} -> ${newMode}`);
                }
                // Just change mode, let springs initialize from next target
                this.currentMode = newMode;
                return;
            }

            if (window.CAMERA_CHAOS_DEBUG) {
                console.log(`[UNIFIED] Starting transition: ${this.currentMode} -> ${newMode}`);
            }

            this.transition = {
                startState: startState,
                targetMode: newMode,
                progress: 0,
                duration: this.config.transitionDuration
            };
            this.state = CameraState.TRANSITIONING;
            this.currentMode = newMode;
        }

        /**
         * Update during transition - blend lerp with spring
         */
        updateTransition(target, deltaTime) {
            if (!this.transition) {
                this.state = CameraState.NORMAL;
                return target;
            }

            // Update progress
            this.transition.progress += deltaTime / this.transition.duration;

            if (this.transition.progress >= 1) {
                // Transition complete
                this.transition = null;
                this.state = CameraState.NORMAL;

                // Teleport springs to final position to avoid overshoot
                this.positionSpring.teleportTo(target);
                this.bearingSpring.teleportTo(target.bearing);
                this.pitchSpring.value = target.pitch;
                this.pitchSpring.velocity = 0;

                if (window.CAMERA_CHAOS_DEBUG) {
                    console.log(`[UNIFIED] Transition complete`);
                }

                return target;
            }

            // Eased progress for smooth transition
            const t = this.easeInOutCubic(this.transition.progress);

            // Lerp from start to target
            const startState = this.transition.startState;
            const lerpedState = {
                lng: this.lerp(startState.lng, target.lng, t),
                lat: this.lerp(startState.lat, target.lat, t),
                alt: this.lerp(startState.alt, target.alt, t),
                bearing: this.lerpAngle(startState.bearing, target.bearing, t),
                pitch: this.lerp(startState.pitch, target.pitch, t)
            };

            // Update springs to track the lerped position (prevents snap at end)
            this.positionSpring.teleportTo(lerpedState);
            this.bearingSpring.teleportTo(lerpedState.bearing);
            this.pitchSpring.value = lerpedState.pitch;
            this.pitchSpring.velocity = 0;

            return lerpedState;
        }

        /**
         * Handle seek event - teleport for large seeks, spring catches up for small ones
         */
        onSeek(newRiderPos, newTarget, seekDistanceM) {
            if (!this.isEnabled) return;

            if (seekDistanceM > this.config.teleportThreshold) {
                // Large seek - teleport everything
                this.state = CameraState.SEEKING;
                this.positionSpring.teleportTo(newTarget);
                this.bearingSpring.teleportTo(newTarget.bearing);
                this.pitchSpring.value = newTarget.pitch;
                this.pitchSpring.velocity = 0;
                this.terrainFilter.reset();

                // Cancel any active transition
                this.transition = null;

                if (window.CAMERA_CHAOS_DEBUG) {
                    console.log(`[UNIFIED] Teleport on seek: ${seekDistanceM.toFixed(0)}m`);
                }
            } else if (seekDistanceM > this.config.smallSeekThreshold) {
                // Medium seek - reset terrain filter but let springs catch up
                this.terrainFilter.reset();
                if (window.CAMERA_CHAOS_DEBUG) {
                    console.log(`[UNIFIED] Medium seek: ${seekDistanceM.toFixed(0)}m - spring catching up`);
                }
            }
            // Small seeks: spring naturally catches up, no special handling

            this.lastRiderPosition = newRiderPos;
        }

        /**
         * Get current camera state from springs
         * Uses lastTarget as fallback if springs aren't initialized (prevents 0,0,0 bug)
         */
        getCurrentState() {
            const pos = this.positionSpring.position;
            const fallback = this.lastTarget || { lng: 0, lat: 0, alt: 300, bearing: 0, pitch: -15 };

            return {
                lng: pos?.lng ?? fallback.lng,
                lat: pos?.lat ?? fallback.lat,
                alt: pos?.alt ?? fallback.alt,
                bearing: this.bearingSpring.value ?? fallback.bearing,
                pitch: this.pitchSpring.value ?? fallback.pitch
            };
        }

        /**
         * Enable/disable the unified controller
         */
        setEnabled(enabled) {
            this.isEnabled = enabled;
            if (enabled && !this.positionSpring.position) {
                this.positionSpring.reset(null);
            }
            console.log(`[UNIFIED] Controller ${enabled ? 'enabled' : 'disabled'}`);
        }

        /**
         * Reset all state (for route changes, etc.)
         */
        reset() {
            this.positionSpring.reset(null);
            this.bearingSpring.reset();
            this.pitchSpring.value = null;
            this.pitchSpring.velocity = 0;
            this.terrainFilter.reset();
            this.state = CameraState.NORMAL;
            this.transition = null;
            this.lastRiderPosition = null;
            this.lastTarget = null;
        }

        /**
         * Calculate distance between two positions in meters
         */
        calculateDistance(p1, p2) {
            if (!p1 || !p2) return 0;
            const dLng = (p2.lng - p1.lng) * 111320 * Math.cos(p1.lat * Math.PI / 180);
            const dLat = (p2.lat - p1.lat) * 111320;
            const dAlt = (p2.alt || 0) - (p1.alt || 0);
            return Math.sqrt(dLng * dLng + dLat * dLat + dAlt * dAlt);
        }

        /**
         * Linear interpolation
         */
        lerp(a, b, t) {
            return a + (b - a) * t;
        }

        /**
         * Angular interpolation (handles 0-360 wraparound)
         */
        lerpAngle(a, b, t) {
            let delta = b - a;
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;
            let result = a + delta * t;
            while (result < 0) result += 360;
            while (result >= 360) result -= 360;
            return result;
        }

        /**
         * Easing function for smooth transitions
         */
        easeInOutCubic(t) {
            return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }

        /**
         * Get debug info
         */
        getDebugInfo() {
            return {
                enabled: this.isEnabled,
                state: this.state,
                mode: this.currentMode,
                springPosition: this.positionSpring.position,
                springVelocity: this.positionSpring.velocity,
                bearing: this.bearingSpring.value,
                bearingVelocity: this.bearingSpring.velocity,
                pitch: this.pitchSpring.value,
                terrainFiltered: this.terrainFilter.getValue(),
                terrainRaw: this.terrainFilter.lastRawValue,
                transition: this.transition ? {
                    progress: this.transition.progress,
                    targetMode: this.transition.targetMode
                } : null
            };
        }
    }

    // Global unified camera controller instance
    let unifiedCameraController = null;

    /**
     * Get or create the unified camera controller
     */
    function getUnifiedCameraController() {
        if (!unifiedCameraController) {
            unifiedCameraController = new UnifiedCameraController();
        }
        return unifiedCameraController;
    }

    /**
     * Configuration for predictive camera system
     */
    const PredictiveCameraConfig = {
        sampleIntervalMeters: 20,    // Sample every 20m along path
        minSamples: 6,               // Minimum samples even at low speed
        maxSamples: 30,              // Cap for performance
        lookAheadSeconds: 12,        // How far ahead to sample (time-based limit)
        predictionTau: 6.0,          // Centroid time constant (seconds)
        cameraSpringOmega: 1.5,      // Camera spring frequency
        lookAtSpringOmega: 2.0,      // Look-at spring frequency (faster)
        riderCenterWeight: 0.65,     // Balance rider vs prediction in look-at (0=prediction, 1=rider)
        minLookAheadSeconds: 3.0,    // Minimum look-ahead even near route end
    };

    /**
     * Sample future positions along the route using distance-based intervals.
     * This ensures consistent path geometry coverage regardless of speed,
     * which is critical for the weighted centroid to properly average out zigzags.
     *
     * @param {number} currentDistanceKm - Current position along route (km)
     * @param {number} speedKmh - Current speed in km/h
     * @param {number} maxSeconds - Maximum look-ahead time
     * @returns {Array} - Array of { time, position, distanceAhead } samples
     */
    function sampleFuturePositions(currentDistanceKm, speedKmh, maxSeconds) {
        const samples = [];

        // Handle edge cases
        if (!routeData || speedKmh <= 0) {
            const currentPos = getPointAlongRoute(currentDistanceKm);
            if (currentPos) {
                samples.push({ time: 0, position: currentPos, distanceAhead: 0 });
            }
            return samples;
        }

        const config = PredictiveCameraConfig;
        const routeDistanceKm = totalDistance;

        // Calculate total look-ahead distance based on speed and time
        const lookAheadDistanceKm = (speedKmh / 3600) * maxSeconds;  // km
        const lookAheadDistanceM = lookAheadDistanceKm * 1000;       // meters

        // Determine sample count based on distance (not time) for consistent coverage
        const rawSampleCount = Math.ceil(lookAheadDistanceM / config.sampleIntervalMeters);
        const sampleCount = Math.max(config.minSamples, Math.min(rawSampleCount, config.maxSamples));

        // Sample at uniform distance intervals
        for (let i = 0; i < sampleCount; i++) {
            const fractionAhead = i / (sampleCount - 1);  // 0 to 1
            const distanceAheadKm = fractionAhead * lookAheadDistanceKm;
            const sampleDistanceKm = Math.min(
                currentDistanceKm + distanceAheadKm,
                routeDistanceKm - 0.001  // Stay slightly before end
            );

            // Calculate time to reach this point (for weighting)
            const timeToReach = speedKmh > 0 ? (distanceAheadKm * 3600) / speedKmh : 0;

            const position = getPointAlongRoute(sampleDistanceKm);
            if (position) {
                samples.push({
                    time: timeToReach,
                    position,
                    distanceAhead: distanceAheadKm * 1000  // meters
                });
            }
        }

        return samples;
    }

    /**
     * Compute weighted centroid of future positions using exponential decay.
     * This is the core algorithm that makes local path variations "invisible" -
     * zigzags and S-curves cancel out because we're averaging positions, not following a path.
     *
     * @param {Array} samples - Array of { time, position } from sampleFuturePositions
     * @param {number} tau - Time constant for exponential decay (seconds)
     * @returns {object} - Weighted centroid { lng, lat, alt }
     */
    function computeWeightedCentroid(samples, tau) {
        if (!samples || samples.length === 0) {
            return null;
        }

        if (samples.length === 1) {
            return { ...samples[0].position };
        }

        let totalWeight = 0;
        const weighted = { lng: 0, lat: 0, alt: 0 };

        for (const sample of samples) {
            // Exponential decay: weight = e^(-t/tau)
            // At t=0: weight=1.0, at t=tau: weight≈0.37, at t=2*tau: weight≈0.14
            const weight = Math.exp(-sample.time / tau);

            weighted.lng += sample.position.lng * weight;
            weighted.lat += sample.position.lat * weight;
            weighted.alt += sample.position.alt * weight;
            totalWeight += weight;
        }

        if (totalWeight === 0) {
            return { ...samples[0].position };
        }

        return {
            lng: weighted.lng / totalWeight,
            lat: weighted.lat / totalWeight,
            alt: weighted.alt / totalWeight
        };
    }

    /**
     * Calculate distance between two geographic points in meters
     */
    function haversineDistance(p1, p2) {
        const R = 6371000; // Earth radius in meters
        const lat1 = p1.lat * Math.PI / 180;
        const lat2 = p2.lat * Math.PI / 180;
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLng = (p2.lng - p1.lng) * Math.PI / 180;

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1) * Math.cos(lat2) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    /**
     * Predictive Camera Controller
     * Orchestrates the predictive camera system for all view modes.
     */
    class PredictiveCameraController {
        constructor() {
            this.config = PredictiveCameraConfig;

            // Springs for smooth camera movement
            this.cameraSpring = new CriticallyDampedSpring(this.config.cameraSpringOmega);
            this.lookAtSpring = new CriticallyDampedSpring(this.config.lookAtSpringOmega);

            // Cached prediction state
            this.lastPredictedTarget = null;
            this.lastSamples = null;

            // Mode tracking for resets
            this.lastMode = null;
        }

        /**
         * Update the predictive camera system
         * @param {object} riderPosition - Current rider { lng, lat, alt }
         * @param {number} riderDistanceKm - Distance along route in km
         * @param {number} speedKmh - Current speed in km/h
         * @param {string} mode - Camera mode (chase, birds_eye, side_view)
         * @param {number} deltaTime - Time since last frame in seconds
         * @returns {object} - { predictedTarget, cameraTarget, lookAtTarget, samples }
         */
        update(riderPosition, riderDistanceKm, speedKmh, mode, deltaTime) {
            // Reset springs on mode change
            if (mode !== this.lastMode) {
                this.cameraSpring.reset(null);
                this.lookAtSpring.reset(null);
                this.lastMode = mode;
            }

            // Calculate effective look-ahead based on remaining route
            const remainingKm = totalDistance - riderDistanceKm;
            const remainingSeconds = speedKmh > 0 ? (remainingKm * 3600) / speedKmh : 999;
            let effectiveLookAhead = Math.min(
                this.config.lookAheadSeconds,
                remainingSeconds * 0.8  // Don't look past 80% of remaining
            );
            effectiveLookAhead = Math.max(effectiveLookAhead, this.config.minLookAheadSeconds);

            // Sample future positions (distance-based for consistent coverage)
            const samples = sampleFuturePositions(riderDistanceKm, speedKmh, effectiveLookAhead);
            this.lastSamples = samples;

            if (samples.length === 0) {
                return {
                    predictedTarget: riderPosition,
                    cameraTarget: riderPosition,
                    lookAtTarget: riderPosition,
                    samples: []
                };
            }

            // Compute weighted centroid - this "sees through" path zigzags
            const tau = this.config.predictionTau;
            const predictedTarget = computeWeightedCentroid(samples, tau);
            this.lastPredictedTarget = predictedTarget;

            // Calculate look-at point: blend between prediction and rider
            // Higher riderCenterWeight keeps rider more centered
            const riderWeight = this.config.riderCenterWeight;
            const rawLookAt = {
                lng: lerp(predictedTarget.lng, riderPosition.lng, riderWeight),
                lat: lerp(predictedTarget.lat, riderPosition.lat, riderWeight),
                alt: lerp(predictedTarget.alt, riderPosition.alt, riderWeight)
            };

            // Apply spring smoothing to look-at target
            const smoothedLookAt = this.lookAtSpring.update(rawLookAt, deltaTime);

            return {
                predictedTarget,
                cameraTarget: predictedTarget,  // Mode-specific offset applied later
                lookAtTarget: smoothedLookAt,
                samples
            };
        }

        /**
         * Get the camera spring for external position smoothing
         */
        getCameraSpring() {
            return this.cameraSpring;
        }

        /**
         * Reset all state (for route changes, etc.)
         */
        reset() {
            this.cameraSpring.reset(null);
            this.lookAtSpring.reset(null);
            this.lastPredictedTarget = null;
            this.lastSamples = null;
            this.lastMode = null;
        }

        /**
         * Get debug info for visualization
         */
        getDebugInfo() {
            return {
                samples: this.lastSamples,
                predictedTarget: this.lastPredictedTarget,
                config: this.config
            };
        }
    }

    // Global predictive camera controller instance
    let predictiveCameraController = null;

    /**
     * Get or create the predictive camera controller
     */
    function getPredictiveCameraController() {
        if (!predictiveCameraController) {
            predictiveCameraController = new PredictiveCameraController();
        }
        return predictiveCameraController;
    }

    // =========================================================================
    // END PREDICTIVE CAMERA SYSTEM
    // =========================================================================

    // =========================================================================
    // CAMERA STATE RECORDER - Deterministic Replay & Panic Button
    // Records camera state in a ring buffer for debugging jitter issues.
    // When panic button is pressed, exports last 30 seconds of state that
    // can be replayed deterministically via Chrome MCP.
    // =========================================================================

    /**
     * Camera State Recorder
     * Records camera state in a ring buffer for deterministic replay.
     * Captures all state needed to reproduce camera behavior exactly.
     */
    class CameraStateRecorder {
        constructor(maxFrames = 1800) {  // 30 seconds at 60fps
            this.buffer = new Array(maxFrames);
            this.maxFrames = maxFrames;
            this.writeIndex = 0;
            this.frameCount = 0;
            this.startTime = performance.now();
            this.pendingInputEvents = [];  // Events to record with next frame
            this.isEnabled = true;  // Recording enabled by default
            this._currentTerrainQuery = null;  // Terrain value for current frame
            this._lastRecordTime = 0;  // For calculating actual fps
        }

        /**
         * Record a single frame of camera state
         * Called at the end of each updateCamera() call
         */
        recordFrame(frameData) {
            if (!this.isEnabled) return;

            const now = performance.now();
            const frame = {
                // Timing
                frameNumber: this.frameCount,
                timestamp: now - this.startTime,
                deltaTime: frameData.deltaTime,
                actualDeltaTime: this._lastRecordTime > 0 ? (now - this._lastRecordTime) / 1000 : frameData.deltaTime,

                // Route position
                progress: frameData.progress,
                distanceKm: frameData.progress * totalDistance,

                // Rider position (raw, before smoothing)
                riderPosition: frameData.riderPosition ? {
                    lng: frameData.riderPosition.lng,
                    lat: frameData.riderPosition.lat,
                    alt: frameData.riderPosition.alt
                } : null,

                // Camera position (final, after all smoothing)
                cameraPosition: frameData.cameraPosition ? {
                    lng: frameData.cameraPosition.lng,
                    lat: frameData.cameraPosition.lat,
                    alt: frameData.cameraPosition.alt
                } : null,

                // Camera orientation
                cameraBearing: frameData.bearing,
                cameraPitch: frameData.pitch,

                // External input (for determinism)
                terrainElevation: this._currentTerrainQuery,

                // Mode state
                mode: frameData.mode,
                targetMode: targetCameraMode,
                modeTransitionProgress: modeTransitionProgress,

                // User settings
                zoomLevel: frameData.zoomLevel,
                chaseCamPitch: chaseCamPitch,
                speedMultiplier: speedMultiplier,
                isPlaying: isPlaying,

                // Spring state (for verification)
                springState: this._captureSpringState(),

                // Smoothing state
                riderSmoothState: window._riderSmoothState ? { ...window._riderSmoothState } : null,
                cameraSmoothState: window._cameraSmoothState ? { ...window._cameraSmoothState } : null,

                // Input events that occurred this frame
                inputEvents: [...this.pendingInputEvents]
            };

            this.buffer[this.writeIndex] = frame;
            this.writeIndex = (this.writeIndex + 1) % this.maxFrames;
            this.frameCount++;
            this.pendingInputEvents = [];  // Clear for next frame
            this._currentTerrainQuery = null;  // Reset terrain query
            this._lastRecordTime = now;
        }

        /**
         * Record terrain query result (called from queryTerrainElevationWithCache)
         */
        recordTerrainQuery(elevation) {
            this._currentTerrainQuery = elevation;
        }

        /**
         * Record a user input event
         * Called from event handlers (seek, mode change, zoom, etc.)
         */
        recordInput(eventType, value) {
            if (!this.isEnabled) return;

            this.pendingInputEvents.push({
                type: eventType,
                value: value,
                timestamp: performance.now() - this.startTime
            });
        }

        /**
         * Capture current spring state for verification
         */
        _captureSpringState() {
            const state = {};

            if (predictiveCameraController) {
                const cameraSpring = predictiveCameraController.getCameraSpring();
                if (cameraSpring.position) {
                    state.cameraPosition = { ...cameraSpring.position };
                    state.cameraVelocity = { ...cameraSpring.velocity };
                }

                const lookAtSpring = predictiveCameraController.lookAtSpring;
                if (lookAtSpring && lookAtSpring.position) {
                    state.lookAtPosition = { ...lookAtSpring.position };
                    state.lookAtVelocity = { ...lookAtSpring.velocity };
                }
            }

            if (unifiedCameraController && unifiedCameraController.isEnabled) {
                const pos = unifiedCameraController.positionSpring;
                if (pos.position) {
                    state.unifiedPosition = { ...pos.position };
                    state.unifiedVelocity = { ...pos.velocity };
                }
                state.unifiedBearing = unifiedCameraController.bearingState.value;
                state.unifiedBearingVelocity = unifiedCameraController.bearingState.velocity;
            }

            return state;
        }

        /**
         * Export last N seconds of state for replay
         */
        export(seconds = 30) {
            const framesToExport = Math.min(
                this.frameCount,
                Math.ceil(seconds * 60)  // Target 60fps
            );

            const frames = [];
            let index = (this.writeIndex - framesToExport + this.maxFrames) % this.maxFrames;

            for (let i = 0; i < framesToExport; i++) {
                if (this.buffer[index]) {
                    frames.push(this.buffer[index]);
                }
                index = (index + 1) % this.maxFrames;
            }

            // Calculate actual FPS from frames
            let avgFps = 60;
            if (frames.length > 1) {
                const duration = frames[frames.length - 1].timestamp - frames[0].timestamp;
                if (duration > 0) {
                    avgFps = (frames.length - 1) / (duration / 1000);
                }
            }

            return {
                version: '1.0',
                capturedAt: new Date().toISOString(),
                routeFile: routeData?.filename || getRouteFromUrl(),
                totalDistance: totalDistance,
                frameCaptured: frames.length,
                durationMs: frames.length > 0 ? frames[frames.length - 1].timestamp - frames[0].timestamp : 0,
                avgFps: avgFps.toFixed(1),

                config: {
                    predictiveEnabled: isPredictiveCameraEnabled(),
                    unifiedControllerEnabled: unifiedCameraController?.isEnabled || false,
                    cameraModeConfig: CameraModeConfig
                },

                browser: {
                    userAgent: navigator.userAgent,
                    screenSize: { w: window.innerWidth, h: window.innerHeight },
                    devicePixelRatio: window.devicePixelRatio
                },

                // Diagnostic data at moment of capture
                diagnostics: {
                    chaosDebugData: window._chaosDebugData ? { ...window._chaosDebugData } : null,
                    terrainCache: window._terrainCache ? { ...window._terrainCache } : null,
                    sideViewState: {
                        bearingState: window._sideViewBearingState,
                        currentSide: window._sideViewCurrentSide,
                        lastSwitchTime: window._sideViewLastSwitchTime
                    },
                    adaptiveSmoothing: {
                        seekTimestamp: _seekTimestamp,
                        seekDistance: _seekDistance,
                        timeSinceSeek: performance.now() - _seekTimestamp
                    }
                },

                frames: frames
            };
        }

        /**
         * Get recording statistics
         */
        getStats() {
            const bufferedFrames = Math.min(this.frameCount, this.maxFrames);
            const oldestFrame = this.buffer[(this.writeIndex - bufferedFrames + this.maxFrames) % this.maxFrames];
            const newestFrame = this.buffer[(this.writeIndex - 1 + this.maxFrames) % this.maxFrames];

            return {
                isEnabled: this.isEnabled,
                frameCount: this.frameCount,
                bufferedFrames: bufferedFrames,
                bufferCapacity: this.maxFrames,
                bufferUsagePercent: ((bufferedFrames / this.maxFrames) * 100).toFixed(1),
                oldestTimestamp: oldestFrame?.timestamp || 0,
                newestTimestamp: newestFrame?.timestamp || 0,
                bufferedDurationSec: newestFrame && oldestFrame ?
                    ((newestFrame.timestamp - oldestFrame.timestamp) / 1000).toFixed(1) : 0
            };
        }

        /**
         * Clear all recorded state
         */
        clear() {
            this.buffer = new Array(this.maxFrames);
            this.writeIndex = 0;
            this.frameCount = 0;
            this.startTime = performance.now();
            this.pendingInputEvents = [];
            this._currentTerrainQuery = null;
            this._lastRecordTime = 0;
        }

        /**
         * Enable/disable recording
         */
        setEnabled(enabled) {
            this.isEnabled = enabled;
            if (enabled && this.frameCount === 0) {
                this.startTime = performance.now();
            }
        }
    }

    // Global state recorder instance
    let stateRecorder = null;

    /**
     * Get or create the state recorder
     */
    function getStateRecorder() {
        if (!stateRecorder) {
            stateRecorder = new CameraStateRecorder();
        }
        return stateRecorder;
    }

    /**
     * Get route from URL parameters
     */
    function getRouteFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('route') || 'unknown';
    }

    /**
     * Panic button handler - captures camera state for debugging
     */
    function onPanicButton() {
        // Pause animation immediately
        if (isPlaying) {
            togglePlay();
        }

        // Capture state
        const recorder = getStateRecorder();
        const capturedState = recorder.export(30);

        // Serialize to JSON
        const json = JSON.stringify(capturedState, null, 2);

        // Show capture modal
        showPanicCaptureModal(json, capturedState);

        console.log('[PANIC] Camera state captured:', capturedState.frameCaptured, 'frames,',
            (capturedState.durationMs / 1000).toFixed(1), 'seconds');
    }

    /**
     * Show modal with captured state
     */
    function showPanicCaptureModal(json, capturedState) {
        // Remove existing modal if any
        const existing = document.getElementById('panic-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'panic-modal';
        modal.className = 'panic-modal';
        modal.innerHTML = `
            <div class="panic-overlay" onclick="closePanicModal()"></div>
            <div class="panic-content">
                <h2>Camera State Captured</h2>
                <div class="panic-stats">
                    <span><strong>${capturedState.frameCaptured}</strong> frames</span>
                    <span><strong>${(capturedState.durationMs / 1000).toFixed(1)}s</strong> duration</span>
                    <span><strong>${capturedState.avgFps}</strong> fps</span>
                    <span><strong>${(json.length / 1024).toFixed(1)}KB</strong> size</span>
                </div>
                <p>Copy this state and paste to Claude Code for analysis:</p>
                <textarea id="panic-json" readonly>${json}</textarea>
                <div class="panic-actions">
                    <button onclick="copyPanicState()" class="panic-btn panic-btn-primary">
                        Copy to Clipboard
                    </button>
                    <button onclick="downloadPanicState()" class="panic-btn">
                        Download JSON
                    </button>
                    <button onclick="closePanicModal()" class="panic-btn">
                        Close
                    </button>
                </div>
                <p class="panic-hint">
                    In Claude Code, say: <em>"Analyze this camera state capture and
                    reproduce the jitter using Chrome MCP"</em>
                </p>
            </div>
        `;

        // Add styles if not already present
        if (!document.getElementById('panic-styles')) {
            const styles = document.createElement('style');
            styles.id = 'panic-styles';
            styles.textContent = `
                .panic-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .panic-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.8);
                }
                .panic-content {
                    position: relative;
                    background: #1a1a2e;
                    border: 1px solid #e6b800;
                    border-radius: 8px;
                    padding: 24px;
                    max-width: 800px;
                    width: 90%;
                    max-height: 80vh;
                    overflow-y: auto;
                    color: #fff;
                    font-family: system-ui, -apple-system, sans-serif;
                }
                .panic-content h2 {
                    margin: 0 0 16px 0;
                    color: #e6b800;
                }
                .panic-stats {
                    display: flex;
                    gap: 16px;
                    margin-bottom: 16px;
                    padding: 12px;
                    background: rgba(230, 184, 0, 0.1);
                    border-radius: 4px;
                }
                .panic-stats span {
                    font-size: 14px;
                }
                .panic-content p {
                    margin: 0 0 12px 0;
                    color: #ccc;
                }
                .panic-content textarea {
                    width: 100%;
                    height: 200px;
                    background: #0d0d1a;
                    border: 1px solid #333;
                    border-radius: 4px;
                    color: #0f0;
                    font-family: monospace;
                    font-size: 11px;
                    padding: 12px;
                    resize: vertical;
                }
                .panic-actions {
                    display: flex;
                    gap: 12px;
                    margin-top: 16px;
                }
                .panic-btn {
                    padding: 10px 20px;
                    border: 1px solid #e6b800;
                    background: transparent;
                    color: #e6b800;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                    transition: all 0.2s;
                }
                .panic-btn:hover {
                    background: rgba(230, 184, 0, 0.1);
                }
                .panic-btn-primary {
                    background: #e6b800;
                    color: #1a1a2e;
                }
                .panic-btn-primary:hover {
                    background: #ffd700;
                }
                .panic-hint {
                    margin-top: 16px !important;
                    font-size: 13px;
                    color: #888 !important;
                }
                .panic-hint em {
                    color: #aaa;
                    font-style: normal;
                    background: rgba(255,255,255,0.1);
                    padding: 2px 6px;
                    border-radius: 3px;
                }
            `;
            document.head.appendChild(styles);
        }

        document.body.appendChild(modal);

        // Global functions for modal buttons
        window.copyPanicState = function() {
            const textarea = document.getElementById('panic-json');
            textarea.select();
            document.execCommand('copy');
            // Also try modern API
            navigator.clipboard?.writeText(textarea.value);
            const btn = document.querySelector('.panic-btn-primary');
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy to Clipboard', 2000);
        };

        window.downloadPanicState = function() {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `camera-state-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };

        window.closePanicModal = function() {
            const modal = document.getElementById('panic-modal');
            if (modal) modal.remove();
        };

        // Close on Escape key
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closePanicModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    // =========================================================================
    // END CAMERA STATE RECORDER
    // =========================================================================

    /**
     * Calculate camera state for a given mode
     * @param {string} mode - Camera mode
     * @param {object} dotPoint - Current rider position
     * @param {object} nextPoint - Look-ahead point for bearing
     * @param {number} deltaTime - Time since last frame
     * @param {boolean} skipSmoothing - Skip cache-based smoothing (use during lerp transitions)
     */
    function calculateCameraForMode(mode, dotPoint, nextPoint, deltaTime, skipSmoothing = false, predictiveData = null) {
        if (!dotPoint || !nextPoint) return null;

        const config = CameraModeConfig[mode];
        const forwardBearing = calculateBearing(dotPoint, nextPoint);

        // Apply zoom level to all camera distances
        const zoom = zoomLevel;

        // Check if we're using the predictive camera system
        const usePredictive = isPredictiveCameraEnabled() && predictiveData &&
            (mode === CameraModes.CHASE || mode === CameraModes.BIRDS_EYE || mode === CameraModes.SIDE_VIEW);

        // UNIVERSAL RIDER POSITION SMOOTHING
        // Apply exponential smoothing to rider position for all modes except cinematic
        // (cinematic has its own specialized smoothing). This eliminates micro-jitter
        // from turf.along interpolation and altitude calculations.
        let smoothedDotPoint = dotPoint;
        if (mode !== CameraModes.CINEMATIC && !skipSmoothing) {
            const state = getOrInitSmoothState('_riderSmoothState', dotPoint, mode);
            const alpha = getRiderSmoothingAlpha(mode);
            smoothedDotPoint = applySmoothPosition(state, dotPoint, alpha);

            // Debug: Log significant rider smoothing lag after seeks
            if (window.FLYOVER_DEBUG && window._seekDebugFrameCount > 0) {
                const dLng = (dotPoint.lng - smoothedDotPoint.lng) * 111320 * Math.cos(dotPoint.lat * Math.PI / 180);
                const dLat = (dotPoint.lat - smoothedDotPoint.lat) * 111320;
                const riderLag = Math.sqrt(dLng * dLng + dLat * dLat);
                if (riderLag > 10) {
                    console.log('[SEEK DEBUG] RIDER LAG: ' + Math.round(riderLag) + 'm');
                }
            }
        }

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

                // PREDICTIVE CAMERA: Position camera based on predicted target direction
                // This makes the camera anticipate direction changes instead of reacting
                // The predicted target already has local variations averaged out
                let basePoint = smoothedDotPoint;
                if (usePredictive && predictiveData && predictiveData.lookAtTarget) {
                    // Blend between rider and look-at target for camera base position
                    // This creates a "pulling" effect toward the predicted direction
                    const blendFactor = 0.3;  // 30% toward predicted, 70% rider
                    basePoint = {
                        lng: lerp(smoothedDotPoint.lng, predictiveData.lookAtTarget.lng, blendFactor),
                        lat: lerp(smoothedDotPoint.lat, predictiveData.lookAtTarget.lat, blendFactor),
                        alt: lerp(smoothedDotPoint.alt, predictiveData.lookAtTarget.alt, blendFactor)
                    };
                }

                const offsetPoint = turf.destination(
                    turf.point([basePoint.lng, basePoint.lat]),
                    offsetBehind / 1000,
                    behindBearing,
                    { units: 'kilometers' }
                );

                let idealCameraPos = {
                    lng: offsetPoint.geometry.coordinates[0],
                    lat: offsetPoint.geometry.coordinates[1],
                    // Use calculated altitude based on pitch, plus terrain following
                    alt: basePoint.alt + calculatedAltitude + (basePoint.alt * 0.1)
                };

                // PREDICTIVE CAMERA: Apply critically damped spring smoothing
                // This replaces the multiple exponential smoothing layers with a single,
                // physics-based smoothing system that naturally handles all variations
                if (usePredictive && predictiveData && !skipSmoothing) {
                    const spring = getPredictiveCameraController().getCameraSpring();
                    const smoothedPos = spring.update(idealCameraPos, deltaTime);

                    // Debug: Log significant spring lag after seeks
                    if (window.FLYOVER_DEBUG && window._seekDebugFrameCount > 0) {
                        const dLng = (idealCameraPos.lng - smoothedPos.lng) * 111320 * Math.cos(idealCameraPos.lat * Math.PI / 180);
                        const dLat = (idealCameraPos.lat - smoothedPos.lat) * 111320;
                        const springLag = Math.sqrt(dLng * dLng + dLat * dLat);
                        if (springLag > 10) {
                            console.log('[SEEK DEBUG] SPRING LAG: ' + Math.round(springLag) + 'm');
                        }
                    }

                    // CHAOS DEBUG: Log spring state in chase mode
                    if (window.CAMERA_CHAOS_DEBUG) {
                        const currentKm = progress * totalDistance;
                        const inProblemZone = currentKm >= 50 && currentKm <= 53;
                        if (inProblemZone) {
                            const dLng = (idealCameraPos.lng - smoothedPos.lng) * 111320 * Math.cos(idealCameraPos.lat * Math.PI / 180);
                            const dLat = (idealCameraPos.lat - smoothedPos.lat) * 111320;
                            const springLag = Math.sqrt(dLng * dLng + dLat * dLat);
                            console.log(`[CHAOS CHASE] km=${currentKm.toFixed(2)} | forwardBearing=${forwardBearing.toFixed(1)}° | ` +
                                `behindBearing=${behindBearing.toFixed(1)}° | offsetBehind=${offsetBehind.toFixed(0)}m | ` +
                                `idealAlt=${idealCameraPos.alt.toFixed(0)}m | smoothedAlt=${smoothedPos.alt.toFixed(0)}m | ` +
                                `springLag=${springLag.toFixed(0)}m | springVel=(${spring.velocity.lng.toFixed(6)},${spring.velocity.lat.toFixed(6)},${spring.velocity.alt.toFixed(2)})`);
                        }
                    }

                    cameraLng = smoothedPos.lng;
                    cameraLat = smoothedPos.lat;
                    cameraAlt = smoothedPos.alt;
                } else {
                    cameraLng = idealCameraPos.lng;
                    cameraLat = idealCameraPos.lat;
                    cameraAlt = idealCameraPos.alt;
                }

                cameraBearing = forwardBearing;
                cameraPitch = chaseCamPitch;
                break;
            }

            case CameraModes.BIRDS_EYE: {
                // Bird's eye: nearly above, looking down at the dot
                // Position directly above for maximum smoothness (no bearing-dependent offset)
                // Small fixed south offset avoids gimbal lock with lookAtPoint
                const offsetUp = config.offsetUp * zoom;

                // PREDICTIVE CAMERA: Use predicted target for more stable bearing
                // In bird's eye, rotation stability is more important than position
                let basePoint = smoothedDotPoint;
                if (usePredictive && predictiveData && predictiveData.lookAtTarget) {
                    // Small blend toward predicted target for smoother position
                    const blendFactor = 0.2;  // 20% toward predicted
                    basePoint = {
                        lng: lerp(smoothedDotPoint.lng, predictiveData.lookAtTarget.lng, blendFactor),
                        lat: lerp(smoothedDotPoint.lat, predictiveData.lookAtTarget.lat, blendFactor),
                        alt: lerp(smoothedDotPoint.alt, predictiveData.lookAtTarget.alt, blendFactor)
                    };
                }

                const southOffset = turf.destination(
                    turf.point([basePoint.lng, basePoint.lat]),
                    0.03 * zoom, // Small fixed offset south (not bearing-dependent)
                    180, // Always south - no position jumps when bearing changes
                    { units: 'kilometers' }
                );

                let idealCameraPos = {
                    lng: southOffset.geometry.coordinates[0],
                    lat: southOffset.geometry.coordinates[1],
                    alt: basePoint.alt + offsetUp
                };

                // PREDICTIVE CAMERA: Apply spring smoothing
                if (usePredictive && predictiveData && !skipSmoothing) {
                    const spring = getPredictiveCameraController().getCameraSpring();
                    const smoothedPos = spring.update(idealCameraPos, deltaTime);
                    cameraLng = smoothedPos.lng;
                    cameraLat = smoothedPos.lat;
                    cameraAlt = smoothedPos.alt;
                } else {
                    cameraLng = idealCameraPos.lng;
                    cameraLat = idealCameraPos.lat;
                    cameraAlt = idealCameraPos.alt;
                }

                cameraBearing = forwardBearing; // Already uses predicted target for bearing
                cameraPitch = config.pitch;
                break;
            }

            case CameraModes.SIDE_VIEW: {
                // Side view: perpendicular to route direction
                // Intelligently chooses the lower terrain side (valley) or uses manual override
                // Uses hysteresis to prevent flip-flopping between sides
                // Falls back to bird's eye if both sides are blocked by terrain
                const offsetSide = config.offsetSide * zoom;
                const offsetUp = config.offsetUp * zoom;

                // Smooth the forward bearing for side view to prevent camera position swings
                // This is critical because side view camera position is perpendicular to bearing,
                // so small bearing changes cause large lateral position shifts
                if (!window._sideViewBearingState) {
                    window._sideViewBearingState = { bearing: forwardBearing };
                }
                // Exponential smoothing on bearing (handle 360 wraparound)
                const BEARING_ALPHA = 0.02; // Very aggressive smoothing for bearing
                const delta = bearingDelta(forwardBearing, window._sideViewBearingState.bearing);
                window._sideViewBearingState.bearing = normalizeBearing(
                    window._sideViewBearingState.bearing + BEARING_ALPHA * delta
                );
                const smoothedForwardBearing = window._sideViewBearingState.bearing;

                // Calculate both potential side positions using smoothed bearing
                const leftBearing = (smoothedForwardBearing + 90) % 360;
                const rightBearing = (smoothedForwardBearing - 90 + 360) % 360;

                const leftPoint = turf.destination(
                    turf.point([smoothedDotPoint.lng, smoothedDotPoint.lat]),
                    offsetSide / 1000,
                    leftBearing,
                    { units: 'kilometers' }
                );
                const rightPoint = turf.destination(
                    turf.point([smoothedDotPoint.lng, smoothedDotPoint.lat]),
                    offsetSide / 1000,
                    rightBearing,
                    { units: 'kilometers' }
                );

                // Check if either side position would put camera inside terrain
                // Camera would be at smoothedDotPoint.alt + offsetUp - check against terrain at each side
                const targetCameraAlt = smoothedDotPoint.alt + offsetUp;
                const MIN_SIDE_CLEARANCE = 100; // meters - minimum clearance needed for side view to work
                let leftBlocked = false;
                let rightBlocked = false;
                let leftTerrainElevation = null;
                let rightTerrainElevation = null;

                try {
                    leftTerrainElevation = map.queryTerrainElevation(leftPoint.geometry.coordinates);
                    rightTerrainElevation = map.queryTerrainElevation(rightPoint.geometry.coordinates);

                    if (leftTerrainElevation !== null) {
                        leftBlocked = targetCameraAlt < leftTerrainElevation + MIN_SIDE_CLEARANCE;
                    }
                    if (rightTerrainElevation !== null) {
                        rightBlocked = targetCameraAlt < rightTerrainElevation + MIN_SIDE_CLEARANCE;
                    }
                } catch (e) {
                    // Terrain query failed - continue without blocking info
                }

                // If both sides are blocked, choose the less-blocked side and let terrain
                // collision handling raise the camera appropriately. Don't jump to bird's eye
                // as that creates jarring pitch and position changes.
                // Pick the side with lower terrain (more clearance potential)
                if (leftBlocked && rightBlocked) {
                    if (leftTerrainElevation !== null && rightTerrainElevation !== null) {
                        // Pick the side with lower terrain
                        if (leftTerrainElevation <= rightTerrainElevation) {
                            leftBlocked = false; // Force left side
                        } else {
                            rightBlocked = false; // Force right side
                        }
                    } else {
                        // No terrain data - default to left
                        leftBlocked = false;
                    }
                }

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
                    // Force left side (+90°) - but if blocked, use right
                    chosenSide = leftBlocked ? 'right' : 'left';
                } else if (sideViewMode === SideViewModes.RIGHT) {
                    // Force right side (-90°) - but if blocked, use left
                    chosenSide = rightBlocked ? 'left' : 'right';
                } else {
                    // Auto mode: query terrain on both sides and pick the lower one
                    // Only switch sides if the other side is significantly lower (hysteresis)
                    // AND stays better for at least LOOK_AHEAD_DISTANCE (prevents flip-flop on hairpins)
                    // AND enough time has passed since last switch (cooldown)
                    // EXCEPTION: immediately switch if current side is blocked and other isn't
                    const SIDE_SWITCH_THRESHOLD = 200; // meters - must be this much lower to switch (increased for stability)
                    const LOOK_AHEAD_DISTANCE = 500; // meters - check terrain this far ahead (increased)
                    const LOOK_AHEAD_SAMPLES = 5; // number of points to check ahead (increased)
                    const SIDE_SWITCH_COOLDOWN = 3000; // ms - minimum time between side switches

                    // Use the terrain elevations we already queried above
                    const leftTerrain = leftTerrainElevation;
                    const rightTerrain = rightTerrainElevation;
                    const now = performance.now();
                    const timeSinceLastSwitch = now - window._sideViewLastSwitchTime;

                    // First priority: if current side is blocked and other isn't, switch immediately
                    const currentSide = window._sideViewCurrentSide;
                    const currentBlocked = currentSide === 'left' ? leftBlocked : rightBlocked;
                    const otherBlocked = currentSide === 'left' ? rightBlocked : leftBlocked;

                    if (currentBlocked && !otherBlocked) {
                        // Current side is blocked, other is clear - switch immediately (ignore cooldown)
                        chosenSide = currentSide === 'left' ? 'right' : 'left';
                    } else if (leftTerrain !== null && rightTerrain !== null) {
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
                                    offsetSide / 1000,
                                    aheadLeftBearing,
                                    { units: 'kilometers' }
                                );
                                const aheadRightPoint = turf.destination(
                                    turf.point([aheadPoint.lng, aheadPoint.lat]),
                                    offsetSide / 1000,
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

                // PREDICTIVE CAMERA: Apply spring smoothing for side view
                // Side view benefits greatly from predictive smoothing because it's sensitive
                // to bearing changes (camera position is perpendicular to direction of travel)
                let idealCameraPos = {
                    lng: offsetPoint.geometry.coordinates[0],
                    lat: offsetPoint.geometry.coordinates[1],
                    alt: smoothedDotPoint.alt + offsetUp
                };

                if (usePredictive && predictiveData && !skipSmoothing) {
                    const spring = getPredictiveCameraController().getCameraSpring();
                    const smoothedPos = spring.update(idealCameraPos, deltaTime);
                    cameraLng = smoothedPos.lng;
                    cameraLat = smoothedPos.lat;
                    cameraAlt = smoothedPos.alt;
                } else {
                    cameraLng = idealCameraPos.lng;
                    cameraLat = idealCameraPos.lat;
                    cameraAlt = idealCameraPos.alt;
                }

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

                // For high zoom cinematic, smooth the rider position to eliminate any micro-jitter
                // from turf.along or altitude interpolation. Use exponential smoothing which is
                // mathematically stable and cannot oscillate.
                let smoothedDot = dotPoint;
                if (zoomLevel >= 2.0) {
                    if (!window._cinematicState) {
                        window._cinematicState = {
                            lng: dotPoint.lng,
                            lat: dotPoint.lat,
                            alt: dotPoint.alt
                        };
                    }
                    // Exponential smoothing: new = old + alpha * (target - old)
                    // Very low alpha (0.03) for aggressive smoothing - at 60fps this gives
                    // a time constant of about 0.5 seconds, filtering out any high-frequency jitter
                    const alpha = 0.03;
                    window._cinematicState.lng += alpha * (dotPoint.lng - window._cinematicState.lng);
                    window._cinematicState.lat += alpha * (dotPoint.lat - window._cinematicState.lat);
                    window._cinematicState.alt += alpha * (dotPoint.alt - window._cinematicState.alt);
                    smoothedDot = window._cinematicState;
                }

                if (deltaTime) {
                    cinematicAngle += config.orbitSpeed * deltaTime;
                    // Normalize angle to prevent precision issues with very large values
                    // Keep it in the range [0, 2*PI)
                    if (cinematicAngle >= 2 * Math.PI) {
                        cinematicAngle -= 2 * Math.PI;
                    }
                }
                const orbitBearing = (cinematicAngle * 180 / Math.PI) % 360;

                // Use simple trigonometric offset instead of turf.destination for more stable results
                // At the scale of 900m orbit radius, the spherical Earth approximation error is negligible
                // Convert orbit radius from meters to degrees (approximate)
                const metersPerDegreeLat = 111320; // meters per degree latitude
                const metersPerDegreeLng = 111320 * Math.cos(smoothedDot.lat * Math.PI / 180);

                // Calculate offset in degrees using simple trig
                const bearingRad = orbitBearing * Math.PI / 180;
                const dLat = (orbitRadius * Math.cos(bearingRad)) / metersPerDegreeLat;
                const dLng = (orbitRadius * Math.sin(bearingRad)) / metersPerDegreeLng;

                let rawCameraLng = smoothedDot.lng + dLng;
                let rawCameraLat = smoothedDot.lat + dLat;

                // Vary height sinusoidally above the smoothed rider position
                const heightT = (Math.sin(cinematicAngle * 0.5) + 1) / 2;
                let rawCameraAlt = smoothedDot.alt + lerp(heightMin, heightMax, heightT);

                // Apply exponential smoothing to camera position as well
                // This smooths out any discontinuities from turf.destination or altitude calculation
                if (zoomLevel >= 2.0) {
                    if (!window._cinematicCameraPos) {
                        window._cinematicCameraPos = {
                            lng: rawCameraLng,
                            lat: rawCameraLat,
                            alt: rawCameraAlt
                        };
                    }
                    const camAlpha = 0.08; // Slightly faster than rider smoothing
                    window._cinematicCameraPos.lng += camAlpha * (rawCameraLng - window._cinematicCameraPos.lng);
                    window._cinematicCameraPos.lat += camAlpha * (rawCameraLat - window._cinematicCameraPos.lat);
                    window._cinematicCameraPos.alt += camAlpha * (rawCameraAlt - window._cinematicCameraPos.alt);
                    cameraLng = window._cinematicCameraPos.lng;
                    cameraLat = window._cinematicCameraPos.lat;
                    cameraAlt = window._cinematicCameraPos.alt;
                } else {
                    cameraLng = rawCameraLng;
                    cameraLat = rawCameraLat;
                    cameraAlt = rawCameraAlt;
                }

                // Look at the smoothed dot - bearing points back toward the rider
                cameraBearing = (orbitBearing + 180) % 360;
                // Pitch is computed by lookAtPoint based on camera position and target altitude
                // We store a nominal value for state tracking
                const pitchT = (Math.sin(cinematicAngle * 0.3) + 1) / 2;
                cameraPitch = lerp(config.pitchMin, config.pitchMax, pitchT);
                break;
            }

            default:
                return null;
        }

        // Terrain collision detection: ensure camera is above terrain and rider
        let terrainAdjusted = false;

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

        // Track if we recently exited a transition (for faster terrain correction)
        if (!window._terrainCache.transitionExitFrames) {
            window._terrainCache.transitionExitFrames = 0;
        }
        // Track frames since terrain data became available (for faster smoothing)
        if (!window._terrainCache.terrainAvailableFrames) {
            window._terrainCache.terrainAvailableFrames = 0;
        }

        if (useSimplifiedCollision) {
            window._terrainCache.wasInTransition = true;
            window._terrainCache.transitionExitFrames = 0;
        } else if (window._terrainCache.wasInTransition) {
            // Just exited transition - start faster smoothing period
            window._terrainCache.wasInTransition = false;
            window._terrainCache.transitionExitFrames = 30; // ~0.5 sec at 60fps
        } else if (window._terrainCache.transitionExitFrames > 0) {
            window._terrainCache.transitionExitFrames--;
        }

        const justExitedTransition = window._terrainCache.transitionExitFrames > 0;

        if (settlingFramesRemaining > 0) {
            settlingFramesRemaining--;
        }

        // Query terrain elevation (used for collision and logging)
        // Skip terrain query entirely for cinematic mode at high zoom - the camera is 300m+
        // above the rider, so terrain collision is unnecessary. This eliminates jitter from
        // varying terrain queries as the camera orbits over different terrain.
        let terrainElevation = null;
        const isCinematicHighZoom = mode === CameraModes.CINEMATIC && zoomLevel >= 2.0;
        if (!useSimplifiedCollision && !isCinematicHighZoom) {
            // Query terrain at camera position for collision detection
            terrainElevation = queryTerrainElevationWithCache(cameraLng, cameraLat);
        }

        // Detect when terrain data becomes available after being unavailable
        // This can cause large altitude jumps that need faster smoothing
        const hadTerrainBefore = window._terrainCache.hadTerrainData === true;
        const hasTerrainNow = terrainElevation !== null;

        if (!useSimplifiedCollision) {
            if (!hadTerrainBefore && hasTerrainNow) {
                // Terrain just became available - start faster smoothing period
                window._terrainCache.terrainAvailableFrames = 30; // ~0.5 sec at 60fps
                if (window.FLYOVER_DEBUG) {
                    console.log('[TERRAIN] Data became available, enabling faster smoothing');
                }
            } else if (hadTerrainBefore && !hasTerrainNow) {
                // TERRAIN JUST BECAME UNAVAILABLE
                // When terrain tiles unload, the camera altitude shouldn't drop instantly.
                // Use the last known terrain-adjusted altitude as a floor to prevent jitter.
                // This is stored in lastCameraAlt from the previous frame's smoothing.
                if (window._terrainCache.lastCameraAlt !== null) {
                    // Store this as the terrain-unavailable floor
                    window._terrainCache.terrainUnavailableFloor = window._terrainCache.lastCameraAlt;
                    if (window.FLYOVER_DEBUG) {
                        console.log('[TERRAIN] Data became unavailable, using floor altitude:', window._terrainCache.terrainUnavailableFloor.toFixed(1));
                    }
                }
            } else if (hasTerrainNow) {
                // Terrain is available - clear any unavailable floor
                window._terrainCache.terrainUnavailableFloor = null;
            }
            if (window._terrainCache.terrainAvailableFrames > 0) {
                window._terrainCache.terrainAvailableFrames--;
            }
            window._terrainCache.hadTerrainData = hasTerrainNow;
        }

        const terrainJustBecameAvailable = window._terrainCache.terrainAvailableFrames > 0;

        // Store original altitude for logging before terrain collision adjustment
        const originalCameraAlt = cameraAlt;

        if (useSimplifiedCollision || isCinematicHighZoom) {
            // Simplified collision: only ensure camera is above rider.
            // Used during transitions (useSimplifiedCollision) and for cinematic mode at high zoom.
            // For cinematic at zoom ≥2.0, the camera is 300m+ above the rider, so terrain
            // collision is unnecessary. Skipping it eliminates jitter from varying terrain queries.
            const minFromRider = dotPoint.alt + RIDER_MIN_CLEARANCE;
            if (cameraAlt < minFromRider) {
                cameraAlt = minFromRider;
                terrainAdjusted = true;
            }
        } else {
            // Full terrain collision using helper
            let minAltitude = calculateMinimumAltitude(terrainElevation, dotPoint.alt);

            // TERRAIN UNAVAILABLE FLOOR ENFORCEMENT
            // When terrain becomes null (tiles unloaded), use the stored floor altitude
            // to prevent the camera from dropping below where it was when terrain was available.
            // This eliminates the jitter caused by terrain tile loading/unloading.
            if (terrainElevation === null && window._terrainCache.terrainUnavailableFloor) {
                minAltitude = Math.max(minAltitude, window._terrainCache.terrainUnavailableFloor);
            }

            if (cameraAlt < minAltitude) {
                cameraAlt = minAltitude;
                terrainAdjusted = true;
            }
        }

        // SYNC SPRING WITH TERRAIN COLLISION
        // When terrain collision adjusts altitude, update the predictive camera spring
        // so it doesn't have a mismatch between its internal state and the actual camera.
        // Without this, when terrain becomes null (tiles unloaded), the spring's lower
        // altitude gets used, causing a visible altitude drop.
        if (terrainAdjusted && predictiveCameraController && !skipSmoothing) {
            const spring = predictiveCameraController.cameraSpring;
            if (spring.position && spring.position.alt < cameraAlt) {
                // Spring is behind where terrain collision put us - sync it up
                spring.position.alt = cameraAlt;
                // Also zero the altitude velocity to prevent overshoot
                spring.velocity.alt = 0;
            }
        }

        const isBirdsEye = mode === CameraModes.BIRDS_EYE;
        const isSideView = mode === CameraModes.SIDE_VIEW;

        // Skip ALL smoothing during:
        // - Lerp transitions (useSimplifiedCollision) - they provide their own smoothing
        // - Cinematic mode at high zoom - orbit is inherently smooth, no terrain collision,
        //   and smoothing can cause lag that manifests as jitter
        if (!useSimplifiedCollision && !isCinematicHighZoom) {
            // Position smoothing - prevent jarring camera jumps during normal playback
            // Bird's Eye: 3m (slow, serene flight), Side View: 2m (reduced to prevent terrain jitter)
            // Chase/Cinematic: scales with zoom to accommodate larger orbit radius
            // At zoom 1.0: 5m/frame, At zoom 3.0: 15m/frame (orbit radius is 900m, moves ~2.2m/frame)
            const cinematicPosLimit = 5 * Math.max(1, zoomLevel);
            const maxPosChange = isBirdsEye ? 3 : (isSideView ? 2 : cinematicPosLimit);
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
            // Altitude smoothing - applied AFTER terrain collision to prevent jarring jumps
            // Use very low limits for smooth motion - camera should glide, not jump
            // Bird's Eye: 4m/frame, Side View: 3m/frame (reduced to prevent terrain jitter on hairpins)
            // Chase/Cinematic: 8m/frame (needs responsive terrain following)
            //
            // EXCEPTION: Use faster smoothing (50m/frame) when:
            // 1. Just exited a transition AND terrain adjusted altitude (correcting LERP)
            // 2. Terrain data just became available AND altitude needs adjustment
            //    (terrain tiles loaded async, causing sudden clearance requirements)
            // At 60fps, 50m/frame corrects a 500m difference in ~167ms - fast but smooth.
            const needsFasterSmoothing = (justExitedTransition && terrainAdjusted) ||
                                         (terrainJustBecameAvailable && terrainAdjusted);
            // Altitude smoothing scales with zoom for cinematic mode
            // At higher zoom, the camera height varies more (300-900m at zoom 3.0)
            // and we need to allow the natural altitude changes from the orbit
            const cinematicAltLimit = 8 * Math.max(1, zoomLevel);
            const maxAltChange = needsFasterSmoothing ? 50
                : (isBirdsEye ? 4 : (isSideView ? 3 : cinematicAltLimit));

            // When lastCameraAlt is null but terrain needs adjustment, initialize it
            // from the pre-adjustment altitude so smoothing can work from a baseline.
            // This prevents instant jumps when terrain data first becomes available
            // after a seek or when tiles load asynchronously.
            if (window._terrainCache.lastCameraAlt === null && terrainAdjusted) {
                window._terrainCache.lastCameraAlt = originalCameraAlt;
            }

            // Apply smoothing
            let smoothedAlt = smoothValue(cameraAlt, window._terrainCache.lastCameraAlt, maxAltChange);

            // Additional safety: if the altitude change is still too large (e.g., due to
            // edge cases in cache tracking), limit it to our faster smoothing rate.
            // This is a safety net for any edge cases we might have missed.
            if (window._terrainCache.lastCameraAlt !== null) {
                const actualDelta = Math.abs(smoothedAlt - window._terrainCache.lastCameraAlt);
                if (actualDelta > 50) {
                    smoothedAlt = window._terrainCache.lastCameraAlt +
                        Math.sign(cameraAlt - window._terrainCache.lastCameraAlt) * 50;
                }
            }

            cameraAlt = smoothedAlt;
            window._terrainCache.lastCameraAlt = cameraAlt;

            // Bearing smoothing - prevent jarring camera swings on hairpin turns
            // Bird's Eye: 0.08 deg/frame (~5 deg/sec at 60fps) - ultra slow for serene flight
            // Side View: 0.15 deg/frame (~9 deg/sec) - very slow because perpendicular direction
            //   oscillates rapidly on hairpins, causing hunting behavior if too responsive
            // Chase/Cinematic: smoothing handled in applyCameraState on geometric bearing
            // (smoothing here would double-smooth and cause oscillation)
            const isCinematic = mode === CameraModes.CINEMATIC;
            const isChase = mode === CameraModes.CHASE;
            if (!isCinematic && !isChase) {
                const maxBearingChange = isBirdsEye ? 0.08 : 0.15; // Only side view now
                cameraBearing = smoothBearing(cameraBearing, window._terrainCache.lastBearing, maxBearingChange);
            }
            window._terrainCache.lastBearing = cameraBearing;

            // Pitch smoothing - prevent jarring pitch changes on terrain transitions
            // Bird's Eye: 0.1 deg/frame, Side View: 0.3 deg/frame
            // Chase/Cinematic: smoothing handled in applyCameraState on geometric pitch
            if (!isCinematic && !isChase) {
                const maxPitchChange = isBirdsEye ? 0.1 : 0.3; // Only side view now
                cameraPitch = smoothValue(cameraPitch, window._terrainCache.lastPitch, maxPitchChange);
            }
            window._terrainCache.lastPitch = cameraPitch;
        } else {
            // During transitions, still update the cache so we don't get a jump when transition ends
            window._terrainCache.lastLng = cameraLng;
            window._terrainCache.lastLat = cameraLat;
            window._terrainCache.lastCameraAlt = cameraAlt;
            window._terrainCache.lastBearing = cameraBearing;
            window._terrainCache.lastPitch = cameraPitch;
        }

        // UNIVERSAL CAMERA POSITION SMOOTHING
        // Apply exponential smoothing to the final camera position for all modes except cinematic
        // (cinematic has its own specialized smoothing). This provides a second layer of
        // smoothing beyond rider position smoothing, catching any jitter from terrain collision.
        if (mode !== CameraModes.CINEMATIC && !skipSmoothing) {
            const cameraTarget = { lng: cameraLng, lat: cameraLat, alt: cameraAlt };
            const state = getOrInitSmoothState('_cameraSmoothState', cameraTarget, mode);
            const camAlpha = getCameraSmoothingAlpha(mode);
            const smoothed = applySmoothPosition(state, cameraTarget, camAlpha);
            cameraLng = smoothed.lng;
            cameraLat = smoothed.lat;
            cameraAlt = smoothed.alt;
        }

        // Debug logging for camera state (computed, before final smoothing in applyCameraState)
        // Note: Actual jitter detection moved to applyCameraState where final smoothing is applied
        if (window.FLYOVER_DEBUG) {
            window._lastCameraState = { lng: cameraLng, lat: cameraLat, alt: cameraAlt, bearing: cameraBearing };

            if (!window._cameraLogCount) {
                window._cameraLogCount = 0;
            }
            window._cameraLogCount++;
            // Log every 60th frame to reduce noise
            if (window._cameraLogCount % 60 === 0) {
                console.log('[CAMERA]', {
                    mode: mode,
                    dotAlt: dotPoint.alt.toFixed(1),
                    terrainAtCamera: terrainElevation !== null ? terrainElevation.toFixed(1) : 'null',
                    computedAlt: cameraAlt.toFixed(1),
                    terrainAdjusted: terrainAdjusted
                });
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

        // Skip watchdog entirely for cinematic mode at high zoom
        // The exponential smoothing handles stability, and watchdog cache resets
        // would destroy the smoothing state causing jitter
        const isCinematicHighZoom = currentCameraMode === CameraModes.CINEMATIC && zoomLevel >= 2.0;
        if (isCinematicHighZoom && !isTransitioning) {
            return false;
        }

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

        // JITTER DETECTION DISABLED
        // The watchdog jitter detection was causing a feedback loop:
        // 1. Terrain causes altitude oscillation
        // 2. Watchdog detects oscillation and resets caches
        // 3. Cache reset causes position jump
        // 4. Jump causes more oscillation -> go to step 2
        // The smoothing system handles jitter better than cache resets.
        // Keeping the altitude history tracking for potential future use.
        if (false && watchdogAltitudeHistory.length >= 4) {
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
        window._cinematicCameraPos = null;
        _lastAppliedState = null;

        // Reset smoothing states to prevent lag after seeks
        window._riderSmoothState = null;
        window._cameraSmoothState = null;

        // Reset predictive camera controller (both springs and cached predictions)
        if (predictiveCameraController) {
            predictiveCameraController.cameraSpring.reset();
            predictiveCameraController.lookAtSpring.reset();
            predictiveCameraController.lastPredictedTarget = null;
            predictiveCameraController.lastSamples = null;
            predictiveCameraController.lastMode = null;
            if (window.FLYOVER_DEBUG) {
                console.log('[RESET] Predictive camera controller reset');
            }
        }

        if (window._terrainCache) {
            window._terrainCache.lastCameraAlt = null;
            window._terrainCache.lastBearing = null;
            window._terrainCache.lastPitch = null;
            window._terrainCache.hadTerrainData = false;
            window._terrainCache.terrainAvailableFrames = 0;
        }
    }

    /**
     * Initialize all smoothing systems after animated seek completes.
     * Also enables adaptive smoothing grace period to prevent emergency smoothing
     * from fighting the natural transition to normal camera operation.
     *
     * @param {object} cameraState - Final camera state from animated seek
     * @param {object} riderPos - Final rider position (for rider smoothing init)
     * @param {number} seekDistanceKm - Distance of the seek for adaptive smoothing
     */
    function initializeSmoothingToState(cameraState, riderPos, seekDistanceKm = 0) {
        if (!cameraState) return;

        const pos = { lng: cameraState.lng, lat: cameraState.lat, alt: cameraState.alt };

        // Initialize camera smooth state (universal smoothing layer)
        window._cameraSmoothState = { ...pos, mode: currentCameraMode };

        // Initialize rider smooth state if provided
        if (riderPos) {
            window._riderSmoothState = {
                lng: riderPos.lng,
                lat: riderPos.lat,
                alt: riderPos.alt,
                mode: currentCameraMode
            };
        }

        // Initialize predictive springs to this exact position
        if (predictiveCameraController) {
            predictiveCameraController.cameraSpring.teleportTo(pos);
            predictiveCameraController.lookAtSpring.teleportTo(riderPos || pos);
            // Clear prediction caches - they'll regenerate
            predictiveCameraController.lastPredictedTarget = null;
            predictiveCameraController.lastSamples = null;
        }

        // Set last applied state
        _lastAppliedState = { ...cameraState };

        // Enable adaptive smoothing grace period - this allows the camera to
        // naturally transition without emergency smoothing fighting it
        _seekTimestamp = performance.now();
        _seekDistance = (seekDistanceKm || 10) * 1000;  // Default to 10km to enable grace period

        // Set terrain cache to current state
        if (window._terrainCache) {
            window._terrainCache.lastLng = cameraState.lng;
            window._terrainCache.lastLat = cameraState.lat;
            window._terrainCache.lastCameraAlt = cameraState.alt;
            window._terrainCache.lastBearing = cameraState.bearing;
            window._terrainCache.lastPitch = cameraState.pitch;
        }

        if (window.FLYOVER_DEBUG) {
            console.log('[INIT SMOOTHING] Initialized to state:', {
                lng: cameraState.lng.toFixed(4),
                lat: cameraState.lat.toFixed(4),
                alt: cameraState.alt.toFixed(0),
                bearing: cameraState.bearing.toFixed(1),
                seekDistanceKm: seekDistanceKm.toFixed(1)
            });
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

        // Record input for panic button replay
        const recorder = getStateRecorder();
        if (recorder.isEnabled) {
            recorder.recordInput('mode', { from: currentCameraMode, to: newMode });
        }

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

        // Log transition start
        if (window.FLYOVER_DEBUG) {
            const distKm = (progress * totalDistance).toFixed(1);
            console.log(`[MODE_SWITCH] Starting transition at km=${distKm} from=${currentCameraMode} to=${newMode} ` +
                `startState: alt=${transitionStartState.alt.toFixed(0)} bearing=${transitionStartState.bearing.toFixed(0)} ` +
                `pitch=${transitionStartState.pitch.toFixed(1)} zoom=${zoomLevel.toFixed(2)}`);
        }

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

            // Reset predictive camera controller for new route
            if (predictiveCameraController) {
                predictiveCameraController.reset();
            }

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
     *   pos=0.6        - Position as fraction (0-1)
     *   km=78.5        - Position in kilometers
     *   mode=chase     - Camera mode (chase, birds_eye, side_view, cinematic)
     *   debug=1        - Enable debug logging
     *   play=1         - Auto-start playback
     *   predictive=0   - Disable predictive camera (use legacy reactive camera for A/B testing)
     *   predictive=1   - Enable predictive camera (default)
     *
     * Debug: Set window.PREDICTIVE_CAMERA_DEBUG=true in console to see prediction info
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

        // Disable predictive camera if requested (for A/B testing)
        const predictiveParam = params.get('predictive');
        if (predictiveParam === '0' || predictiveParam === 'false') {
            window.PREDICTIVE_CAMERA_DISABLED = true;
            console.log('Predictive camera DISABLED via URL parameter. Using legacy reactive camera.');
        } else if (predictiveParam === '1' || predictiveParam === 'true') {
            window.PREDICTIVE_CAMERA_DISABLED = false;
            console.log('Predictive camera ENABLED via URL parameter.');
        }

        // Auto-start playback if requested
        if (params.get('play') === '1') {
            setTimeout(() => {
                if (!isPlaying) togglePlay();
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

        // Handle clicks on elevation profile to seek (uses animated seek)
        elevationProfile.onPositionChange = (newPosition) => {
            animatedSeekTo(newPosition);
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
        rewindBtn.addEventListener('click', () => animatedSeekTo(Math.max(0, progress - 0.05)));
        forwardBtn.addEventListener('click', () => animatedSeekTo(Math.min(1, progress + 0.05)));

        speedBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                speedBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                speedMultiplier = CONFIG.speeds[btn.dataset.speed] || 1;
            });
        });

        // Profile track click to seek (uses animated seek for smooth transition)
        const profileTrack = document.getElementById('profile-track');
        if (profileTrack) {
            profileTrack.addEventListener('click', (e) => {
                const rect = profileTrack.getBoundingClientRect();
                // Account for 10px canvas padding on each side
                const chartPadding = 10;
                const chartWidth = rect.width - 2 * chartPadding;
                const position = (e.clientX - rect.left - chartPadding) / chartWidth;
                animatedSeekTo(Math.max(0, Math.min(1, position)));
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
                    animatedSeekTo(Math.max(0, progress - 0.02));
                    break;
                case 'ArrowRight':
                    animatedSeekTo(Math.min(1, progress + 0.02));
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
                    // Reset predictive camera spring for immediate zoom change
                    if (predictiveCameraController) {
                        predictiveCameraController.getCameraSpring().reset(null);
                    }
                    if (!isPlaying) {
                        freeNavigationEnabled = false;
                        updateCamera(0.016);
                        freeNavigationEnabled = true;
                    }
                    break;
                // Panic button - capture camera state (Ctrl+Shift+P or just P)
                case 'p':
                case 'P':
                    if (e.ctrlKey && e.shiftKey) {
                        e.preventDefault();
                        onPanicButton();
                    } else if (!e.ctrlKey && !e.metaKey) {
                        // Plain 'p' also triggers panic button for easy access
                        e.preventDefault();
                        onPanicButton();
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

        const oldPitch = chaseCamPitch;
        chaseCamPitch = newPitch;
        savePitchToStorage(chaseCamPitch);

        // Record input for panic button replay
        if (stateRecorder && stateRecorder.isEnabled) {
            stateRecorder.recordInput('pitch', { from: oldPitch, to: newPitch });
        }

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
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        if (dotPoint && transitionStartState) {
            const currentPoint = { lng: dotPoint.lng, lat: dotPoint.lat, alt: dotPoint.alt };
            const targetState = calculateScrubCameraState(currentPoint);

            // Calculate remaining distance from current applied state to target
            const lastApplied = _lastAppliedState || transitionStartState;
            const altDist = Math.abs(lastApplied.alt - targetState.alt);
            const cosLat = Math.cos(targetState.lat * Math.PI / 180);
            const lngDistM = Math.abs(lastApplied.lng - targetState.lng) * 111000 * cosLat;
            const latDistM = Math.abs(lastApplied.lat - targetState.lat) * 111000;
            const posDistM = Math.sqrt(lngDistM * lngDistM + latDistM * latDistM);

            // Smoothing limits (same as applyCameraState)
            // Altitude scales DOWN with zoom, position scales UP with zoom
            const altZoomFactor = Math.max(0.33, 1 / zoomLevel);
            const posZoomFactor = Math.max(1, zoomLevel);
            const maxAltPerFrame = 15 * altZoomFactor;
            const maxPosPerFrame = 8 * posZoomFactor;

            // Check if close enough to target
            const closeEnough = altDist < maxAltPerFrame * 2 && posDistM < maxPosPerFrame * 2;

            if (closeEnough) {
                // Transition complete - snap to target
                applyCameraState(targetState, dotPoint, false);
                overviewTransitionProgress = 1;
                overviewTargetState = targetState;
            } else {
                // Still transitioning - apply target directly, smoothing will cap movement
                applyCameraState(targetState, dotPoint, true);
            }
            updateDotAndUI(dotPoint);
        }

        // Continue if not done and still dragging
        if (overviewTransitionProgress < 1 && isScrubberDragging) {
            scrubAnimationId = requestAnimationFrame(animateScrubZoomUp);
        } else {
            scrubAnimationId = null;
        }
    }

    /**
     * Smooth zoom-down animation when scrubbing ends
     * Uses direct-to-target approach - the smoothing in applyCameraState handles the rate
     */
    function animateScrubZoomDown() {
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        if (dotPoint) {
            // Calculate target camera state (where we want to end up)
            const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
            const directionPoint = getPointAlongRoute(directionDistance);
            const normalCameraState = directionPoint
                ? calculateCameraForMode(currentCameraMode, dotPoint, directionPoint, 0, true)
                : null;

            if (normalCameraState) {
                // Calculate remaining distance from current applied state to target
                const lastApplied = _lastAppliedState || overviewTargetState || normalCameraState;
                const altDist = Math.abs(lastApplied.alt - normalCameraState.alt);
                const cosLat = Math.cos(normalCameraState.lat * Math.PI / 180);
                const lngDistM = Math.abs(lastApplied.lng - normalCameraState.lng) * 111000 * cosLat;
                const latDistM = Math.abs(lastApplied.lat - normalCameraState.lat) * 111000;
                const posDistM = Math.sqrt(lngDistM * lngDistM + latDistM * latDistM);

                // Smoothing limits (same as applyCameraState)
                // Altitude scales DOWN with zoom, position scales UP with zoom
                const altZoomFactor = Math.max(0.33, 1 / zoomLevel);
                const posZoomFactor = Math.max(1, zoomLevel);
                const maxAltPerFrame = 15 * altZoomFactor;
                const maxPosPerFrame = 8 * posZoomFactor;

                // Check if close enough to target
                const closeEnough = altDist < maxAltPerFrame * 2 && posDistM < maxPosPerFrame * 2;

                if (closeEnough) {
                    // Transition complete - snap to target
                    applyCameraState(normalCameraState, dotPoint, false);
                    overviewTransitionProgress = 0;
                } else {
                    // Still transitioning - apply target directly, smoothing will cap movement
                    applyCameraState(normalCameraState, dotPoint, true);
                }
            }
            updateDotAndUI(dotPoint);
        } else {
            overviewTransitionProgress = 0;
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

        // Trigger adaptive smoothing for faster altitude descent after scrub
        // The scrub altitude change is large (often 2000m+), so we want fast catch-up
        _seekTimestamp = performance.now();
        _seekDistance = SCRUB_ALTITUDE; // Use scrub altitude as the "seek distance" for adaptive smoothing

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

        // Record input for panic button replay
        if (stateRecorder && stateRecorder.isEnabled) {
            stateRecorder.recordInput('playPause', { isPlaying: isPlaying });
        }

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
            // EXCEPTION: After animated seek, we already zoomed in - don't override again!
            if (animatedSeekState.justCompleted) {
                // Animated seek already positioned the camera correctly and initialized smoothing
                animatedSeekState.justCompleted = false;
                if (window.FLYOVER_DEBUG) {
                    console.log('[TOGGLE PLAY] Skipping user override setup - animated seek just completed');
                }
            } else if (window._terrainCache &&
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

    // ============================================================
    // ANIMATED SEEK SYSTEM (Google Earth style zoom-out-pan-zoom-in)
    // ============================================================

    const ANIMATED_SEEK_CONFIG = {
        minDistanceM: 1000,        // Only animate seeks larger than this (meters)
        zoomOutDuration: 400,      // ms to zoom out (base - scales with distance)
        panDuration: 600,          // ms to pan while zoomed out (base - scales with distance)
        zoomInDuration: 500,       // ms to zoom back in (base - scales with distance)
        zoomOutAltMultiplier: 3.0, // How much higher to go (multiplier of current alt)
        maxZoomOutAlt: 8000,       // Cap on zoom-out altitude (meters)
        enabled: true,             // Feature flag
    };

    let animatedSeekState = {
        active: false,
        phase: 'idle',  // 'zoom_out', 'pan', 'zoom_in', 'idle'
        startProgress: 0,
        targetProgress: 0,
        phaseStartTime: 0,
        startCameraState: null,
        zoomedOutAlt: 0,
        animationId: null,
        justCompleted: false,  // Set true when animated seek completes, cleared after first togglePlay
    };

    /**
     * Easing function for smooth animations
     */
    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    /**
     * Start an animated seek (Google Earth style)
     * Zooms out → pans to destination → zooms back in
     */
    function animatedSeekTo(newPosition) {
        const oldProgress = progress;
        const targetProgress = Math.max(0, Math.min(1, newPosition));
        const seekDistanceM = Math.abs(targetProgress - oldProgress) * totalDistance * 1000;
        const seekDistanceKm = seekDistanceM / 1000;

        // If animated seek is disabled or seek is too small, use instant seek
        if (!ANIMATED_SEEK_CONFIG.enabled || seekDistanceM < ANIMATED_SEEK_CONFIG.minDistanceM) {
            seekToPosition(newPosition);
            return;
        }

        // Cancel any existing animation
        if (animatedSeekState.animationId) {
            cancelAnimationFrame(animatedSeekState.animationId);
        }

        // Reset overview/transition flags to prevent "double move" after animated seek
        // These flags could be set from previous scrubber interaction
        shouldReturnFromOverview = false;
        overviewTransitionProgress = 0;
        transitionStartState = null;
        overviewTargetState = null;
        window._overviewReturnFrames = 0;

        // Get current camera state
        const currentCameraState = _lastAppliedState ? { ..._lastAppliedState } : null;
        if (!currentCameraState) {
            // No current state, fall back to instant seek
            seekToPosition(newPosition);
            return;
        }

        // Calculate zoom-out altitude - scale with seek distance
        // For short seeks (~2km): ~2x altitude
        // For long seeks (50km+): go much higher to see the whole journey
        const baseAlt = currentCameraState.alt;
        const distanceMultiplier = 1 + Math.log10(1 + seekDistanceKm / 5); // logarithmic scaling
        const dynamicAltMultiplier = ANIMATED_SEEK_CONFIG.zoomOutAltMultiplier * distanceMultiplier;

        // Minimum altitude based on seek distance (longer seeks need higher view)
        const minAltForSeek = 1000 + seekDistanceKm * 30; // 1km base + 30m per km traveled

        const zoomedOutAlt = Math.max(
            minAltForSeek,
            Math.min(
                baseAlt * dynamicAltMultiplier,
                ANIMATED_SEEK_CONFIG.maxZoomOutAlt
            )
        );

        // Scale durations with seek distance (longer seeks need more time for tiles to load)
        const durationScale = Math.max(1, Math.sqrt(seekDistanceKm / 5)); // sqrt scaling
        const scaledZoomOutDuration = ANIMATED_SEEK_CONFIG.zoomOutDuration * durationScale;
        const scaledPanDuration = ANIMATED_SEEK_CONFIG.panDuration * durationScale;
        const scaledZoomInDuration = ANIMATED_SEEK_CONFIG.zoomInDuration * durationScale;

        // Initialize animation state - save playing state to restore after seek
        animatedSeekState = {
            active: true,
            phase: 'zoom_out',
            startProgress: oldProgress,
            targetProgress: targetProgress,
            phaseStartTime: performance.now(),
            startCameraState: currentCameraState,
            zoomedOutAlt: zoomedOutAlt,
            animationId: null,
            // Scaled durations
            zoomOutDuration: scaledZoomOutDuration,
            panDuration: scaledPanDuration,
            zoomInDuration: scaledZoomInDuration,
            // End camera state (calculated at start of pan phase)
            endCameraState: null,
            // Save playing state to restore after seek completes
            wasPlaying: isPlaying,
        };

        if (window.FLYOVER_DEBUG) {
            console.log(`[ANIMATED SEEK] Starting: ${(oldProgress * totalDistance).toFixed(1)}km → ${(targetProgress * totalDistance).toFixed(1)}km (${seekDistanceKm.toFixed(1)}km)`);
            console.log(`[ANIMATED SEEK] Zoom to ${zoomedOutAlt.toFixed(0)}m alt, durations: ${scaledZoomOutDuration.toFixed(0)}ms / ${scaledPanDuration.toFixed(0)}ms / ${scaledZoomInDuration.toFixed(0)}ms`);
        }

        // Start animation loop
        animatedSeekState.animationId = requestAnimationFrame(animateSeekStep);
    }

    /**
     * Animation step for animated seek
     */
    function animateSeekStep(timestamp) {
        const state = animatedSeekState;
        if (!state.active) return;

        const elapsed = timestamp - state.phaseStartTime;

        switch (state.phase) {
            case 'zoom_out': {
                // Use scaled duration from state
                const duration = state.zoomOutDuration || ANIMATED_SEEK_CONFIG.zoomOutDuration;
                const t = Math.min(1, elapsed / duration);
                const eased = easeInOutCubic(t);

                // Interpolate altitude up
                const currentAlt = state.startCameraState.alt +
                    (state.zoomedOutAlt - state.startCameraState.alt) * eased;

                // Apply camera at start position but rising altitude
                const dotPoint = getPointAlongRoute(state.startProgress * totalDistance);
                if (dotPoint) {
                    const cameraState = {
                        ...state.startCameraState,
                        alt: currentAlt,
                    };
                    applyCameraState(cameraState, dotPoint, true);
                    updateDotAndUI(dotPoint);
                }

                if (t >= 1) {
                    state.phase = 'pan';
                    state.phaseStartTime = timestamp;
                }
                break;
            }

            case 'pan': {
                // Use scaled duration from state
                const duration = state.panDuration || ANIMATED_SEEK_CONFIG.panDuration;
                const t = Math.min(1, elapsed / duration);
                const eased = easeInOutCubic(t);

                // Interpolate progress position
                const currentProgress = state.startProgress +
                    (state.targetProgress - state.startProgress) * eased;

                // Update progress (for UI and dot position)
                progress = currentProgress;

                // Get camera position at interpolated progress
                const dotDistance = currentProgress * totalDistance;
                const dotPoint = getPointAlongRoute(dotDistance);

                if (dotPoint) {
                    // Calculate end camera state once (at start of pan phase)
                    if (!state.endCameraState) {
                        const endDotDistance = state.targetProgress * totalDistance;
                        const endDotPoint = getPointAlongRoute(endDotDistance);
                        const endDirDist = Math.min(endDotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
                        const endDirPoint = getPointAlongRoute(endDirDist);
                        if (endDotPoint && endDirPoint) {
                            state.endCameraState = calculateCameraForMode(currentCameraMode, endDotPoint, endDirPoint, 0.016, true);
                        }
                    }

                    // Smoothly interpolate between start and end camera states
                    // Don't recalculate bearing at every step - that causes spinning
                    const startState = state.startCameraState;
                    const endState = state.endCameraState || startState;

                    // Interpolate bearing using shortest angular path
                    let bearingDelta = endState.bearing - startState.bearing;
                    while (bearingDelta > 180) bearingDelta -= 360;
                    while (bearingDelta < -180) bearingDelta += 360;
                    const currentBearing = startState.bearing + bearingDelta * eased;

                    // Interpolate pitch
                    const currentPitch = startState.pitch + (endState.pitch - startState.pitch) * eased;

                    // Create camera state with interpolated values
                    const cameraState = {
                        lng: dotPoint.lng,
                        lat: dotPoint.lat,
                        alt: state.zoomedOutAlt,
                        bearing: currentBearing,
                        pitch: Math.min(currentPitch, -30), // Keep looking down while zoomed out
                    };

                    applyCameraState(cameraState, dotPoint, true);
                    updateDotAndUI(dotPoint);
                    updateProgress();
                }

                if (t >= 1) {
                    state.phase = 'zoom_in';
                    state.phaseStartTime = timestamp;

                    // Notify unified controller about the seek (for proper state reset)
                    // Check USE_UNIFIED_CAMERA flag, not controller.isEnabled (which starts false)
                    if (USE_UNIFIED_CAMERA || window._USE_UNIFIED_CAMERA) {
                        const controller = getUnifiedCameraController();
                        const finalDotPoint = getPointAlongRoute(state.targetProgress * totalDistance);
                        if (finalDotPoint) {
                            const dirDist = Math.min(state.targetProgress * totalDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
                            const dirPoint = getPointAlongRoute(dirDist);
                            if (dirPoint) {
                                // Use calculateIdealCameraTarget for unified system
                                const newTarget = (USE_UNIFIED_CAMERA || window._USE_UNIFIED_CAMERA)
                                    ? calculateIdealCameraTarget(currentCameraMode, finalDotPoint, dirPoint)
                                    : calculateCameraForMode(currentCameraMode, finalDotPoint, dirPoint, 0.016, true);
                                if (newTarget) {
                                    const seekDistanceM = Math.abs(state.targetProgress - state.startProgress) * totalDistance * 1000;
                                    controller.onSeek(finalDotPoint, newTarget, seekDistanceM);
                                }
                            }
                        }
                    }
                }
                break;
            }

            case 'zoom_in': {
                // Use scaled duration from state
                const duration = state.zoomInDuration || ANIMATED_SEEK_CONFIG.zoomInDuration;
                const t = Math.min(1, elapsed / duration);
                const eased = easeInOutCubic(t);

                // Get final position and calculate target camera state
                const dotDistance = state.targetProgress * totalDistance;
                const dotPoint = getPointAlongRoute(dotDistance);

                if (dotPoint) {
                    const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
                    const directionPoint = getPointAlongRoute(directionDistance);

                    let targetCameraState;
                    if (directionPoint) {
                        targetCameraState = calculateCameraForMode(currentCameraMode, dotPoint, directionPoint, 0.016, true);
                    }

                    if (targetCameraState) {
                        // Interpolate altitude down to target
                        const currentAlt = state.zoomedOutAlt +
                            (targetCameraState.alt - state.zoomedOutAlt) * eased;

                        const cameraState = {
                            ...targetCameraState,
                            alt: currentAlt,
                        };
                        applyCameraState(cameraState, dotPoint, true);

                        // Store final state for initialization when animation completes
                        state.finalCameraState = cameraState;
                        state.finalRiderPos = dotPoint;
                    }
                    updateDotAndUI(dotPoint);
                }

                if (t >= 1) {
                    // Animation complete
                    state.active = false;
                    state.phase = 'idle';
                    state.animationId = null;

                    // Reset all transition flags
                    shouldReturnFromOverview = false;
                    overviewTransitionProgress = 0;
                    transitionStartState = null;
                    overviewTargetState = null;
                    window._overviewReturnFrames = 0;
                    returnProgress = 1;  // Don't start user override lerp
                    lastUserCameraState = null;

                    // Calculate seek distance for adaptive smoothing
                    const seekDistanceKm = Math.abs(state.targetProgress - state.startProgress) * totalDistance;

                    // Initialize smoothing systems to final state with grace period
                    if (state.finalCameraState) {
                        initializeSmoothingToState(state.finalCameraState, state.finalRiderPos, seekDistanceKm);
                    }

                    // Clear history (but keep smoothing state initialized)
                    cameraHistory = [];
                    watchdogAltitudeHistory = [];
                    settlingFramesRemaining = SETTLING_DURATION;

                    if (window.FLYOVER_DEBUG) {
                        console.log(`[ANIMATED SEEK] Complete at ${(progress * totalDistance).toFixed(1)}km`);
                    }

                    // Restore playback state if it was playing before seek
                    if (state.wasPlaying && !isPlaying) {
                        // Mark that we just completed animated seek - togglePlay should NOT
                        // set up user override return (we already zoomed in via animation)
                        state.justCompleted = true;
                        togglePlay();
                    }
                    return;
                }
                break;
            }
        }

        // Continue animation
        state.animationId = requestAnimationFrame(animateSeekStep);
    }

    /**
     * Check if animated seek is in progress
     */
    function isAnimatedSeekActive() {
        return animatedSeekState.active;
    }

    /**
     * Cancel any in-progress animated seek
     */
    function cancelAnimatedSeek() {
        if (animatedSeekState.animationId) {
            cancelAnimationFrame(animatedSeekState.animationId);
        }
        animatedSeekState.active = false;
        animatedSeekState.phase = 'idle';
        animatedSeekState.animationId = null;
    }

    /**
     * Seek to specific position
     * Uses smooth transition to prevent camera jitter
     * Records seek metadata for adaptive smoothing
     */
    function seekToPosition(newPosition) {
        const oldProgress = progress;
        progress = Math.max(0, Math.min(1, newPosition));

        // Record input for panic button replay
        const recorder = getStateRecorder();
        if (recorder.isEnabled) {
            recorder.recordInput('seek', { from: oldProgress, to: progress });
        }

        // Calculate how far we're seeking (as fraction of route)
        const seekDelta = Math.abs(progress - oldProgress);
        const significantSeek = seekDelta > 0.01; // More than 1% of route

        // Record seek metadata for adaptive smoothing
        const seekDistanceKm = seekDelta * totalDistance;
        _seekTimestamp = performance.now();
        _seekDistance = seekDistanceKm * 1000;

        if (_seekDistance > 1000 && window.FLYOVER_DEBUG) {
            console.log(`[SEEK] Distance: ${seekDistanceKm.toFixed(1)}km`);
        }

        // UNIFIED CAMERA: Notify controller about seek
        // Check USE_UNIFIED_CAMERA flag, not controller.isEnabled (which starts false)
        if (USE_UNIFIED_CAMERA || window._USE_UNIFIED_CAMERA) {
            const controller = getUnifiedCameraController();
            const newRiderPos = getPointAlongRoute(progress * totalDistance);
            if (newRiderPos) {
                // Calculate new target position for the seek
                const directionDistance = Math.min(progress * totalDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
                const directionPoint = getPointAlongRoute(directionDistance);
                if (directionPoint) {
                    const newTarget = calculateIdealCameraTarget(currentCameraMode, newRiderPos, directionPoint);
                    if (newTarget) {
                        controller.onSeek(newRiderPos, newTarget, _seekDistance);
                    }
                }
            }
        }

        resetCameraCaches(); // Reset ALL caches including position to avoid smoothing lag

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

        // For significant seeks during playback, use instant teleport instead of lerp transition.
        // Lerp causes oscillation when terrain tiles load asynchronously and change target altitude.
        if (significantSeek && isPlaying) {
            if (scrubAnimationId) {
                cancelAnimationFrame(scrubAnimationId);
                scrubAnimationId = null;
            }

            // Reset all transition states for instant teleport
            overviewTransitionProgress = 0;
            shouldReturnFromOverview = false;
            transitionStartState = null;
            overviewTargetState = null;
            window._overviewReturnFrames = 0;
            _lastAppliedState = null;

            // Skip terrain collision during initial frames after teleport
            settlingFramesRemaining = SETTLING_DURATION;
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

        // Calculate delta time in seconds, capped to prevent jumps during frame drops
        // Cap at 100ms (10fps minimum) - any slower and we'd rather skip frames than jump
        const rawDeltaTime = (timestamp - lastTimestamp) / 1000;
        const deltaTime = Math.min(rawDeltaTime, 0.1);
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
    /**
     * Calculate the current virtual speed of the rider in km/h
     * This is based on animation parameters, not realistic cycling speed
     */
    function getCurrentVirtualSpeedKmh() {
        const duration = Math.max(CONFIG.minDuration, (totalDistance / 100) * CONFIG.baseDuration);
        const distancePerSecond = totalDistance * speedMultiplier / duration;
        return distancePerSecond * 3600; // Convert to km/h
    }

    // Feature flag for predictive camera system
    // Set to true to enable the new predictive camera for chase/birds_eye/side_view
    // Can be disabled via URL parameter: ?predictive=0
    function isPredictiveCameraEnabled() {
        if (window.PREDICTIVE_CAMERA_DISABLED) return false;
        return true;  // Default: enabled
    }
    const ENABLE_PREDICTIVE_CAMERA = true;  // Base flag (can be overridden by URL param)

    // =============================================================================
    // UNIFIED CAMERA SYSTEM
    // Toggle this flag to switch between legacy (8+ smoothing layers) and unified (1 spring)
    // =============================================================================
    const USE_UNIFIED_CAMERA = false;  // Disabled - still has issues. Enable via flyoverDebug.unified.enable()

    /**
     * Calculate the ideal camera target for a given mode - PURE GEOMETRY, NO SMOOTHING
     * This is the "raw" camera position before any spring/filter processing.
     *
     * @param {string} mode - Camera mode (chase, birds_eye, side_view, cinematic)
     * @param {object} dotPoint - Rider position {lng, lat, alt}
     * @param {object} nextPoint - Look-ahead point for bearing
     * @returns {object} - Ideal camera state {lng, lat, alt, bearing, pitch}
     */
    function calculateIdealCameraTarget(mode, dotPoint, nextPoint) {
        if (!dotPoint || !nextPoint) return null;

        const config = CameraModeConfig[mode];
        const forwardBearing = calculateBearing(dotPoint, nextPoint);
        const zoom = zoomLevel;

        let cameraLng, cameraLat, cameraAlt, cameraBearing, cameraPitch;

        switch (mode) {
            case CameraModes.CHASE: {
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
                cameraAlt = dotPoint.alt + calculatedAltitude + (dotPoint.alt * 0.1);
                cameraBearing = forwardBearing;
                cameraPitch = chaseCamPitch;
                break;
            }

            case CameraModes.BIRDS_EYE: {
                const offsetUp = config.offsetUp * zoom;

                const southOffset = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    0.03 * zoom,
                    180,
                    { units: 'kilometers' }
                );

                cameraLng = southOffset.geometry.coordinates[0];
                cameraLat = southOffset.geometry.coordinates[1];
                cameraAlt = dotPoint.alt + offsetUp;
                cameraBearing = forwardBearing;
                cameraPitch = config.pitch;
                break;
            }

            case CameraModes.SIDE_VIEW: {
                const offsetSide = config.offsetSide * zoom;
                const offsetUp = config.offsetUp * zoom;

                // Determine which side to use (left or right of path)
                // For simplicity in ideal calculation, use left side
                // The actual side selection logic can be applied in the update
                const sideBearing = (forwardBearing + 90) % 360;

                const sidePoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    offsetSide / 1000,
                    sideBearing,
                    { units: 'kilometers' }
                );

                cameraLng = sidePoint.geometry.coordinates[0];
                cameraLat = sidePoint.geometry.coordinates[1];
                cameraAlt = dotPoint.alt + offsetUp;
                // Look back at the rider from the side
                cameraBearing = (sideBearing + 180) % 360;
                cameraPitch = config.pitch;
                break;
            }

            case CameraModes.CINEMATIC: {
                // Cinematic uses orbital motion - calculate based on current angle
                const orbitRadius = config.orbitRadius * zoom;
                const orbitAngle = cinematicAngle; // Global orbit angle

                const orbitPoint = turf.destination(
                    turf.point([dotPoint.lng, dotPoint.lat]),
                    orbitRadius / 1000,
                    (orbitAngle * 180 / Math.PI) % 360,
                    { units: 'kilometers' }
                );

                // Vary height and pitch based on orbit position
                const heightVariation = Math.sin(orbitAngle * 2) * 0.3 + 0.7;
                const heightRange = config.heightMax - config.heightMin;

                cameraLng = orbitPoint.geometry.coordinates[0];
                cameraLat = orbitPoint.geometry.coordinates[1];
                cameraAlt = dotPoint.alt + config.heightMin + heightRange * heightVariation;
                cameraBearing = (orbitAngle * 180 / Math.PI + 180) % 360;

                const pitchVariation = (1 - heightVariation) * 0.5 + 0.5;
                const pitchRange = config.pitchMax - config.pitchMin;
                cameraPitch = config.pitchMin + pitchRange * pitchVariation;
                break;
            }

            default:
                return null;
        }

        return { lng: cameraLng, lat: cameraLat, alt: cameraAlt, bearing: cameraBearing, pitch: cameraPitch };
    }

    /**
     * Unified Camera Update - replaces updateCamera when USE_UNIFIED_CAMERA is true
     * Uses a single spring-based smoothing system instead of 8+ overlapping layers.
     *
     * Algorithm:
     * 1. Get raw rider position (turf.along - deterministic)
     * 2. Calculate ideal camera target (pure geometry, no smoothing)
     * 3. Query terrain at camera position
     * 4. Filter terrain (OutlierRejectingEMA absorbs tile load surprises)
     * 5. Apply terrain constraint to TARGET (not output!)
     * 6. Spring update (THE ONLY SMOOTHING)
     * 7. Apply to map (NO POST-PROCESSING)
     */
    function updateCameraUnified(deltaTime = 0) {
        // Skip during animated seek
        if (isAnimatedSeekActive()) {
            return;
        }

        // 1. Get raw rider position
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
        const directionPoint = getPointAlongRoute(directionDistance);

        if (!dotPoint || !directionPoint) return;

        // Handle scrubber dragging
        if (isScrubberDragging) {
            return;
        }

        // Handle free navigation mode
        if (freeNavigationEnabled && !isPlaying) {
            updateDotAndUI(dotPoint);
            return;
        }

        // Handle user override
        if (userOverrideActive) {
            updateDotAndUI(dotPoint);
            return;
        }

        // 2. Calculate ideal camera target (pure geometry)
        const idealTarget = calculateIdealCameraTarget(targetCameraMode, dotPoint, directionPoint);
        if (!idealTarget) {
            updateDotAndUI(dotPoint);
            return;
        }

        // Update cinematic orbit angle
        if (targetCameraMode === CameraModes.CINEMATIC) {
            cinematicAngle += CameraModeConfig.cinematic.orbitSpeed * deltaTime;
        }

        // 3. Query terrain at camera position
        let terrainElevation = null;
        try {
            terrainElevation = map.queryTerrainElevation([idealTarget.lng, idealTarget.lat]);
        } catch (e) {
            // Terrain query failed - continue without
        }

        // 4-6. Let unified controller handle filtering, constraining, and smoothing
        const controller = getUnifiedCameraController();
        const smoothedState = controller.update(
            dotPoint,
            terrainElevation,
            targetCameraMode,
            deltaTime,
            idealTarget
        );

        // 7. Apply to map - NO POST-PROCESSING
        if (smoothedState) {
            applyCameraStateDirect(smoothedState, dotPoint);
        }

        // Update dot and UI
        updateDotAndUI(dotPoint);
    }

    /**
     * Apply camera state directly to map without any post-processing
     * Used by unified camera system to avoid adding more smoothing layers.
     */
    function applyCameraStateDirect(state, lookAtPoint) {
        try {
            if (!state || !isFinite(state.lng) || !isFinite(state.lat) || !isFinite(state.alt) ||
                !isFinite(state.bearing) || !isFinite(state.pitch)) {
                console.error('[UNIFIED] Invalid state values:', state);
                return;
            }

            const camera = map.getFreeCameraOptions();

            // Set camera position (use array format like the working applyCameraState)
            camera.position = mapboxgl.MercatorCoordinate.fromLngLat(
                [state.lng, state.lat],
                state.alt
            );

            // Set look-at target (use array format, no altitude parameter)
            if (lookAtPoint) {
                camera.lookAtPoint([lookAtPoint.lng, lookAtPoint.lat]);
            }

            // Apply camera settings
            map.setFreeCameraOptions(camera);

            // Debug logging
            if (window.CAMERA_CHAOS_DEBUG) {
                const km = (progress * totalDistance).toFixed(1);
                console.log(`[UNIFIED APPLY] km=${km} alt=${state.alt.toFixed(0)} bearing=${state.bearing.toFixed(0)} pitch=${state.pitch.toFixed(1)}`);
            }
        } catch (error) {
            console.error('[UNIFIED] Error applying camera state:', error);
        }
    }

    function updateCamera(deltaTime = 0) {
        // Use unified camera system if enabled (compile-time flag OR runtime toggle)
        if (USE_UNIFIED_CAMERA || window._USE_UNIFIED_CAMERA) {
            return updateCameraUnified(deltaTime);
        }

        // Skip normal camera updates during animated seek - the animation handles camera
        if (isAnimatedSeekActive()) {
            return;
        }

        // Dot position from turf.along() - constant speed along the path
        const dotDistance = progress * totalDistance;
        const dotPoint = getPointAlongRoute(dotDistance);

        // Direction point for camera bearing (slightly ahead) - legacy fallback
        const directionDistance = Math.min(dotDistance + CONFIG.lookAheadDistance / 1000, totalDistance);
        const directionPoint = getPointAlongRoute(directionDistance);

        if (!dotPoint || !directionPoint) return;

        // PREDICTIVE CAMERA SYSTEM
        // For chase, bird's eye, and side view, use the predictive camera controller
        // which samples future positions and computes a weighted centroid.
        // This makes local path variations (zigzags, S-curves) mathematically invisible.
        let predictedTarget = directionPoint;  // Fallback to legacy
        let predictiveData = null;

        const usePredictive = isPredictiveCameraEnabled() &&
            (targetCameraMode === CameraModes.CHASE ||
             targetCameraMode === CameraModes.BIRDS_EYE ||
             targetCameraMode === CameraModes.SIDE_VIEW);

        if (usePredictive && routeData) {
            const controller = getPredictiveCameraController();
            const speedKmh = getCurrentVirtualSpeedKmh();

            predictiveData = controller.update(
                dotPoint,
                dotDistance,  // Current distance in km
                speedKmh,
                targetCameraMode,
                deltaTime
            );

            if (predictiveData && predictiveData.predictedTarget) {
                // Use the predicted target for bearing calculation
                // This makes the camera anticipate direction changes
                predictedTarget = predictiveData.predictedTarget;

                // Debug logging for predictive camera (can be enabled via console)
                if (window.PREDICTIVE_CAMERA_DEBUG && predictiveData.samples) {
                    const distToTarget = haversineDistance(dotPoint, predictedTarget);
                    console.log('[PREDICTIVE]', {
                        samples: predictiveData.samples.length,
                        lookAheadM: Math.round(predictiveData.samples[predictiveData.samples.length - 1]?.distanceAhead || 0),
                        distToTargetM: Math.round(distToTarget),
                        speedKmh: Math.round(speedKmh)
                    });
                }
            }
        }

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
        // When predictive camera is enabled, use predictedTarget for bearing/direction
        // This makes the camera anticipate direction changes instead of reacting to them
        let targetState = calculateCameraForMode(
            targetCameraMode,
            dotPoint,
            usePredictive ? predictedTarget : directionPoint,  // Predicted target for bearing
            deltaTime,
            isInAnyTransition,
            predictiveData  // Pass predictive data for spring-based smoothing
        );
        if (!targetState) return;

        // During transitions, apply terrain collision to the TARGET state.
        // This prevents the LERP from interpolating to positions below terrain,
        // which causes visible camera drops during transitions and jarring jumps when they end.
        // (calculateCameraForMode uses simplified rider-only collision during transitions)
        if (isInAnyTransition) {
            const collision = applyTerrainCollision(
                targetState.lng,
                targetState.lat,
                targetState.alt,
                dotPoint.alt
            );

            // Apply smoothing to terrain collision during transitions
            // This prevents jarring jumps when terrain tiles load mid-transition
            // Use a faster rate (50m/frame) since transitions need to be responsive
            if (!window._transitionTerrainCache) {
                window._transitionTerrainCache = { lastAlt: null };
            }

            let smoothedAlt = collision.altitude;
            if (window._transitionTerrainCache.lastAlt !== null) {
                const delta = collision.altitude - window._transitionTerrainCache.lastAlt;
                if (Math.abs(delta) > 50) {
                    smoothedAlt = window._transitionTerrainCache.lastAlt + Math.sign(delta) * 50;
                }
            }
            window._transitionTerrainCache.lastAlt = smoothedAlt;

            targetState.alt = smoothedAlt;
        } else {
            // Reset transition cache when not in transition
            if (window._transitionTerrainCache) {
                window._transitionTerrainCache.lastAlt = null;
            }
        }

        // Check for camera stability and apply fallback if needed
        // This detects jitter/chaos and rider visibility issues
        targetState = handleStabilityFallback(targetState, dotPoint, directionPoint, deltaTime);

        // Update camera history for stability tracking
        updateCameraHistory(targetState);

        let finalState;

        // Handle return from overview mode (after scrubber drag ends during playback)
        if (inOverviewReturn) {
            // Use time-based lerp from transition start to current target.
            // This avoids the "chasing a moving target" problem that caused jitter.
            // The transition lasts a fixed duration, then snaps to target.
            const transitionDuration = 0.5; // seconds

            // Track transition progress using a counter (frames elapsed)
            if (!window._overviewReturnFrames) {
                window._overviewReturnFrames = 0;
            }
            window._overviewReturnFrames++;

            // Assume 60fps, so 30 frames = 0.5 seconds
            const maxFrames = Math.round(transitionDuration * 60);
            const t = Math.min(1, window._overviewReturnFrames / maxFrames);
            const easedT = easeOutCubic(t);

            if (t >= 1) {
                // Transition complete - snap to target and reset
                finalState = targetState;
                shouldReturnFromOverview = false;
                overviewTransitionProgress = 0;
                transitionStartState = null;
                overviewTargetState = null;
                window._overviewReturnFrames = 0;
                resetCameraCaches();
                settlingFramesRemaining = SETTLING_DURATION;

                applyCameraState(finalState, dotPoint, false);
            } else {
                // Lerp from start to current target
                // This interpolates smoothly even as target moves
                if (transitionStartState) {
                    finalState = lerpCameraState(transitionStartState, targetState, easedT);
                } else {
                    finalState = targetState;
                }

                applyCameraState(finalState, dotPoint, true);
            }

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

            // Detailed transition logging
            if (window.FLYOVER_DEBUG) {
                const distKm = (progress * totalDistance).toFixed(1);
                console.log(`[TRANSITION] km=${distKm} t=${t.toFixed(3)} progress=${modeTransitionProgress.toFixed(3)} ` +
                    `from=${currentCameraMode} to=${targetCameraMode} ` +
                    `startAlt=${transitionStartState.alt.toFixed(0)} targetAlt=${targetState.alt.toFixed(0)} finalAlt=${finalState.alt.toFixed(0)} ` +
                    `startBearing=${transitionStartState.bearing.toFixed(0)} targetBearing=${targetState.bearing.toFixed(0)} finalBearing=${finalState.bearing.toFixed(0)}`);
            }

            if (modeTransitionProgress >= 1) {
                currentCameraMode = targetCameraMode;
            }
        }
        // Normal guided mode
        else {
            // UNIFIED CAMERA CONTROLLER
            // When enabled, this replaces all the legacy smoothing with a single spring system
            const controller = getUnifiedCameraController();
            if (controller.isEnabled) {
                // Get terrain at camera position
                const terrainAtCamera = map.queryTerrainElevation([targetState.lng, targetState.lat]);

                // Let unified controller smooth the position
                const smoothedPos = controller.update(
                    dotPoint,           // rider position
                    terrainAtCamera,    // terrain (can be null)
                    targetCameraMode,   // current mode
                    deltaTime,          // time step
                    targetState         // ideal target from mode calculation
                );

                // Apply smoothed position AND smoothed bearing from unified controller
                finalState = {
                    ...targetState,
                    lng: smoothedPos.lng,
                    lat: smoothedPos.lat,
                    alt: smoothedPos.alt,
                    bearing: smoothedPos.bearing !== undefined ? smoothedPos.bearing : targetState.bearing
                };
            } else {
                // Legacy path - use targetState with all its smoothing layers
                finalState = targetState;
            }
            currentCameraMode = targetCameraMode;
        }

        // Apply camera state - pass transition flag to sync watchdog cache
        applyCameraState(finalState, dotPoint, isInTransition);

        // Update dot and UI
        updateDotAndUI(dotPoint);

        // RECORD FRAME STATE for panic button replay
        const recorder = getStateRecorder();
        if (recorder.isEnabled) {
            recorder.recordFrame({
                deltaTime: deltaTime,
                progress: progress,
                riderPosition: dotPoint,
                cameraPosition: finalState,
                bearing: finalState.bearing,
                pitch: finalState.pitch,
                mode: targetCameraMode,
                zoomLevel: zoomLevel
            });
        }
    }

    /**
     * Apply a camera state to the map
     * @param {object} state - Camera state to apply (includes lng, lat, alt, bearing, pitch)
     * @param {object} lookAtPoint - Point for fallback centering only (rider position)
     * @param {boolean} isTransitioning - Whether we're in a lerp transition (scrub return, mode change)
     */
    // Track last applied state for jitter detection logging and emergency smoothing
    let _lastAppliedState = null;
    let _jitterLogCount = 0;

    function applyCameraState(state, lookAtPoint, isTransitioning = false) {
        try {
            // Validate state values - catch NaN/Infinity from calculation errors
            if (!state || !isFinite(state.lng) || !isFinite(state.lat) || !isFinite(state.alt) ||
                !isFinite(state.bearing) || !isFinite(state.pitch)) {
                console.error('[CAMERA] Invalid state values detected:', state);
                // Use last known good state if available
                if (_lastAppliedState) {
                    state = { ..._lastAppliedState };
                } else {
                    return; // Can't recover without a previous state
                }
            }

            // ADAPTIVE EMERGENCY SMOOTHING
            // Safety net for large jumps that bypass earlier smoothing.
            // After seeks, uses larger limits that decay exponentially to baseline.
            const timeSinceSeek = performance.now() - _seekTimestamp;
            const isAdaptive = timeSinceSeek < ADAPTIVE_WINDOW && _seekDistance > 0;
            let maxPosDelta = BASE_POS_LIMIT;
            let maxAltDelta = BASE_ALT_LIMIT;

            if (isAdaptive) {
                const distanceFactor = Math.max(1, Math.min(MAX_POS_LIMIT / BASE_POS_LIMIT, _seekDistance / 10000));
                const timeDecay = Math.exp(-timeSinceSeek / DECAY_CONSTANT);
                const adaptiveMultiplier = 1 + (distanceFactor - 1) * timeDecay;
                maxPosDelta = Math.min(BASE_POS_LIMIT * adaptiveMultiplier, MAX_POS_LIMIT);
                maxAltDelta = Math.min(BASE_ALT_LIMIT * adaptiveMultiplier, MAX_ALT_LIMIT);
            }

            // SEEK GRACE PERIOD: Lock altitude for first 1000ms after large seeks
            // to prevent terrain-loading chaos while position catches up
            const SEEK_GRACE_PERIOD = 1000;
            const inSeekGracePeriod = timeSinceSeek < SEEK_GRACE_PERIOD && _seekDistance > 1000;

            if (inSeekGracePeriod) {
                // Lock altitude when terrain stabilizes (altitude < 800m indicates loaded terrain)
                if (!window._seekGraceAltitude && state.alt < 800) {
                    window._seekGraceAltitude = state.alt;
                }
                if (window._seekGraceAltitude) {
                    state = { ...state, alt: window._seekGraceAltitude };
                }
            } else if (window._seekGraceAltitude) {
                window._seekGraceAltitude = null;
            }

            // Apply position and altitude smoothing limits
            // Skip during settling period (after animated seek) to allow natural transition
            const inSettlingPeriod = settlingFramesRemaining > 0;
            if (!inSeekGracePeriod && !inSettlingPeriod && _lastAppliedState && !isTransitioning) {
                const posDelta = calculatePositionDelta(state, _lastAppliedState);
                const altDelta = state.alt - _lastAppliedState.alt;
                let needsSmoothing = false;

                if (posDelta > maxPosDelta) {
                    const scale = maxPosDelta / posDelta;
                    state = {
                        ...state,
                        lng: _lastAppliedState.lng + (state.lng - _lastAppliedState.lng) * scale,
                        lat: _lastAppliedState.lat + (state.lat - _lastAppliedState.lat) * scale
                    };
                    needsSmoothing = true;
                }

                if (Math.abs(altDelta) > maxAltDelta) {
                    state = { ...state, alt: _lastAppliedState.alt + Math.sign(altDelta) * maxAltDelta };
                    needsSmoothing = true;
                }

                if (needsSmoothing) {
                    if (isAdaptive) {
                        console.log('[ADAPTIVE SMOOTHING] pos:', posDelta.toFixed(0), 'm, limit:', maxPosDelta.toFixed(0), 'm');
                    } else {
                        console.warn('[EMERGENCY SMOOTHING] pos:', posDelta.toFixed(0), 'm, alt:', Math.abs(altDelta).toFixed(0), 'm');
                    }
                    if (window._terrainCache) {
                        window._terrainCache.lastLng = state.lng;
                        window._terrainCache.lastLat = state.lat;
                        window._terrainCache.lastCameraAlt = state.alt;
                    }
                }
            }

            // Debug logging for jitter detection and seek behavior
            if (window.FLYOVER_DEBUG) {
                if (_lastAppliedState && !isTransitioning) {
                    const posDelta = calculatePositionDelta(state, _lastAppliedState);
                    const altDiff = Math.abs(state.alt - _lastAppliedState.alt);
                    const bearingDiff = Math.abs(bearingDelta(state.bearing, _lastAppliedState.bearing));

                    if (altDiff > 20 || bearingDiff > 5 || posDelta > 50) {
                        _jitterLogCount++;
                        if (_jitterLogCount % 5 === 1) {
                            console.log('[JITTER]', {
                                altDelta: altDiff.toFixed(0),
                                bearingDelta: bearingDiff.toFixed(1),
                                posDelta: posDelta.toFixed(0),
                                settling: settlingFramesRemaining,
                                mode: currentCameraMode
                            });
                        }
                    }
                }

                // Seek debug logging for 10 seconds after large seeks
                const isInSeekDebugWindow = _seekDistance > 1000 && timeSinceSeek < 10000;
                if (isInSeekDebugWindow) {
                    if (!window._seekDebugFrameCount) window._seekDebugFrameCount = 0;
                    window._seekDebugFrameCount++;

                    if (window._seekDebugFrameCount % 5 === 0 && lookAtPoint) {
                        const dLng = (state.lng - lookAtPoint.lng) * Math.cos(state.lat * Math.PI / 180) * 111320;
                        const dLat = (state.lat - lookAtPoint.lat) * 111320;
                        const camToRider = Math.sqrt(dLng * dLng + dLat * dLat);
                        console.log('[SEEK DEBUG] t=' + Math.round(timeSinceSeek) + 'ms' +
                            ' | camToRider: ' + Math.round(camToRider) + 'm' +
                            ' | alt: ' + Math.round(state.alt) + 'm' +
                            ' | settling: ' + settlingFramesRemaining);
                    }
                } else {
                    window._seekDebugFrameCount = 0;
                }
            }

            _lastAppliedState = { ...state };

            // CAMERA CHAOS DEBUGGING - detailed per-frame logging
            if (window.CAMERA_CHAOS_DEBUG && window._chaosDebugData) {
                const d = window._chaosDebugData;
                d.frameCount++;

                // Calculate current km position
                const currentKm = progress * totalDistance;

                // Calculate deltas from last frame
                let bearingDelta = 0;
                let altDelta = 0;
                let posDelta = 0;

                if (d.lastBearing !== null) {
                    bearingDelta = state.bearing - d.lastBearing;
                    // Normalize bearing delta to -180..180
                    if (bearingDelta > 180) bearingDelta -= 360;
                    if (bearingDelta < -180) bearingDelta += 360;
                }
                if (d.lastAlt !== null) {
                    altDelta = state.alt - d.lastAlt;
                }
                if (d.lastPos) {
                    const dLng = (state.lng - d.lastPos.lng) * 111320 * Math.cos(state.lat * Math.PI / 180);
                    const dLat = (state.lat - d.lastPos.lat) * 111320;
                    posDelta = Math.sqrt(dLng * dLng + dLat * dLat);
                }

                // Update max deltas
                if (Math.abs(bearingDelta) > d.maxBearingDelta) d.maxBearingDelta = Math.abs(bearingDelta);
                if (Math.abs(altDelta) > d.maxAltDelta) d.maxAltDelta = Math.abs(altDelta);
                if (posDelta > d.maxPosDelta) d.maxPosDelta = posDelta;

                // Store history (keep last 100)
                d.bearingHistory.push({ km: currentKm.toFixed(2), bearing: state.bearing.toFixed(1), delta: bearingDelta.toFixed(2) });
                d.altHistory.push({ km: currentKm.toFixed(2), alt: state.alt.toFixed(1), delta: altDelta.toFixed(2) });
                d.posHistory.push({ km: currentKm.toFixed(2), lng: state.lng.toFixed(5), lat: state.lat.toFixed(5), delta: posDelta.toFixed(2) });

                // Query terrain and store
                const terrainAtCam = map.queryTerrainElevation([state.lng, state.lat]);
                d.terrainHistory.push({ km: currentKm.toFixed(2), terrain: terrainAtCam !== null ? terrainAtCam.toFixed(1) : 'null' });

                if (d.bearingHistory.length > 100) {
                    d.bearingHistory.shift();
                    d.altHistory.shift();
                    d.posHistory.shift();
                    d.terrainHistory.shift();
                }

                // Update last values
                d.lastBearing = state.bearing;
                d.lastAlt = state.alt;
                d.lastPos = { lng: state.lng, lat: state.lat };

                // Log every frame with significant changes, or every 10th frame between km 50-53
                const inProblemZone = currentKm >= 50 && currentKm <= 53;
                const hasSignificantChange = Math.abs(bearingDelta) > 5 || Math.abs(altDelta) > 20 || posDelta > 30;

                if (inProblemZone || hasSignificantChange) {
                    console.log(`[CHAOS] km=${currentKm.toFixed(2)} | bearing=${state.bearing.toFixed(1)}° (Δ${bearingDelta.toFixed(1)}) | ` +
                        `alt=${state.alt.toFixed(0)}m (Δ${altDelta.toFixed(0)}) | posDelta=${posDelta.toFixed(1)}m | ` +
                        `terrain=${terrainAtCam !== null ? terrainAtCam.toFixed(0) : 'null'}m | zoom=${zoomLevel.toFixed(1)}`);
                }
            }

            // SMOOTHNESS MEASUREMENT SYSTEM
            // Tracks frame-to-frame deltas and computes standard deviation
            // Lower stddev = smoother camera motion
            if (!window._smoothnessMetrics) {
                window._smoothnessMetrics = {
                    posDeltas: [],      // Position change per frame (meters)
                    altDeltas: [],      // Altitude change per frame (meters)
                    bearingDeltas: [],  // Bearing change per frame (degrees)
                    lastState: null,
                    sampleCount: 0,
                    mode: null,
                    reportInterval: 300,  // Report every 300 frames (~5 sec at 60fps)
                    warmupFrames: 60,    // Skip first 60 frames on mode change
                };
            }
            const sm = window._smoothnessMetrics;

            // Reset if mode changed
            if (sm.mode !== currentCameraMode) {
                sm.posDeltas = [];
                sm.altDeltas = [];
                sm.bearingDeltas = [];
                sm.sampleCount = 0;
                sm.mode = currentCameraMode;
                sm.lastState = null;
                sm.warmupFrames = 60;
            }

            // Skip warmup period after mode change
            if (sm.warmupFrames > 0) {
                sm.warmupFrames--;
                sm.lastState = { ...state };
            } else if (sm.lastState && !isTransitioning) {
                const posDelta = calculatePositionDelta(state, sm.lastState);
                const altDelta = Math.abs(state.alt - sm.lastState.alt);
                const bearingDiff = Math.abs(bearingDelta(state.bearing, sm.lastState.bearing));

                // Store deltas (keep last 300 samples for rolling average)
                sm.posDeltas.push(posDelta);
                sm.altDeltas.push(altDelta);
                sm.bearingDeltas.push(bearingDiff);
                if (sm.posDeltas.length > 300) {
                    sm.posDeltas.shift();
                    sm.altDeltas.shift();
                    sm.bearingDeltas.shift();
                }
                sm.sampleCount++;

                // Report smoothness periodically
                if (sm.sampleCount % sm.reportInterval === 0 && sm.posDeltas.length >= 60) {
                    const posStats = calculateStats(sm.posDeltas);
                    const altStats = calculateStats(sm.altDeltas);
                    const bearingStats = calculateStats(sm.bearingDeltas);

                    // Position uses sqrt scaling (tolerant of mode differences), alt/bearing use linear
                    const posScore = calculateSmoothnessScore(posStats.stddev, 14, true);
                    const altScore = calculateSmoothnessScore(altStats.stddev, 50);
                    const bearingScore = calculateSmoothnessScore(bearingStats.stddev, 33);
                    const overallScore = (posScore + altScore + bearingScore) / 3;

                    const modeNames = { 0: 'CHASE', 1: 'BIRDS_EYE', 2: 'SIDE_VIEW', 3: 'CINEMATIC' };
                    console.log(`[SMOOTHNESS] ${modeNames[sm.mode] || sm.mode}: ` +
                        `Overall=${overallScore.toFixed(1)}% ` +
                        `(pos=${posScore.toFixed(1)}% stddev=${posStats.stddev.toFixed(3)}m, ` +
                        `alt=${altScore.toFixed(1)}% stddev=${altStats.stddev.toFixed(3)}m, ` +
                        `bearing=${bearingScore.toFixed(1)}% stddev=${bearingStats.stddev.toFixed(3)}deg)`);
                }
            }
            sm.lastState = { ...state };

            const camera = map.getFreeCameraOptions();

            // Set camera position
            camera.position = mapboxgl.MercatorCoordinate.fromLngLat(
                [state.lng, state.lat],
                state.alt
            );

            // Set camera orientation to look at the rider
            if (lookAtPoint) {
                // For cinematic mode at high zoom, use the smoothed rider position
                const isCinematicHighZoom = currentCameraMode === CameraModes.CINEMATIC &&
                                            zoomLevel >= 2.0 &&
                                            !isTransitioning;
                const target = isCinematicHighZoom && window._cinematicState
                    ? window._cinematicState
                    : lookAtPoint;

                // Use Mapbox's native lookAtPoint - it's the most stable option
                // The smoothed target position should eliminate any jitter from route data
                camera.lookAtPoint([target.lng, target.lat]);
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
        // Uses seekToPosition() to properly trigger adaptive smoothing
        seekTo: (pos) => {
            seekToPosition(pos);
            console.log(`Seeked to ${(progress * 100).toFixed(1)}% (${(progress * totalDistance).toFixed(2)} km)`);
        },

        // Seek to a specific distance in km
        // Uses seekToPosition() to properly trigger adaptive smoothing
        seekToKm: (km) => {
            seekToPosition(km / totalDistance);
            console.log(`Seeked to ${km.toFixed(2)} km (${(progress * 100).toFixed(1)}%)`);
        },

        // Animated seek to a specific distance in km (Google Earth style)
        animatedSeekToKm: (km) => {
            animatedSeekTo(km / totalDistance);
            console.log(`Animated seek to ${km.toFixed(2)} km`);
        },

        // Animated seek controls
        animatedSeek: {
            enable: () => {
                ANIMATED_SEEK_CONFIG.enabled = true;
                console.log('[ANIMATED SEEK] Enabled');
            },
            disable: () => {
                ANIMATED_SEEK_CONFIG.enabled = false;
                console.log('[ANIMATED SEEK] Disabled - using instant teleport');
            },
            status: () => {
                console.log('=== ANIMATED SEEK CONFIG ===');
                console.log(`Enabled: ${ANIMATED_SEEK_CONFIG.enabled}`);
                console.log(`Min distance: ${ANIMATED_SEEK_CONFIG.minDistanceM}m`);
                console.log(`Zoom out duration: ${ANIMATED_SEEK_CONFIG.zoomOutDuration}ms`);
                console.log(`Pan duration: ${ANIMATED_SEEK_CONFIG.panDuration}ms`);
                console.log(`Zoom in duration: ${ANIMATED_SEEK_CONFIG.zoomInDuration}ms`);
                console.log(`Zoom out multiplier: ${ANIMATED_SEEK_CONFIG.zoomOutAltMultiplier}x`);
                console.log(`Max zoom out alt: ${ANIMATED_SEEK_CONFIG.maxZoomOutAlt}m`);
                console.log(`Current state: ${animatedSeekState.phase}`);
                return ANIMATED_SEEK_CONFIG;
            },
            setDurations: (zoomOut, pan, zoomIn) => {
                if (zoomOut !== undefined) ANIMATED_SEEK_CONFIG.zoomOutDuration = zoomOut;
                if (pan !== undefined) ANIMATED_SEEK_CONFIG.panDuration = pan;
                if (zoomIn !== undefined) ANIMATED_SEEK_CONFIG.zoomInDuration = zoomIn;
                console.log(`Durations set: zoomOut=${ANIMATED_SEEK_CONFIG.zoomOutDuration}ms, pan=${ANIMATED_SEEK_CONFIG.panDuration}ms, zoomIn=${ANIMATED_SEEK_CONFIG.zoomInDuration}ms`);
            },
            setZoomMultiplier: (mult) => {
                ANIMATED_SEEK_CONFIG.zoomOutAltMultiplier = mult;
                console.log(`Zoom out multiplier set to ${mult}x`);
            },
            setMinDistance: (meters) => {
                ANIMATED_SEEK_CONFIG.minDistanceM = meters;
                console.log(`Min distance for animation set to ${meters}m`);
            },
        },

        // Set camera mode
        setMode: (mode) => {
            const modes = { chase: CameraModes.CHASE, birds_eye: CameraModes.BIRDS_EYE, side_view: CameraModes.SIDE_VIEW, cinematic: CameraModes.CINEMATIC };
            if (modes[mode]) {
                transitionToMode(modes[mode]);
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
        pause: () => { if (isPlaying) togglePlay(); },
        play: () => { if (!isPlaying) togglePlay(); },

        // Set zoom level (0.3 = 30% closest, 3.0 = 300% farthest)
        setZoom: (zoom) => {
            zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
            saveZoomToStorage(zoomLevel);
            updateZoomIndicator();
            // Force camera update
            if (!isPlaying) {
                freeNavigationEnabled = false;
                updateCamera(0.016);
                freeNavigationEnabled = true;
            }
            console.log(`Zoom set to ${Math.round(zoomLevel * 100)}%`);
        },

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
        },

        // Adaptive smoothing status and controls
        adaptiveSmoothing: {
            status: () => {
                const timeSinceSeek = performance.now() - _seekTimestamp;
                const isActive = timeSinceSeek < ADAPTIVE_WINDOW && _seekDistance > 0;
                const distanceFactor = Math.max(1, Math.min(MAX_POS_LIMIT / BASE_POS_LIMIT, _seekDistance / 10000));
                const timeDecay = isActive ? Math.exp(-timeSinceSeek / DECAY_CONSTANT) : 0;
                const currentPosLimit = isActive ? Math.min(BASE_POS_LIMIT * (1 + (distanceFactor - 1) * timeDecay), MAX_POS_LIMIT) : BASE_POS_LIMIT;

                return {
                    isActive: isActive,
                    seekDistance: _seekDistance,
                    seekDistanceKm: (_seekDistance / 1000).toFixed(2),
                    timeSinceSeek: timeSinceSeek.toFixed(0) + 'ms',
                    timeDecay: timeDecay.toFixed(3),
                    distanceFactor: distanceFactor.toFixed(1),
                    currentPosLimit: currentPosLimit.toFixed(0) + 'm/frame',
                    basePosLimit: BASE_POS_LIMIT + 'm/frame',
                    maxPosLimit: MAX_POS_LIMIT + 'm/frame'
                };
            },
            // Manually trigger adaptive smoothing (for testing)
            simulateSeek: (distanceKm) => {
                _seekTimestamp = performance.now();
                _seekDistance = distanceKm * 1000;
                console.log(`Simulated ${distanceKm}km seek - adaptive smoothing engaged`);
            },
            // Reset adaptive smoothing state
            reset: () => {
                _seekTimestamp = 0;
                _seekDistance = 0;
                console.log('Adaptive smoothing state reset');
            }
        },

        // CAMERA CHAOS DEBUGGING
        // Comprehensive logging to diagnose camera instability issues
        cameraChaosDiag: {
            // Enable detailed per-frame logging for camera chaos diagnosis
            enable: () => {
                window.CAMERA_CHAOS_DEBUG = true;
                window._chaosDebugData = {
                    frameCount: 0,
                    bearingHistory: [],
                    altHistory: [],
                    posHistory: [],
                    terrainHistory: [],
                    springHistory: [],
                    maxBearingDelta: 0,
                    maxAltDelta: 0,
                    maxPosDelta: 0,
                    lastBearing: null,
                    lastAlt: null,
                    lastPos: null
                };
                console.log('[CHAOS DIAG] Enabled - will log every frame. Use flyoverDebug.cameraChaosDiag.report() to see summary');
            },
            disable: () => {
                window.CAMERA_CHAOS_DEBUG = false;
                console.log('[CHAOS DIAG] Disabled');
            },
            // Get current debug data
            getData: () => window._chaosDebugData,
            // Generate summary report
            report: () => {
                const d = window._chaosDebugData;
                if (!d) {
                    console.log('No chaos debug data - run enable() first');
                    return;
                }
                console.log('=== CAMERA CHAOS DIAGNOSIS REPORT ===');
                console.log(`Frames analyzed: ${d.frameCount}`);
                console.log(`Max bearing delta: ${d.maxBearingDelta.toFixed(2)}°/frame`);
                console.log(`Max altitude delta: ${d.maxAltDelta.toFixed(2)}m/frame`);
                console.log(`Max position delta: ${d.maxPosDelta.toFixed(2)}m/frame`);
                console.log('Recent bearing history (last 20):', d.bearingHistory.slice(-20));
                console.log('Recent altitude history (last 20):', d.altHistory.slice(-20));
                console.log('Recent terrain history (last 20):', d.terrainHistory.slice(-20));
                return d;
            },
            // Clear collected data
            clear: () => {
                if (window._chaosDebugData) {
                    window._chaosDebugData = {
                        frameCount: 0,
                        bearingHistory: [],
                        altHistory: [],
                        posHistory: [],
                        terrainHistory: [],
                        springHistory: [],
                        maxBearingDelta: 0,
                        maxAltDelta: 0,
                        maxPosDelta: 0,
                        lastBearing: null,
                        lastAlt: null,
                        lastPos: null
                    };
                    console.log('[CHAOS DIAG] Data cleared');
                }
            }
        },

        // UNIFIED CAMERA CONTROLLER
        // Single source of truth camera system to eliminate jitter
        unifiedController: {
            enable: () => {
                const controller = getUnifiedCameraController();
                controller.setEnabled(true);
                console.log('[UNIFIED] Controller enabled - camera now using single spring system');
                console.log('Note: To use the new unified camera loop, also call flyoverDebug.unified.enable()');
            },
            disable: () => {
                const controller = getUnifiedCameraController();
                controller.setEnabled(false);
                console.log('[UNIFIED] Controller disabled - using legacy smoothing');
            },
            status: () => {
                const controller = getUnifiedCameraController();
                const info = controller.getDebugInfo();
                console.log('=== UNIFIED CAMERA CONTROLLER STATUS ===');
                console.log(`Enabled: ${info.enabled}`);
                console.log(`State: ${info.state}`);
                console.log(`Mode: ${info.mode}`);
                console.log(`Spring position:`, info.springPosition);
                console.log(`Spring velocity:`, info.springVelocity);
                console.log(`Bearing: ${info.bearing?.toFixed(1) ?? 'null'}° (vel: ${info.bearingVelocity?.toFixed(1) ?? 'null'}°/s)`);
                console.log(`Pitch: ${info.pitch?.toFixed(1) ?? 'null'}°`);
                console.log(`Terrain (filtered): ${info.terrainFiltered?.toFixed(1) ?? 'null'}m`);
                console.log(`Terrain (raw): ${info.terrainRaw?.toFixed(1) ?? 'null'}m`);
                if (info.transition) {
                    console.log(`Transition: ${(info.transition.progress * 100).toFixed(0)}% to ${info.transition.targetMode}`);
                }
                return info;
            },
            reset: () => {
                const controller = getUnifiedCameraController();
                controller.reset();
                console.log('[UNIFIED] Controller state reset');
            },
            setTeleportThreshold: (meters) => {
                const controller = getUnifiedCameraController();
                controller.config.teleportThreshold = meters;
                console.log(`[UNIFIED] Teleport threshold set to ${meters}m`);
            },
            setSpringOmega: (omega) => {
                const controller = getUnifiedCameraController();
                controller.positionSpring.omega = omega;
                console.log(`[UNIFIED] Spring omega set to ${omega}`);
            }
        },

        // UNIFIED CAMERA SYSTEM (new architecture)
        // Toggle between legacy (8+ smoothing layers) and unified (1 spring) camera systems
        unified: {
            enable: () => {
                window._USE_UNIFIED_CAMERA = true;
                const controller = getUnifiedCameraController();
                controller.setEnabled(true);
                console.log('=== UNIFIED CAMERA SYSTEM ENABLED ===');
                console.log('Camera now uses single spring-based smoothing.');
                console.log('All 8+ legacy smoothing layers bypassed.');
                console.log('Use flyoverDebug.unified.status() to monitor state.');
            },
            disable: () => {
                window._USE_UNIFIED_CAMERA = false;
                const controller = getUnifiedCameraController();
                controller.setEnabled(false);
                console.log('=== UNIFIED CAMERA SYSTEM DISABLED ===');
                console.log('Camera now uses legacy multi-layer smoothing.');
            },
            status: () => {
                const enabled = window._USE_UNIFIED_CAMERA === true;
                const controller = getUnifiedCameraController();
                const info = controller.getDebugInfo();
                console.log('=== UNIFIED CAMERA SYSTEM STATUS ===');
                console.log(`System active: ${enabled}`);
                console.log(`Controller enabled: ${info.enabled}`);
                console.log(`State machine: ${info.state}`);
                console.log(`Camera mode: ${info.mode}`);
                if (info.springPosition) {
                    console.log(`Position: (${info.springPosition.lng?.toFixed(4)}, ${info.springPosition.lat?.toFixed(4)}, ${info.springPosition.alt?.toFixed(0)}m)`);
                }
                console.log(`Bearing: ${info.bearing?.toFixed(1)}° | Pitch: ${info.pitch?.toFixed(1)}°`);
                return { systemActive: enabled, ...info };
            },
            toggle: () => {
                if (window._USE_UNIFIED_CAMERA) {
                    window.flyoverDebug.unified.disable();
                } else {
                    window.flyoverDebug.unified.enable();
                }
            }
        },

        // STATE RECORDER for deterministic replay
        // Panic button system for capturing camera jitter
        recorder: {
            // Trigger panic button (capture state)
            panic: () => {
                onPanicButton();
            },
            // Get recording stats
            status: () => {
                const recorder = getStateRecorder();
                const stats = recorder.getStats();
                console.log('=== STATE RECORDER STATUS ===');
                console.log(`Enabled: ${stats.isEnabled}`);
                console.log(`Frames recorded: ${stats.frameCount}`);
                console.log(`Buffered frames: ${stats.bufferedFrames} / ${stats.bufferCapacity} (${stats.bufferUsagePercent}%)`);
                console.log(`Buffered duration: ${stats.bufferedDurationSec}s`);
                return stats;
            },
            // Enable recording
            enable: () => {
                const recorder = getStateRecorder();
                recorder.setEnabled(true);
                console.log('[RECORDER] Recording enabled');
            },
            // Disable recording
            disable: () => {
                const recorder = getStateRecorder();
                recorder.setEnabled(false);
                console.log('[RECORDER] Recording disabled');
            },
            // Clear recorded data
            clear: () => {
                const recorder = getStateRecorder();
                recorder.clear();
                console.log('[RECORDER] Buffer cleared');
            },
            // Export last N seconds
            export: (seconds = 30) => {
                const recorder = getStateRecorder();
                const data = recorder.export(seconds);
                console.log(`[RECORDER] Exported ${data.frameCaptured} frames (${(data.durationMs / 1000).toFixed(1)}s)`);
                return data;
            },
            // Get raw buffer (for debugging)
            getBuffer: () => {
                return getStateRecorder().buffer;
            }
        }
    };
    console.log('Flyover debug API available: window.flyoverDebug (try .enable() for logging)');
    console.log('Panic button available: Press P or Ctrl+Shift+P to capture camera state');
})();

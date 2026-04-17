/**
 * KOTR 2026 - Shared geo / elevation algorithms
 *
 * One canonical implementation for haversine, elevation smoothing, and the
 * Strava-style elevation gain walk. Previously these were reimplemented in
 * js/fit-parser.js, js/gpx-parser.js, scripts/download-dem.js, and
 * scripts/generate-inline-data.js — four subtly-divergent copies.
 *
 * Browser: attaches KOTR_GEO to window.
 * Node: module.exports compatible for scripts/*.js.
 */
(function (root) {
    'use strict';

    const EARTH_RADIUS_KM = 6371;

    function toRad(deg) {
        return deg * (Math.PI / 180);
    }

    // Great-circle distance in kilometres.
    function haversineKm(lat1, lon1, lat2, lon2) {
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Moving-average smoother. halfWindow = points on each side; effective
    // window is 2*halfWindow + 1. Kept simple — callers only need it for the
    // gain threshold walk, not spectral accuracy.
    function smoothElevations(elevations, halfWindow) {
        const n = elevations.length;
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            let sum = 0, count = 0;
            const lo = Math.max(0, i - halfWindow);
            const hi = Math.min(n - 1, i + halfWindow);
            for (let j = lo; j <= hi; j++) {
                sum += elevations[j];
                count++;
            }
            out[i] = sum / count;
        }
        return out;
    }

    // Strava-style gain/loss walk. Walk smoothed extrema, accumulating only
    // segments whose magnitude exceeds threshold (filters GPS noise).
    // Returns {gain, loss} in the same units as the input (usually metres).
    function walkElevationGain(smoothed, threshold) {
        const n = smoothed.length;
        if (n < 2) return { gain: 0, loss: 0 };
        let gain = 0, loss = 0;
        let lastExtreme = smoothed[0];
        let wasClimbing = smoothed[1] > smoothed[0];
        for (let i = 1; i < n; i++) {
            const isClimbing = smoothed[i] > smoothed[i - 1];
            if (isClimbing !== wasClimbing) {
                const change = smoothed[i - 1] - lastExtreme;
                if (change >= threshold) gain += change;
                else if (-change >= threshold) loss += -change;
                if (Math.abs(change) >= threshold) lastExtreme = smoothed[i - 1];
                wasClimbing = isClimbing;
            }
        }
        const finalChange = smoothed[n - 1] - lastExtreme;
        if (finalChange >= threshold) gain += finalChange;
        else if (-finalChange >= threshold) loss += -finalChange;
        return { gain, loss };
    }

    const KOTR_GEO = { haversineKm, toRad, smoothElevations, walkElevationGain, EARTH_RADIUS_KM };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = KOTR_GEO;
    } else {
        root.KOTR_GEO = KOTR_GEO;
    }
})(typeof window !== 'undefined' ? window : globalThis);

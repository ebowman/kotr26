/**
 * KOTR 2026 - Shared configuration
 * Single source of truth for constants that would otherwise drift across modules.
 *
 * Browser: attaches KOTR_CONFIG to window.
 * Node: module.exports compatible for scripts/*.js.
 */
(function (root) {
    'use strict';

    // Public Mapbox token. Must be URL-restricted to ebowman.github.io in the
    // Mapbox dashboard — otherwise it's scrape-able quota-drain surface.
    const MAPBOX_TOKEN = 'pk.eyJ1IjoiZWJvd21hbiIsImEiOiJjbWE1ZWVwdzYwODhwMmlzZnU4NTlyem1rIn0.E10X5hj2NTgViJexKpvrOg';

    // Strava-calibrated elevation-gain threshold. Smaller = noisier, larger =
    // under-counts small climbs. 3.5m is empirically matched to Strava output.
    const ELEV_GAIN_THRESHOLD_M = 3.5;

    // Half-window count for moving-average elevation smoothing
    // (effective window = 2*HALF + 1 points ~ 15-25m of track typically).
    const ELEV_SMOOTH_HALF_WINDOW = 5;

    const KOTR_CONFIG = {
        MAPBOX_TOKEN,
        ELEV_GAIN_THRESHOLD_M,
        ELEV_SMOOTH_HALF_WINDOW
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = KOTR_CONFIG;
    } else {
        root.KOTR_CONFIG = KOTR_CONFIG;
    }
})(typeof window !== 'undefined' ? window : globalThis);

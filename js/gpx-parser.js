/**
 * KOTR 2026 - GPX File Parser
 * Parses GPX (GPS Exchange Format) files in the browser
 * Returns the same routeData shape as FitParser.loadFitFile()
 */

const GpxParser = (function() {
    'use strict';

    /**
     * Parse GPX XML text and extract route data
     * @param {string} gpxText - Raw GPX XML string
     * @returns {Object} Parsed route data
     */
    function parseGpx(gpxText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(gpxText, 'text/xml');

        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            throw new Error('Invalid GPX file: ' + parseError.textContent);
        }

        // Extract trackpoints — handle default namespace
        const ns = 'http://www.topografix.com/GPX/1/1';
        let trkpts = doc.getElementsByTagNameNS(ns, 'trkpt');
        if (trkpts.length === 0) {
            // Fallback: try without namespace
            trkpts = doc.getElementsByTagName('trkpt');
        }

        if (trkpts.length === 0) {
            throw new Error('No trackpoints found in GPX file');
        }

        const coordinates = [];
        for (let i = 0; i < trkpts.length; i++) {
            const pt = trkpts[i];
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            const eleNode = pt.getElementsByTagNameNS(ns, 'ele')[0] ||
                            pt.getElementsByTagName('ele')[0];
            const ele = eleNode ? parseFloat(eleNode.textContent) : 0;

            if (!isNaN(lat) && !isNaN(lon)) {
                coordinates.push([lon, lat, ele]);
            }
        }

        // Extract route name
        const nameNode = doc.getElementsByTagNameNS(ns, 'name')[0] ||
                         doc.getElementsByTagName('name')[0];
        const name = nameNode ? nameNode.textContent : 'Unknown Route';

        const GEO = (typeof window !== 'undefined' ? window.KOTR_GEO : require('./geo.js'));
        const CFG = (typeof window !== 'undefined' ? window.KOTR_CONFIG : {});
        const halfWindow = CFG.ELEV_SMOOTH_HALF_WINDOW || 5;
        const threshold = CFG.ELEV_GAIN_THRESHOLD_M || 3.5;

        let totalDistance = 0;
        for (let i = 1; i < coordinates.length; i++) {
            totalDistance += GEO.haversineKm(
                coordinates[i - 1][1], coordinates[i - 1][0],
                coordinates[i][1], coordinates[i][0]
            );
        }

        let minElevation = Infinity, maxElevation = -Infinity;
        for (const c of coordinates) {
            if (c[2] < minElevation) minElevation = c[2];
            if (c[2] > maxElevation) maxElevation = c[2];
        }

        const smoothed = GEO.smoothElevations(coordinates.map(c => c[2]), halfWindow);
        const { gain: totalElevationGain } = GEO.walkElevationGain(smoothed, threshold);

        // Calculate bounds
        const bounds = calculateBounds(coordinates);

        return {
            coordinates,
            distance: Math.round(totalDistance * 10) / 10,
            elevationGain: Math.round(totalElevationGain),
            minElevation: Math.round(minElevation),
            maxElevation: Math.round(maxElevation),
            bounds,
            pointCount: coordinates.length,
            name,
            records: coordinates.map((c, i) => ({
                latitude: c[1],
                longitude: c[0],
                altitude: c[2]
            })),
            laps: [],
            sessions: []
        };
    }

    /**
     * Load and parse a GPX file from URL
     * @param {string} url - URL to the GPX file
     * @returns {Promise<Object>} Parsed route data
     */
    async function loadGpxFile(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load GPX file: ${response.statusText}`);
        }
        const text = await response.text();
        const routeData = parseGpx(text);

        // Try to load DEM sidecar file for accurate elevation data
        const demUrl = url.replace('.gpx', '.dem.json');
        routeData.elevationSource = 'gps';
        try {
            const demResponse = await fetch(demUrl);
            if (!demResponse.ok) {
                if (demResponse.status !== 404) {
                    console.warn(`DEM fetch ${demResponse.status} for ${demUrl}, falling back to GPS elevation`);
                }
                return routeData;
            }
            const demData = await demResponse.json();
            if (!demData.elevations || demData.elevations.length !== routeData.coordinates.length) {
                console.warn(`DEM data point count mismatch: ${demData.elevations && demData.elevations.length} vs ${routeData.coordinates.length}`);
                return routeData;
            }
            for (let i = 0; i < routeData.coordinates.length; i++) {
                routeData.coordinates[i][2] = demData.elevations[i];
            }
            routeData.elevationGain = demData.stats.elevationGain;
            routeData.minElevation = demData.stats.minElevation;
            routeData.maxElevation = demData.stats.maxElevation;
            routeData.elevationSource = 'dem';
        } catch (e) {
            console.warn(`DEM load failed for ${demUrl}:`, e.message || e);
        }

        return routeData;
    }

    function calculateBounds(coordinates) {
        if (coordinates.length === 0) return null;
        let minLng = Infinity, maxLng = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        for (const coord of coordinates) {
            if (coord[0] < minLng) minLng = coord[0];
            if (coord[0] > maxLng) maxLng = coord[0];
            if (coord[1] < minLat) minLat = coord[1];
            if (coord[1] > maxLat) maxLat = coord[1];
        }
        return [[minLng, minLat], [maxLng, maxLat]];
    }

    // Public API
    return {
        parseGpx,
        loadGpxFile
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GpxParser;
}

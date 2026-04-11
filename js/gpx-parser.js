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

        // Calculate distance using Haversine
        let totalDistance = 0;
        for (let i = 1; i < coordinates.length; i++) {
            totalDistance += haversineDistance(
                coordinates[i - 1][1], coordinates[i - 1][0],
                coordinates[i][1], coordinates[i][0]
            );
        }

        // Smooth elevations and calculate stats (same algorithm as fit-parser.js)
        const rawElevations = coordinates.map(c => c[2]);
        const smoothed = smoothElevations(rawElevations, 5);

        let totalElevationGain = 0;
        let minElevation = Infinity;
        let maxElevation = -Infinity;

        const THRESHOLD = 3.5;
        let lastExtreme = smoothed[0];
        let wasClimbing = smoothed.length > 1 ? smoothed[1] > smoothed[0] : false;

        for (let i = 0; i < coordinates.length; i++) {
            const elevation = coordinates[i][2];
            if (elevation < minElevation) minElevation = elevation;
            if (elevation > maxElevation) maxElevation = elevation;

            if (i > 0) {
                const isClimbing = smoothed[i] > smoothed[i - 1];
                if (isClimbing !== wasClimbing) {
                    const change = smoothed[i - 1] - lastExtreme;
                    if (change >= THRESHOLD) {
                        totalElevationGain += change;
                    }
                    if (Math.abs(change) >= THRESHOLD) {
                        lastExtreme = smoothed[i - 1];
                    }
                    wasClimbing = isClimbing;
                }
            }
        }

        // Handle final segment
        const finalChange = smoothed[smoothed.length - 1] - lastExtreme;
        if (finalChange >= THRESHOLD) {
            totalElevationGain += finalChange;
        }

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
        try {
            const demResponse = await fetch(demUrl);
            if (demResponse.ok) {
                const demData = await demResponse.json();
                if (demData.elevations && demData.elevations.length === routeData.coordinates.length) {
                    console.debug(`Loaded DEM elevation data for ${url}`);

                    for (let i = 0; i < routeData.coordinates.length; i++) {
                        routeData.coordinates[i][2] = demData.elevations[i];
                    }

                    routeData.elevationGain = demData.stats.elevationGain;
                    routeData.minElevation = demData.stats.minElevation;
                    routeData.maxElevation = demData.stats.maxElevation;
                    routeData.elevationSource = 'dem';
                } else {
                    console.warn(`DEM data point count mismatch: ${demData.elevations?.length} vs ${routeData.coordinates.length}`);
                    routeData.elevationSource = 'gps';
                }
            } else {
                routeData.elevationSource = 'gps';
            }
        } catch (e) {
            console.debug(`No DEM data available for ${url}, using GPS elevation`);
            routeData.elevationSource = 'gps';
        }

        return routeData;
    }

    /**
     * Smooth elevation data using a moving average
     */
    function smoothElevations(elevations, windowSize) {
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
        return smoothed;
    }

    /**
     * Haversine distance formula (returns km)
     */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function toRad(deg) {
        return deg * (Math.PI / 180);
    }

    /**
     * Calculate geographic bounds
     */
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

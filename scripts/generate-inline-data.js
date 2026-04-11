#!/usr/bin/env node
/**
 * Generate all pre-computed inline data files for KOTR 2026 route visualizations.
 *
 * Reads route files (.fit / .gpx) and their .dem.json sidecar elevation data,
 * then produces:
 *   routes/elevation-profiles.json
 *   compare/data-inline.js   + compare/gps-inline.js
 *   skyline/data-inline.js
 *   pace/data-inline.js
 *   radial/data-inline.js
 *
 * Usage: node scripts/generate-inline-data.js
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Route configuration
// ---------------------------------------------------------------------------
const ROUTES = [
    { day: 1, variant: 'standard', label: 'Warm Up Ride', date: 'May 29', file: 'KOTR_D1_Warm up ride.gpx' },
    { day: 2, variant: 'standard', label: 'Wine Country (Standard)', date: 'May 30', file: 'KOTR_Avignon_Standard_D2.fit' },
    { day: 2, variant: 'long', label: 'NW Long', date: 'May 30', file: 'KOTR_D2_NW_Long.gpx' },
    { day: 3, variant: 'standard', label: 'Luberon Villages', date: 'May 31', file: 'KOTR_Avignon_D3_Standard.fit' },
    { day: 3, variant: 'long', label: 'Mont Ventoux!', date: 'May 31', file: 'KOTR_D3_Long (Mont Ventoux).gpx' },
    { day: 4, variant: 'standard', label: 'Final (Standard)', date: 'Jun 1', file: 'KOTR_Avignon_D4_Standard.fit' },
    { day: 4, variant: 'long', label: 'Luberon Long', date: 'Jun 1', file: 'KOTR_D4_Luberon Long.gpx' },
];

const ROUTES_DIR = path.resolve(__dirname, '..', 'routes');
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SEMICIRCLE_TO_DEGREE = 180 / Math.pow(2, 31);

// ---------------------------------------------------------------------------
// Haversine distance (km)
// ---------------------------------------------------------------------------
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Linear-interpolation downsampler
// ---------------------------------------------------------------------------
function downsample(arr, targetCount) {
    if (arr.length <= targetCount) return arr.slice();
    const result = [];
    for (let i = 0; i < targetCount; i++) {
        const t = i / (targetCount - 1) * (arr.length - 1);
        const lo = Math.floor(t);
        const hi = Math.min(lo + 1, arr.length - 1);
        const frac = t - lo;
        result.push(arr[lo] + (arr[hi] - arr[lo]) * frac);
    }
    return result;
}

/**
 * Downsample an array of [lon, lat] coordinate pairs using linear interpolation.
 */
function downsampleCoords(coords, targetCount) {
    if (coords.length <= targetCount) return coords.slice();
    const result = [];
    for (let i = 0; i < targetCount; i++) {
        const t = i / (targetCount - 1) * (coords.length - 1);
        const lo = Math.floor(t);
        const hi = Math.min(lo + 1, coords.length - 1);
        const frac = t - lo;
        result.push([
            coords[lo][0] + (coords[hi][0] - coords[lo][0]) * frac,
            coords[lo][1] + (coords[hi][1] - coords[lo][1]) * frac,
        ]);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Simple FIT Parser (binary FIT with semicircle conversion)
// ---------------------------------------------------------------------------
class SimpleFitParser {
    constructor() { this.records = []; }

    parse(buffer) {
        const dataView = new DataView(buffer.buffer);
        let offset = dataView.getUint8(0);
        const fieldDefs = {};

        while (offset < buffer.length - 2) {
            const recordHeader = dataView.getUint8(offset);
            offset++;
            const isDefinition = (recordHeader & 0x40) !== 0;
            const localMessageType = recordHeader & 0x0F;

            if (isDefinition) {
                offset++; // reserved
                const arch = dataView.getUint8(offset);
                offset++;
                const isLittleEndian = arch === 0;
                const globalMsgNum = isLittleEndian
                    ? dataView.getUint16(offset, true)
                    : dataView.getUint16(offset, false);
                offset += 2;
                const numFields = dataView.getUint8(offset);
                offset++;
                const fields = [];
                for (let i = 0; i < numFields; i++) {
                    fields.push({
                        fieldDefNum: dataView.getUint8(offset),
                        size: dataView.getUint8(offset + 1),
                        baseType: dataView.getUint8(offset + 2),
                    });
                    offset += 3;
                }
                fieldDefs[localMessageType] = { globalMsgNum, fields, isLittleEndian };
            } else {
                const def = fieldDefs[localMessageType];
                if (!def) break;
                const data = {};
                for (const field of def.fields) {
                    try {
                        const baseType = field.baseType & 0x1F;
                        if (baseType === 6) data[field.fieldDefNum] = dataView.getUint32(offset, def.isLittleEndian);
                        else if (baseType === 5) data[field.fieldDefNum] = dataView.getInt32(offset, def.isLittleEndian);
                        else if (baseType === 4) data[field.fieldDefNum] = dataView.getUint16(offset, def.isLittleEndian);
                        else if (baseType === 3) data[field.fieldDefNum] = dataView.getInt16(offset, def.isLittleEndian);
                        else data[field.fieldDefNum] = dataView.getUint8(offset);
                    } catch (e) { /* skip unreadable field */ }
                    offset += field.size;
                }
                if (def.globalMsgNum === 20) this.parseRecord(data);
            }
        }
        return this.records.filter(r => r.latitude && r.longitude);
    }

    parseRecord(data) {
        const record = {};
        if (data[0] !== undefined && data[0] !== 0x7FFFFFFF) record.latitude = data[0] * SEMICIRCLE_TO_DEGREE;
        if (data[1] !== undefined && data[1] !== 0x7FFFFFFF) record.longitude = data[1] * SEMICIRCLE_TO_DEGREE;
        if (data[78] !== undefined && data[78] !== 0xFFFFFFFF) record.altitude = (data[78] / 5.0) - 500;
        else if (data[2] !== undefined && data[2] !== 0xFFFF) record.altitude = (data[2] / 5.0) - 500;
        if (record.latitude !== undefined && record.longitude !== undefined) this.records.push(record);
    }
}

// ---------------------------------------------------------------------------
// Simple GPX Parser (regex-based, extracts trkpt lat/lon/ele)
// ---------------------------------------------------------------------------
class SimpleGPXParser {
    parse(xmlText) {
        const records = [];
        const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
        const eleRegex = /<ele>([^<]+)<\/ele>/;
        let match;
        while ((match = trkptRegex.exec(xmlText)) !== null) {
            const lat = parseFloat(match[1]);
            const lon = parseFloat(match[2]);
            const eleMatch = match[3].match(eleRegex);
            const altitude = eleMatch ? parseFloat(eleMatch[1]) : 0;
            if (!isNaN(lat) && !isNaN(lon)) {
                records.push({ latitude: lat, longitude: lon, altitude });
            }
        }
        return records;
    }
}

// ---------------------------------------------------------------------------
// Parse a route file and return GPS records [{latitude, longitude, altitude}]
// ---------------------------------------------------------------------------
function parseRouteFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.fit') {
        const buffer = fs.readFileSync(filePath);
        return new SimpleFitParser().parse(buffer);
    }
    if (ext === '.gpx') {
        const xmlText = fs.readFileSync(filePath, 'utf8');
        return new SimpleGPXParser().parse(xmlText);
    }
    throw new Error(`Unsupported file format: ${ext}`);
}

// ---------------------------------------------------------------------------
// Load .dem.json sidecar
// ---------------------------------------------------------------------------
function loadDemJson(routeFilePath) {
    const demPath = routeFilePath.replace(/\.(fit|gpx)$/i, '.dem.json');
    if (!fs.existsSync(demPath)) {
        throw new Error(`DEM sidecar not found: ${demPath}`);
    }
    return JSON.parse(fs.readFileSync(demPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Compute total Haversine distance for a list of records
// ---------------------------------------------------------------------------
function totalDistance(records) {
    let dist = 0;
    for (let i = 1; i < records.length; i++) {
        dist += haversineDistance(
            records[i - 1].latitude, records[i - 1].longitude,
            records[i].latitude, records[i].longitude,
        );
    }
    return dist;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
    console.log('KOTR 2026 — Inline Data Generator');
    console.log('==================================\n');

    const elevationProfiles = {};   // keyed by source filename
    const routeDataEntries = [];    // for data-inline.js
    const routeGPS = {};            // for gps-inline.js

    for (const route of ROUTES) {
        const filePath = path.join(ROUTES_DIR, route.file);
        if (!fs.existsSync(filePath)) {
            console.error(`  SKIP: file not found — ${route.file}`);
            continue;
        }

        // Parse GPS records
        const records = parseRouteFile(filePath);

        // Load DEM elevation data
        const dem = loadDemJson(filePath);
        const elevations = dem.elevations;
        const stats = dem.stats;

        // Distance via Haversine
        const distanceKm = totalDistance(records);

        // --- elevation-profiles.json ---
        const profileElevations = downsample(elevations, 50);
        elevationProfiles[route.file] = {
            elevations: profileElevations.map(v => Math.round(v * 10) / 10),
            min: stats.minElevation,
            max: stats.maxElevation,
            gain: stats.elevationGain,
        };

        // --- data-inline.js entries ---
        const chartElevations = downsample(elevations, 200);
        const chartElevationsRounded = chartElevations.map(v => Math.round(v * 10) / 10);
        const base64Elev = float32ToBase64(chartElevationsRounded);

        routeDataEntries.push({
            day: route.day,
            variant: route.variant,
            label: route.label,
            date: route.date,
            distance_km: Math.round(distanceKm * 10) / 10,
            elevation_gain: stats.elevationGain,
            elevation_max: stats.maxElevation,
            _elevation_min: stats.minElevation,
            _elevations_plain: chartElevationsRounded,
            _course_points: [
                { name: records[0] ? route.label : 'Start', type: 'generic', dist: 0 },
                { name: records[records.length - 1] ? route.label : 'End', type: 'generic', dist: Math.round(distanceKm * 1000 * 10) / 10 },
            ],
            _start: { lat: records[0].latitude, lon: records[0].longitude },
        });

        // --- gps-inline.js ---
        const key = `day${route.day}_${route.variant}`;
        const coords = records.map(r => [
            Math.round(r.longitude * 100000) / 100000,
            Math.round(r.latitude * 100000) / 100000,
        ]);
        const downCoords = downsampleCoords(coords, 500);
        const roundedCoords = downCoords.map(c => [
            Math.round(c[0] * 100000) / 100000,
            Math.round(c[1] * 100000) / 100000,
        ]);

        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const [lon, lat] of roundedCoords) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }

        routeGPS[key] = {
            coordinates: roundedCoords,
            bounds: { minLon, maxLon, minLat, maxLat },
        };

        // Print stats
        console.log(`  ${route.label} (${route.file})`);
        console.log(`    Points: ${records.length}  |  DEM points: ${elevations.length}`);
        console.log(`    Distance: ${Math.round(distanceKm * 10) / 10} km`);
        console.log(`    Elevation: ${stats.minElevation}m – ${stats.maxElevation}m  |  gain: +${stats.elevationGain}m`);
        console.log('');
    }

    // -----------------------------------------------------------------------
    // Load POI data (pass through as-is)
    // -----------------------------------------------------------------------
    const poiDataPath = path.join(PROJECT_ROOT, 'radial', 'poi-data.json');
    let poiData = {};
    if (fs.existsSync(poiDataPath)) {
        poiData = JSON.parse(fs.readFileSync(poiDataPath, 'utf8'));
    }

    // -----------------------------------------------------------------------
    // Write output files
    // -----------------------------------------------------------------------

    // 1. routes/elevation-profiles.json
    const profilesPath = path.join(ROUTES_DIR, 'elevation-profiles.json');
    fs.writeFileSync(profilesPath, JSON.stringify(elevationProfiles, null, 2));
    console.log(`Wrote ${profilesPath}`);

    // 2. Build data-inline JS content matching the format the visualization pages expect:
    //    const ROUTE_DATA = [...];
    //    const POI_DATA = {...};
    //    Using plain number arrays for elevations (not base64 Float32Array)
    const dataInlineEntries = routeDataEntries.map(entry => {
        return JSON.stringify({
            day: entry.day,
            variant: entry.variant,
            label: entry.label,
            date: entry.date,
            distance_km: entry.distance_km,
            distance_mi: Math.round(entry.distance_km * 0.621371 * 10) / 10,
            elevation_gain: entry.elevation_gain,
            elevation_max: entry.elevation_max,
            elevation_min: entry._elevation_min,
            elevations: entry._elevations_plain,
            course_points: entry._course_points,
            start: entry._start,
        });
    });

    const dataInlineContent = 'const ROUTE_DATA = [' + dataInlineEntries.join(',') + '];\n\n'
        + 'const POI_DATA = ' + JSON.stringify(poiData) + ';\n';

    // 3. Build gps-inline JS content
    const gpsInlineContent = 'const ROUTE_GPS = ' + JSON.stringify(routeGPS) + ';\n';

    // Write compare/data-inline.js and compare/gps-inline.js
    const compareDIPath = path.join(PROJECT_ROOT, 'compare', 'data-inline.js');
    fs.writeFileSync(compareDIPath, dataInlineContent);
    console.log(`Wrote ${compareDIPath}`);

    const compareGPSPath = path.join(PROJECT_ROOT, 'compare', 'gps-inline.js');
    fs.writeFileSync(compareGPSPath, gpsInlineContent);
    console.log(`Wrote ${compareGPSPath}`);

    // Write skyline/data-inline.js, pace/data-inline.js, radial/data-inline.js
    for (const subdir of ['skyline', 'pace', 'radial']) {
        const diPath = path.join(PROJECT_ROOT, subdir, 'data-inline.js');
        fs.writeFileSync(diPath, dataInlineContent);
        console.log(`Wrote ${diPath}`);
    }

    console.log('\nDone — all inline data files generated.');
}

main();

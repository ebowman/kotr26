#!/usr/bin/env node
/**
 * One-time DEM elevation download for all routes
 * Creates sidecar .dem.json files with Mapbox terrain elevation data
 *
 * Usage: node scripts/download-dem.js [--force]
 *   --force: Re-download even if DEM file exists
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { PNG } = require('pngjs');

const MAPBOX_TOKEN = 'pk.eyJ1IjoiZWJvd21hbiIsImEiOiJjbWE1ZWVwdzYwODhwMmlzZnU4NTlyem1rIn0.E10X5hj2NTgViJexKpvrOg';
const SEMICIRCLE_TO_DEGREE = 180 / Math.pow(2, 31);

// ============= Simple FIT Parser =============
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
                offset++;
                const arch = dataView.getUint8(offset);
                offset++;
                const isLittleEndian = arch === 0;
                const globalMsgNum = isLittleEndian ? dataView.getUint16(offset, true) : dataView.getUint16(offset, false);
                offset += 2;
                const numFields = dataView.getUint8(offset);
                offset++;
                const fields = [];
                for (let i = 0; i < numFields; i++) {
                    fields.push({
                        fieldDefNum: dataView.getUint8(offset),
                        size: dataView.getUint8(offset + 1),
                        baseType: dataView.getUint8(offset + 2)
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
                    } catch(e) {}
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

// ============= Mapbox DEM =============
function lonLatToPixelInTile(lon, lat, zoom, tileSize = 512) {
    const scale = Math.pow(2, zoom);
    const worldX = (lon + 180) / 360 * scale;
    const worldY = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * scale;
    return {
        tileX: Math.floor(worldX), tileY: Math.floor(worldY),
        pixelX: Math.floor((worldX - Math.floor(worldX)) * tileSize),
        pixelY: Math.floor((worldY - Math.floor(worldY)) * tileSize)
    };
}

const tileCache = new Map();

async function fetchTile(x, y, zoom) {
    const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${zoom}/${x}/${y}@2x.pngraw?access_token=${MAPBOX_TOKEN}`;
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for tile ${zoom}/${x}/${y}`));
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                new PNG().parse(Buffer.concat(chunks), (err, png) => {
                    if (err) reject(err); else resolve(png);
                });
            });
        }).on('error', reject);
    });
}

async function getElevationFromDEM(lon, lat, zoom = 14) {
    const { tileX, tileY, pixelX, pixelY } = lonLatToPixelInTile(lon, lat, zoom, 512);
    const tileKey = `${zoom}/${tileX}/${tileY}`;

    let png = tileCache.get(tileKey);
    if (!png) {
        png = await fetchTile(tileX, tileY, zoom);
        tileCache.set(tileKey, png);
    }

    const idx = (pixelY * 512 + pixelX) * 4;
    const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2];
    return -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
}

// ============= Main Processing =============
async function processRoute(fitFilePath, force = false) {
    const routeName = path.basename(fitFilePath, '.fit');
    const demFilePath = fitFilePath.replace('.fit', '.dem.json');

    console.log(`\nProcessing: ${routeName}`);

    // Check if DEM file already exists
    if (fs.existsSync(demFilePath) && !force) {
        console.log(`  DEM file already exists, skipping... (use --force to re-download)`);
        return;
    }

    // Parse FIT file
    const buffer = fs.readFileSync(fitFilePath);
    const parser = new SimpleFitParser();
    const records = parser.parse(buffer);

    console.log(`  Parsed ${records.length} GPS points`);

    // Fetch DEM elevations for all points
    const demElevations = [];
    const batchSize = 100;

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        try {
            const demElev = await getElevationFromDEM(record.longitude, record.latitude);
            demElevations.push(Math.round(demElev * 10) / 10); // Round to 0.1m
        } catch (e) {
            console.log(`  Warning: DEM fetch failed at point ${i}, using GPS elevation`);
            demElevations.push(Math.round((record.altitude || 0) * 10) / 10);
        }

        if ((i + 1) % batchSize === 0) {
            process.stdout.write(`  Fetched ${i + 1}/${records.length} elevations (${tileCache.size} tiles cached)\r`);
        }
    }

    console.log(`  Fetched ${records.length}/${records.length} elevations (${tileCache.size} tiles cached)`);

    // Smooth elevation data to reduce noise (moving average)
    const smoothed = [];
    const windowSize = 5; // ~25-50m window depending on point spacing
    for (let i = 0; i < demElevations.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - windowSize); j <= Math.min(demElevations.length - 1, i + windowSize); j++) {
            sum += demElevations[j];
            count++;
        }
        smoothed.push(sum / count);
    }

    // Calculate stats using industry-standard algorithm:
    // Track direction changes and only count segments that exceed threshold
    // This matches how Strava and other apps calculate elevation gain
    let elevGain = 0, elevLoss = 0;
    let minElev = Infinity, maxElev = -Infinity;

    // Threshold for counting a climb/descent (calibrated to match Strava)
    const THRESHOLD = 3.5;

    // Find local extrema (peaks and valleys) and sum significant changes
    let lastExtreme = smoothed[0];
    let wasClimbing = smoothed.length > 1 ? smoothed[1] > smoothed[0] : false;

    for (let i = 0; i < demElevations.length; i++) {
        const rawElev = demElevations[i];

        // Track raw min/max from original data
        if (rawElev < minElev) minElev = rawElev;
        if (rawElev > maxElev) maxElev = rawElev;

        if (i > 0) {
            const isClimbing = smoothed[i] > smoothed[i - 1];

            // Direction change detected - we found a local extremum
            if (isClimbing !== wasClimbing) {
                const change = smoothed[i - 1] - lastExtreme;
                if (Math.abs(change) >= THRESHOLD) {
                    if (change > 0) {
                        elevGain += change;
                    } else {
                        elevLoss += Math.abs(change);
                    }
                    lastExtreme = smoothed[i - 1];
                }
                wasClimbing = isClimbing;
            }
        }
    }

    // Handle final segment
    const finalChange = smoothed[smoothed.length - 1] - lastExtreme;
    if (Math.abs(finalChange) >= THRESHOLD) {
        if (finalChange > 0) elevGain += finalChange;
        else elevLoss += Math.abs(finalChange);
    }

    // Create DEM data file
    const demData = {
        version: 1,
        source: 'mapbox-terrain-dem-v1',
        generatedAt: new Date().toISOString(),
        pointCount: demElevations.length,
        stats: {
            minElevation: Math.round(minElev),
            maxElevation: Math.round(maxElev),
            elevationGain: Math.round(elevGain),
            elevationLoss: Math.round(elevLoss)
        },
        elevations: demElevations
    };

    fs.writeFileSync(demFilePath, JSON.stringify(demData));

    console.log(`  Saved: ${demFilePath}`);
    console.log(`  Stats: ${demData.stats.minElevation}m - ${demData.stats.maxElevation}m, +${demData.stats.elevationGain}m / -${demData.stats.elevationLoss}m`);
}

async function main() {
    const force = process.argv.includes('--force');

    console.log('DEM Elevation Downloader');
    console.log('========================');
    console.log('Downloading Mapbox terrain elevation for all routes...');
    if (force) console.log('(Force mode: re-downloading all files)\n');

    const routesDir = 'routes';
    const fitFiles = fs.readdirSync(routesDir)
        .filter(f => f.endsWith('.fit'))
        .map(f => path.join(routesDir, f));

    console.log(`Found ${fitFiles.length} FIT files`);

    for (const fitFile of fitFiles) {
        await processRoute(fitFile, force);
    }

    console.log('\n✓ All routes processed!');
    console.log(`  Total tiles fetched: ${tileCache.size}`);
}

main().catch(console.error);

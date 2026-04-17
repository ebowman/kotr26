/**
 * KOTR 2026 - FIT File Parser
 * Parses Garmin FIT files in the browser without external dependencies
 *
 * FIT Format: https://developer.garmin.com/fit/protocol/
 */

const FitParser = (function() {
    'use strict';

    // FIT File constants
    const FIT_HEADER_SIZE = 14;

    // Semicircle conversion factor for GPS coordinates
    const SEMICIRCLE_TO_DEGREE = 180.0 / Math.pow(2, 31);

    // FIT Message Types (only those we parse)
    const MESSAGE_TYPES = {
        SESSION: 18,
        LAP: 19,
        RECORD: 20,
        EVENT: 21,
        DEVICE_INFO: 23,
        COURSE_POINT: 32
    };

    // FIT course_point.type enum → our narrow category set. Navigation cues
    // (left/right/straight/u_turn/forks/*) are intentionally dropped per the
    // user's filter preference. Unmapped values fall through to 'nav' so the
    // caller can skip them uniformly.
    const COURSE_POINT_CATEGORY = {
        0: 'marker',      // generic (start/end flags)
        1: 'summit',
        2: 'valley',
        3: 'water',
        4: 'food',
        5: 'danger',
        9: 'first_aid',
        27: 'campsite',
        28: 'aid_station',
        29: 'rest_area',
        31: 'service',
        39: 'toilet',
        40: 'shower',
    };
    const POI_VISIBLE = new Set(['food', 'toilet', 'water', 'danger', 'first_aid', 'aid_station', 'rest_area', 'shower', 'marker']);

    // Base types for FIT data fields
    // Key is base type NUMBER (bits 0-4 of baseType byte)
    const BASE_TYPES = {
        0x00: { name: 'enum', size: 1, invalid: 0xFF },
        0x01: { name: 'sint8', size: 1, invalid: 0x7F },
        0x02: { name: 'uint8', size: 1, invalid: 0xFF },
        0x03: { name: 'sint16', size: 2, invalid: 0x7FFF },
        0x04: { name: 'uint16', size: 2, invalid: 0xFFFF },
        0x05: { name: 'sint32', size: 4, invalid: 0x7FFFFFFF },
        0x06: { name: 'uint32', size: 4, invalid: 0xFFFFFFFF },
        0x07: { name: 'string', size: 1, invalid: 0x00 },
        0x08: { name: 'float32', size: 4, invalid: 0xFFFFFFFF },
        0x09: { name: 'float64', size: 8, invalid: 0xFFFFFFFFFFFFFFFF },
        0x0A: { name: 'uint8z', size: 1, invalid: 0x00 },
        0x0B: { name: 'uint16z', size: 2, invalid: 0x0000 },
        0x0C: { name: 'uint32z', size: 4, invalid: 0x00000000 },
        0x0D: { name: 'byte', size: 1, invalid: 0xFF },
        0x0E: { name: 'sint64', size: 8, invalid: 0x7FFFFFFFFFFFFFFF },
        0x0F: { name: 'uint64', size: 8, invalid: 0xFFFFFFFFFFFFFFFF },
        0x10: { name: 'uint64z', size: 8, invalid: 0 }
    };

    /**
     * Main parser class
     */
    class FitFileParser {
        constructor() {
            this.records = [];
            this.coursePoints = [];
            this.laps = [];
            this.sessions = [];
            this.events = [];
            this.deviceInfo = [];
            this.definitions = {};
        }

        /**
         * Parse a FIT file from an ArrayBuffer
         * @param {ArrayBuffer} buffer - The FIT file data
         * @returns {Object} Parsed route data
         */
        parse(buffer) {
            this.buffer = buffer;
            this.dataView = new DataView(buffer);
            this.offset = 0;

            // Parse header
            const header = this.parseHeader();
            if (!header.valid) {
                throw new Error('Invalid FIT file header');
            }

            // Parse data records
            const dataEnd = header.headerSize + header.dataSize;
            this.offset = header.headerSize;

            while (this.offset < dataEnd) {
                this.parseRecord();
            }

            // Build route data from parsed records
            return this.buildRouteData();
        }

        /**
         * Parse FIT file header
         */
        parseHeader() {
            const headerSize = this.dataView.getUint8(0);
            const protocolVersion = this.dataView.getUint8(1);
            const profileVersion = this.dataView.getUint16(2, true);
            const dataSize = this.dataView.getUint32(4, true);
            const dataType = String.fromCharCode(
                this.dataView.getUint8(8),
                this.dataView.getUint8(9),
                this.dataView.getUint8(10),
                this.dataView.getUint8(11)
            );

            const valid = dataType === '.FIT';

            return {
                headerSize,
                protocolVersion,
                profileVersion,
                dataSize,
                dataType,
                valid
            };
        }

        /**
         * Parse a single record from the FIT file
         */
        parseRecord() {
            const recordHeader = this.dataView.getUint8(this.offset);
            this.offset++;

            // Check if this is a definition message or data message
            const isDefinition = (recordHeader & 0x40) !== 0;
            const localMessageType = recordHeader & 0x0F;
            const isCompressedTimestamp = (recordHeader & 0x80) !== 0;

            if (isCompressedTimestamp) {
                // Compressed timestamp header
                const timeOffset = recordHeader & 0x1F;
                const localMsgType = (recordHeader >> 5) & 0x03;
                this.parseDataMessage(localMsgType);
            } else if (isDefinition) {
                this.parseDefinitionMessage(localMessageType);
            } else {
                this.parseDataMessage(localMessageType);
            }
        }

        /**
         * Parse a definition message
         */
        parseDefinitionMessage(localMessageType) {
            // Reserved byte
            this.offset++;

            // Architecture (0 = little endian, 1 = big endian)
            const architecture = this.dataView.getUint8(this.offset);
            this.offset++;
            const isLittleEndian = architecture === 0;

            // Global message number
            const globalMessageNumber = this.dataView.getUint16(this.offset, isLittleEndian);
            this.offset += 2;

            // Number of fields
            const numFields = this.dataView.getUint8(this.offset);
            this.offset++;

            // Parse field definitions
            const fields = [];
            for (let i = 0; i < numFields; i++) {
                const fieldDefNum = this.dataView.getUint8(this.offset);
                const fieldSize = this.dataView.getUint8(this.offset + 1);
                const baseType = this.dataView.getUint8(this.offset + 2);
                this.offset += 3;

                fields.push({
                    fieldDefNum,
                    fieldSize,
                    baseType
                });
            }

            // Store definition
            this.definitions[localMessageType] = {
                globalMessageNumber,
                isLittleEndian,
                fields
            };

        }

        /**
         * Parse a data message
         */
        parseDataMessage(localMessageType) {
            const definition = this.definitions[localMessageType];
            if (!definition) {
                // Skip unknown message type
                return;
            }

            const data = {};
            data._messageType = definition.globalMessageNumber;

            for (const field of definition.fields) {
                const value = this.readFieldValue(field, definition.isLittleEndian);
                data[field.fieldDefNum] = value;
            }

            // Store parsed data based on message type
            switch (definition.globalMessageNumber) {
                case MESSAGE_TYPES.RECORD:
                    this.parseRecordMessage(data);
                    break;
                case MESSAGE_TYPES.LAP:
                    this.laps.push(data);
                    break;
                case MESSAGE_TYPES.SESSION:
                    this.sessions.push(data);
                    break;
                case MESSAGE_TYPES.EVENT:
                    this.events.push(data);
                    break;
                case MESSAGE_TYPES.DEVICE_INFO:
                    this.deviceInfo.push(data);
                    break;
                case MESSAGE_TYPES.COURSE_POINT:
                    this.parseCoursePointMessage(data);
                    break;
            }
        }

        // course_point field numbers (per FIT profile):
        //   1=timestamp, 2=position_lat, 3=position_long, 4=distance (cm),
        //   5=type (enum), 6=name (string), 254=message_index
        // Ride with GPS pre-truncates name to ~10-16 chars for Garmin display.
        parseCoursePointMessage(data) {
            const typeEnum = data[5];
            const category = COURSE_POINT_CATEGORY[typeEnum] || 'nav';
            if (!POI_VISIBLE.has(category)) return; // drop navigation cues
            const cp = { category, typeEnum };
            if (data[2] !== undefined && data[2] !== 0x7FFFFFFF) {
                cp.lat = data[2] * SEMICIRCLE_TO_DEGREE;
            }
            if (data[3] !== undefined && data[3] !== 0x7FFFFFFF) {
                cp.lon = data[3] * SEMICIRCLE_TO_DEGREE;
            }
            if (data[4] !== undefined && data[4] !== 0xFFFFFFFF) {
                cp.distance_km = data[4] / 100000;
            }
            if (typeof data[6] === 'string') cp.name = data[6];
            this.coursePoints.push(cp);
        }

        /**
         * Read a field value based on its type
         */
        readFieldValue(field, isLittleEndian) {
            const baseTypeInfo = BASE_TYPES[field.baseType & 0x1F] || BASE_TYPES[0x02];
            let value = null;

            try {
                switch (baseTypeInfo.name) {
                    case 'enum':
                    case 'uint8':
                    case 'uint8z':
                    case 'byte':
                        value = this.dataView.getUint8(this.offset);
                        break;
                    case 'sint8':
                        value = this.dataView.getInt8(this.offset);
                        break;
                    case 'uint16':
                    case 'uint16z':
                        value = this.dataView.getUint16(this.offset, isLittleEndian);
                        break;
                    case 'sint16':
                        value = this.dataView.getInt16(this.offset, isLittleEndian);
                        break;
                    case 'uint32':
                    case 'uint32z':
                        value = this.dataView.getUint32(this.offset, isLittleEndian);
                        break;
                    case 'sint32':
                        value = this.dataView.getInt32(this.offset, isLittleEndian);
                        break;
                    case 'float32':
                        value = this.dataView.getFloat32(this.offset, isLittleEndian);
                        break;
                    case 'float64':
                        value = this.dataView.getFloat64(this.offset, isLittleEndian);
                        break;
                    case 'string':
                        value = this.readString(field.fieldSize);
                        break;
                    default:
                        value = this.dataView.getUint8(this.offset);
                }
            } catch (e) {
                value = null;
            }

            this.offset += field.fieldSize;
            return value;
        }

        // Pure read — caller (readFieldValue) advances offset by fieldSize.
        readString(maxLength) {
            let str = '';
            for (let i = 0; i < maxLength; i++) {
                const char = this.dataView.getUint8(this.offset + i);
                if (char === 0) break;
                str += String.fromCharCode(char);
            }
            return str;
        }

        /**
         * Parse a record message and extract GPS data
         */
        parseRecordMessage(data) {
            const record = {};

            // Timestamp
            if (data[253] !== undefined) {
                record.timestamp = data[253];
            }

            // Position (semicircles to degrees)
            // Field 0 = position_lat, Field 1 = position_long
            if (data[0] !== undefined && data[0] !== 0x7FFFFFFF) {
                record.latitude = data[0] * SEMICIRCLE_TO_DEGREE;
            }
            if (data[1] !== undefined && data[1] !== 0x7FFFFFFF) {
                record.longitude = data[1] * SEMICIRCLE_TO_DEGREE;
            }

            // Altitude (scaled, in meters with 5m offset and 5 scale)
            if (data[78] !== undefined && data[78] !== 0xFFFFFFFF) {
                // Enhanced altitude (0.2m resolution, 500m offset)
                record.altitude = (data[78] / 5.0) - 500;
            } else if (data[2] !== undefined && data[2] !== 0xFFFF) {
                // Standard altitude (5m resolution)
                record.altitude = (data[2] / 5.0) - 500;
            }

            // Distance (in centimeters to kilometers)
            if (data[5] !== undefined && data[5] !== 0xFFFFFFFF) {
                record.distance = data[5] / 100000.0; // cm to km
            }

            // Speed (mm/s to km/h)
            if (data[73] !== undefined && data[73] !== 0xFFFF) {
                record.speed = (data[73] / 1000.0) * 3.6;
            } else if (data[6] !== undefined && data[6] !== 0xFFFF) {
                record.speed = (data[6] / 1000.0) * 3.6;
            }

            // Heart rate
            if (data[3] !== undefined && data[3] !== 0xFF) {
                record.heartRate = data[3];
            }

            // Cadence
            if (data[4] !== undefined && data[4] !== 0xFF) {
                record.cadence = data[4];
            }

            // Power
            if (data[7] !== undefined && data[7] !== 0xFFFF) {
                record.power = data[7];
            }

            // Temperature
            if (data[13] !== undefined && data[13] !== 0x7F) {
                record.temperature = data[13];
            }

            // Only add records with valid GPS coordinates
            if (record.latitude !== undefined && record.longitude !== undefined) {
                this.records.push(record);
            }
        }

        /**
         * Build the final route data object
         */
        buildRouteData() {
            const coordinates = this.records
                .filter(r => r.latitude !== undefined && r.longitude !== undefined)
                .map(r => [r.longitude, r.latitude, r.altitude != null ? r.altitude : 0]);

            const halfWindow = (window.KOTR_CONFIG && window.KOTR_CONFIG.ELEV_SMOOTH_HALF_WINDOW) || 5;
            const threshold = (window.KOTR_CONFIG && window.KOTR_CONFIG.ELEV_GAIN_THRESHOLD_M) || 3.5;
            const smoothedElevations = window.KOTR_GEO.smoothElevations(
                coordinates.map(c => c[2]),
                halfWindow
            );

            let minElevation = Infinity;
            let maxElevation = -Infinity;
            for (const c of coordinates) {
                if (c[2] < minElevation) minElevation = c[2];
                if (c[2] > maxElevation) maxElevation = c[2];
            }

            const { gain: totalElevationGain } = window.KOTR_GEO.walkElevationGain(smoothedElevations, threshold);

            // Prefer the distance field FIT already records; fall back to haversine.
            let totalDistance = 0;
            const lastRecord = this.records[this.records.length - 1];
            if (lastRecord && lastRecord.distance) {
                totalDistance = lastRecord.distance;
            } else {
                totalDistance = this.calculateTotalDistance(coordinates);
            }

            // Calculate bounds
            const bounds = this.calculateBounds(coordinates);

            return {
                coordinates,
                distance: Math.round(totalDistance * 10) / 10, // km, 1 decimal
                elevationGain: Math.round(totalElevationGain),
                minElevation: Math.round(minElevation),
                maxElevation: Math.round(maxElevation),
                bounds,
                pointCount: coordinates.length,
                records: this.records,
                pois: this.coursePoints,
                laps: this.laps,
                sessions: this.sessions
            };
        }

        calculateTotalDistance(coordinates) {
            let total = 0;
            for (let i = 1; i < coordinates.length; i++) {
                total += window.KOTR_GEO.haversineKm(
                    coordinates[i - 1][1], coordinates[i - 1][0],
                    coordinates[i][1], coordinates[i][0]
                );
            }
            return total;
        }

        // Kept as instance methods only because older code paths may still call
        // them — delegate to the shared module.
        haversineDistance(lat1, lon1, lat2, lon2) {
            return window.KOTR_GEO.haversineKm(lat1, lon1, lat2, lon2);
        }

        toRad(deg) {
            return window.KOTR_GEO.toRad(deg);
        }

        smoothElevations(elevations, halfWindow) {
            return window.KOTR_GEO.smoothElevations(elevations, halfWindow);
        }

        calculateBounds(coordinates) {
            if (coordinates.length === 0) {
                return null;
            }

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
    }

    /**
     * Load and parse a FIT file
     * @param {string} url - URL to the FIT file
     * @returns {Promise<Object>} Parsed route data
     */
    async function loadFitFile(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load FIT file: ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        const parser = new FitFileParser();
        const routeData = parser.parse(buffer);

        // Try to load DEM sidecar file for accurate elevation data
        const demUrl = url.replace('.fit', '.dem.json');
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
            // Network / JSON parse failures are worth knowing about — a missing
            // sidecar comes back as !ok above, not as a thrown exception.
            console.warn(`DEM load failed for ${demUrl}:`, e.message || e);
        }

        return routeData;
    }

    /**
     * Convert route data to GPX format for download
     * @param {Object} routeData - Parsed route data
     * @param {string} name - Route name
     * @returns {string} GPX XML string
     */
    function escapeXml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function routeToGPX(routeData, name = 'KOTR Route') {
        name = escapeXml(name);
        const points = routeData.coordinates.map(coord => {
            const [lon, lat, ele] = coord;
            return `      <trkpt lat="${lat}" lon="${lon}">
        <ele>${ele}</ele>
      </trkpt>`;
        }).join('\n');

        return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="KOTR 2026"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
    <desc>KOTR 2026 - King of the Road Avignon</desc>
    <author>
      <name>KOTR 2026</name>
    </author>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
    }

    /**
     * Download GPX file
     * @param {Object} routeData - Parsed route data
     * @param {string} filename - Output filename
     */
    function downloadGPX(routeData, filename) {
        const gpx = routeToGPX(routeData, filename.replace('.gpx', ''));
        const blob = new Blob([gpx], { type: 'application/gpx+xml' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename.endsWith('.gpx') ? filename : `${filename}.gpx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Public API
    return {
        FitFileParser,
        loadFitFile,
        routeToGPX,
        downloadGPX
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FitParser;
}

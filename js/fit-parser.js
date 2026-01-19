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
    const FIT_PROTOCOL_VERSION_MAJOR = 2;
    const FIT_PROFILE_VERSION_MAJOR = 21;

    // Semicircle conversion factor for GPS coordinates
    const SEMICIRCLE_TO_DEGREE = 180.0 / Math.pow(2, 31);

    // Global FIT Message Types
    const MESSAGE_TYPES = {
        FILE_ID: 0,
        CAPABILITIES: 1,
        DEVICE_SETTINGS: 2,
        USER_PROFILE: 3,
        HRM_PROFILE: 4,
        SDM_PROFILE: 5,
        BIKE_PROFILE: 6,
        ZONES_TARGET: 7,
        HR_ZONE: 8,
        POWER_ZONE: 9,
        MET_ZONE: 10,
        SPORT: 12,
        GOAL: 15,
        SESSION: 18,
        LAP: 19,
        RECORD: 20,
        EVENT: 21,
        DEVICE_INFO: 23,
        WORKOUT: 26,
        WORKOUT_STEP: 27,
        SCHEDULE: 28,
        WEIGHT_SCALE: 30,
        COURSE: 31,
        COURSE_POINT: 32,
        TOTALS: 33,
        ACTIVITY: 34,
        SOFTWARE: 35,
        FILE_CAPABILITIES: 37,
        MESG_CAPABILITIES: 38,
        FIELD_CAPABILITIES: 39,
        FILE_CREATOR: 49,
        BLOOD_PRESSURE: 51,
        SPEED_ZONE: 53,
        MONITORING: 55,
        TRAINING_FILE: 72,
        HRV: 78,
        LENGTH: 101,
        MONITORING_INFO: 103,
        PAD: 105,
        SLAVE_DEVICE: 106,
        CONNECTIVITY: 127,
        WEATHER_CONDITIONS: 128,
        WEATHER_ALERT: 129,
        GPS_METADATA: 160,
        CAMERA_EVENT: 161,
        TIMESTAMP_CORRELATION: 162,
        GYROSCOPE_DATA: 164,
        ACCELEROMETER_DATA: 165,
        THREE_D_SENSOR_CALIBRATION: 167,
        VIDEO_FRAME: 169,
        OBDII_DATA: 174,
        NMEA_SENTENCE: 177,
        AVIATION_ATTITUDE: 178,
        VIDEO: 184,
        VIDEO_TITLE: 185,
        VIDEO_DESCRIPTION: 186,
        VIDEO_CLIP: 187,
        OHR_SETTINGS: 188,
        EXD_SCREEN_CONFIGURATION: 200,
        EXD_DATA_FIELD_CONFIGURATION: 201,
        EXD_DATA_CONCEPT_CONFIGURATION: 202,
        FIELD_DESCRIPTION: 206,
        DEVELOPER_DATA_ID: 207,
        MAGNETOMETER_DATA: 208,
        BAROMETER_DATA: 209,
        ONE_D_SENSOR_CALIBRATION: 210,
        DIVE_SUMMARY: 268,
        CLIMB_PRO: 317
    };

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

    // Record field definitions (message type 20)
    const RECORD_FIELDS = {
        253: 'timestamp',
        0: 'position_lat',
        1: 'position_long',
        2: 'altitude',
        3: 'heart_rate',
        4: 'cadence',
        5: 'distance',
        6: 'speed',
        7: 'power',
        13: 'temperature',
        73: 'enhanced_speed',
        78: 'enhanced_altitude'
    };

    /**
     * Main parser class
     */
    class FitFileParser {
        constructor() {
            this.records = [];
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

            // Debug: log record message definitions
            if (globalMessageNumber === MESSAGE_TYPES.RECORD) {
                console.log('Record message definition - localMsgType:', localMessageType, 'littleEndian:', isLittleEndian);
                console.log('Fields:', JSON.stringify(fields.map(f => ({
                    num: f.fieldDefNum,
                    size: f.fieldSize,
                    type: '0x' + f.baseType.toString(16)
                }))));
            }
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
            }
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
                        this.offset -= field.fieldSize; // readString advances offset, reset it
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

        /**
         * Read a null-terminated string
         */
        readString(maxLength) {
            let str = '';
            for (let i = 0; i < maxLength; i++) {
                const char = this.dataView.getUint8(this.offset + i);
                if (char === 0) break;
                str += String.fromCharCode(char);
            }
            this.offset += maxLength;
            return str;
        }

        /**
         * Parse a record message and extract GPS data
         */
        parseRecordMessage(data) {
            const record = {};

            // Debug: log first few records to see raw data
            if (this.records.length < 3) {
                console.log('Raw record data:', data);
            }

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

            // Debug first record with coordinates
            if (this.records.length < 3 && record.latitude !== undefined) {
                console.log('Parsed coords:', {
                    rawLat: data[0],
                    rawLng: data[1],
                    lat: record.latitude,
                    lng: record.longitude
                });
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
                .filter(r => r.latitude && r.longitude)
                .map(r => [r.longitude, r.latitude, r.altitude || 0]);

            // Smooth elevation data to reduce GPS noise before calculating gain
            // This prevents small oscillations from being counted as climbing
            const smoothedElevations = this.smoothElevations(
                coordinates.map(c => c[2]),
                5 // window size of 5 points (~15-25m typically)
            );

            // Calculate total stats using smoothed elevation for gain calculation
            let totalDistance = 0;
            let totalElevationGain = 0;
            let minElevation = Infinity;
            let maxElevation = -Infinity;

            for (let i = 0; i < coordinates.length; i++) {
                const elevation = coordinates[i][2]; // Use raw for min/max
                const smoothedElev = smoothedElevations[i];

                if (elevation < minElevation) minElevation = elevation;
                if (elevation > maxElevation) maxElevation = elevation;

                if (i > 0) {
                    // Use smoothed elevation for gain calculation to reduce noise
                    const elevDiff = smoothedElev - smoothedElevations[i - 1];
                    // Only count gains above a small threshold to filter remaining noise
                    if (elevDiff > 0.1) {
                        totalElevationGain += elevDiff;
                    }
                }
            }

            // Get distance from last record or calculate
            const lastRecord = this.records[this.records.length - 1];
            if (lastRecord && lastRecord.distance) {
                totalDistance = lastRecord.distance;
            } else {
                // Calculate using Haversine formula
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
                laps: this.laps,
                sessions: this.sessions
            };
        }

        /**
         * Calculate total distance using Haversine formula
         */
        calculateTotalDistance(coordinates) {
            let total = 0;
            for (let i = 1; i < coordinates.length; i++) {
                total += this.haversineDistance(
                    coordinates[i - 1][1], coordinates[i - 1][0],
                    coordinates[i][1], coordinates[i][0]
                );
            }
            return total;
        }

        /**
         * Haversine distance formula
         */
        haversineDistance(lat1, lon1, lat2, lon2) {
            const R = 6371; // Earth's radius in km
            const dLat = this.toRad(lat2 - lat1);
            const dLon = this.toRad(lon2 - lon1);
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }

        toRad(deg) {
            return deg * (Math.PI / 180);
        }

        /**
         * Smooth elevation data using a moving average to reduce GPS noise
         * @param {number[]} elevations - Array of elevation values
         * @param {number} windowSize - Number of points on each side to average
         * @returns {number[]} Smoothed elevation array
         */
        smoothElevations(elevations, windowSize) {
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
         * Calculate geographic bounds
         */
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
        try {
            const demResponse = await fetch(demUrl);
            if (demResponse.ok) {
                const demData = await demResponse.json();
                if (demData.elevations && demData.elevations.length === routeData.coordinates.length) {
                    console.log(`Loaded DEM elevation data for ${url}`);

                    // Replace GPS elevation with DEM elevation
                    for (let i = 0; i < routeData.coordinates.length; i++) {
                        routeData.coordinates[i][2] = demData.elevations[i];
                    }

                    // Update stats from DEM data
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
            console.log(`No DEM data available for ${url}, using GPS elevation`);
            routeData.elevationSource = 'gps';
        }

        return routeData;
    }

    /**
     * Convert route data to GPX format for download
     * @param {Object} routeData - Parsed route data
     * @param {string} name - Route name
     * @returns {string} GPX XML string
     */
    function routeToGPX(routeData, name = 'KOTR Route') {
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

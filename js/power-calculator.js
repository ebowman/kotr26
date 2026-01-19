/**
 * KOTR 2026 - Power Calculator Module
 * Physics-based cycling power calculations
 *
 * Formulas based on standard cycling physics:
 * P = (Pgravity + Prolling + Paero) / efficiency
 *
 * References:
 * - Martin et al., "Validation of a Mathematical Model for Road Cycling Power"
 * - bikecalculator.com
 */

const PowerCalculator = (function() {
    'use strict';

    // Physical constants
    const CONSTANTS = {
        g: 9.81,            // Gravitational acceleration (m/s^2)
        rho: 1.2,           // Air density at sea level (kg/m^3)
        Crr: 0.005,         // Rolling resistance coefficient (good road tires)
        CdA: 0.35,          // Drag coefficient * frontal area (m^2, hoods position)
        efficiency: 0.95,    // Drivetrain efficiency
        bikeWeight: 9        // Typical bike weight (kg)
    };

    // FTP zone definitions (% of FTP)
    const ZONES = {
        recovery:    { min: 0,   max: 55,  color: '#22C55E', label: 'Recovery' },
        endurance:   { min: 55,  max: 75,  color: '#3B82F6', label: 'Endurance' },
        tempo:       { min: 75,  max: 90,  color: '#EAB308', label: 'Tempo' },
        threshold:   { min: 90,  max: 105, color: '#F97316', label: 'Threshold' },
        vo2max:      { min: 105, max: 120, color: '#EF4444', label: 'VO2max' },
        anaerobic:   { min: 120, max: 999, color: '#DC2626', label: 'Anaerobic' }
    };

    /**
     * Calculate power required to maintain a given speed
     * @param {number} grade - Grade as decimal (e.g., 0.08 for 8%)
     * @param {number} speed - Speed in m/s
     * @param {number} riderWeight - Rider weight in kg
     * @param {object} options - Optional overrides for constants
     * @returns {number} Power in watts
     */
    function calculatePowerForSpeed(grade, speed, riderWeight, options = {}) {
        const {
            g = CONSTANTS.g,
            rho = CONSTANTS.rho,
            Crr = CONSTANTS.Crr,
            CdA = CONSTANTS.CdA,
            efficiency = CONSTANTS.efficiency,
            bikeWeight = CONSTANTS.bikeWeight
        } = options;

        const totalMass = riderWeight + bikeWeight;
        const gradeAngle = Math.atan(grade);

        // Gravity resistance (positive when climbing)
        const Pgravity = totalMass * g * Math.sin(gradeAngle) * speed;

        // Rolling resistance
        const Prolling = Crr * totalMass * g * Math.cos(gradeAngle) * speed;

        // Aerodynamic drag
        const Paero = 0.5 * CdA * rho * Math.pow(speed, 3);

        // Total power (accounting for drivetrain efficiency)
        const totalPower = (Pgravity + Prolling + Paero) / efficiency;

        // Power can't be negative (coasting downhill)
        return Math.max(0, totalPower);
    }

    /**
     * Calculate speed achievable at a given power
     * Uses iterative approach for complex equation
     * @param {number} grade - Grade as decimal
     * @param {number} power - Power in watts
     * @param {number} riderWeight - Rider weight in kg
     * @param {object} options - Optional overrides
     * @returns {number} Speed in m/s
     */
    function calculateSpeedForPower(grade, power, riderWeight, options = {}) {
        const {
            g = CONSTANTS.g,
            rho = CONSTANTS.rho,
            Crr = CONSTANTS.Crr,
            CdA = CONSTANTS.CdA,
            efficiency = CONSTANTS.efficiency,
            bikeWeight = CONSTANTS.bikeWeight
        } = options;

        const totalMass = riderWeight + bikeWeight;
        const gradeAngle = Math.atan(grade);
        const effectivePower = power * efficiency;

        // For steep descents, use terminal velocity calculation
        if (grade < -0.02 && power < 50) {
            // Terminal velocity when gravity = drag
            const gravityComponent = totalMass * g * Math.abs(Math.sin(gradeAngle));
            const rollingComponent = Crr * totalMass * g * Math.cos(gradeAngle);
            const terminalSpeed = Math.pow((gravityComponent - rollingComponent) / (0.5 * CdA * rho), 1/3);
            return Math.min(terminalSpeed, 25); // Cap at ~90 km/h for safety
        }

        // Newton-Raphson iteration to solve for speed
        let speed = 5; // Initial guess (m/s)
        const maxIterations = 50;
        const tolerance = 0.001;

        for (let i = 0; i < maxIterations; i++) {
            const Pgravity = totalMass * g * Math.sin(gradeAngle) * speed;
            const Prolling = Crr * totalMass * g * Math.cos(gradeAngle) * speed;
            const Paero = 0.5 * CdA * rho * Math.pow(speed, 3);

            const f = Pgravity + Prolling + Paero - effectivePower;

            // Derivative
            const df = totalMass * g * Math.sin(gradeAngle) +
                       Crr * totalMass * g * Math.cos(gradeAngle) +
                       1.5 * CdA * rho * Math.pow(speed, 2);

            if (Math.abs(df) < 1e-10) break;

            const newSpeed = speed - f / df;
            if (Math.abs(newSpeed - speed) < tolerance) {
                return Math.max(0.5, newSpeed); // Minimum speed 0.5 m/s
            }
            speed = Math.max(0.5, newSpeed);
        }

        return Math.max(0.5, speed);
    }

    /**
     * Calculate time to complete a segment
     * @param {object} segment - { distance (m), elevationGain (m), avgGrade }
     * @param {number} targetPower - Target power in watts
     * @param {number} riderWeight - Rider weight in kg
     * @returns {number} Time in seconds
     */
    function calculateSegmentTime(segment, targetPower, riderWeight) {
        const grade = segment.avgGrade || (segment.elevationGain / segment.distance);
        const speed = calculateSpeedForPower(grade, targetPower, riderWeight);
        return segment.distance / speed;
    }

    /**
     * Calculate W/kg required to climb at a given speed
     * @param {number} grade - Grade as decimal
     * @param {number} speedKmh - Target speed in km/h
     * @param {number} riderWeight - Rider weight in kg
     * @returns {number} W/kg required
     */
    function calculateWPerKgForSpeed(grade, speedKmh, riderWeight) {
        const speedMs = speedKmh / 3.6;
        const power = calculatePowerForSpeed(grade, speedMs, riderWeight);
        return power / riderWeight;
    }

    /**
     * Get the effort zone for a given power and FTP
     * @param {number} power - Current power in watts
     * @param {number} ftp - Functional threshold power in watts
     * @returns {object} Zone info { name, color, label, percentFtp }
     */
    function getEffortZone(power, ftp) {
        const percentFtp = (power / ftp) * 100;

        for (const [name, zone] of Object.entries(ZONES)) {
            if (percentFtp >= zone.min && percentFtp < zone.max) {
                return {
                    name,
                    color: zone.color,
                    label: zone.label,
                    percentFtp: Math.round(percentFtp)
                };
            }
        }

        return {
            name: 'anaerobic',
            color: ZONES.anaerobic.color,
            label: ZONES.anaerobic.label,
            percentFtp: Math.round(percentFtp)
        };
    }

    /**
     * Calculate comprehensive route metrics
     * @param {object} routeData - Route data with coordinates array
     * @param {number} weight - Rider weight in kg
     * @param {number} ftp - FTP in watts
     * @returns {object} Full analysis object
     */
    function calculateRouteMetrics(routeData, weight, ftp) {
        if (!routeData || !routeData.coordinates || routeData.coordinates.length < 2) {
            return null;
        }

        const coords = routeData.coordinates;
        const totalDistance = routeData.distance || 0; // km
        const elevationGain = routeData.elevationGain || 0; // m

        // Calculate average grade
        const avgGrade = totalDistance > 0 ? elevationGain / (totalDistance * 1000) : 0;

        // Target intensities for time estimates
        const intensities = [
            { label: 'Easy', percent: 0.60, description: '60% FTP' },
            { label: 'Steady', percent: 0.75, description: '75% FTP' },
            { label: 'Hard', percent: 0.90, description: '90% FTP' }
        ];

        // Calculate times at each intensity
        const timeEstimates = intensities.map(intensity => {
            const targetPower = ftp * intensity.percent;
            const segments = processRouteSegments(routeData);
            let totalTime = 0;

            segments.forEach(segment => {
                const time = calculateSegmentTime(segment, targetPower, weight);
                totalTime += time;
            });

            return {
                ...intensity,
                seconds: Math.round(totalTime),
                formatted: formatDuration(totalTime)
            };
        });

        // Calculate energy expenditure (use steady pace as reference)
        const steadyPower = ftp * 0.75;
        const steadyTime = timeEstimates[1].seconds;
        const kilojoules = Math.round((steadyPower * steadyTime) / 1000);
        const calories = Math.round(kilojoules * 0.24 * 4.18); // Approximate conversion

        // Calculate personalized difficulty score (1-10)
        const difficultyScore = calculateDifficultyScore(routeData, weight, ftp);

        // Find hardest segments (climbs)
        const climbs = detectClimbs(routeData);

        return {
            distance: totalDistance,
            elevationGain,
            avgGrade: avgGrade * 100, // as percentage
            difficultyScore,
            difficultyLabel: getDifficultyLabel(difficultyScore),
            timeEstimates,
            energy: {
                kilojoules,
                calories
            },
            climbs,
            riderProfile: {
                weight,
                ftp,
                wPerKg: (ftp / weight).toFixed(2)
            }
        };
    }

    /**
     * Process route into segments for analysis
     * @param {object} routeData - Route data
     * @returns {array} Array of segment objects
     */
    function processRouteSegments(routeData) {
        const coords = routeData.coordinates;
        const segments = [];
        const segmentLengthMeters = 100; // 100m segments

        let cumulativeDistance = 0;
        let segmentStart = 0;
        let segmentStartElevation = coords[0][2] || 0;

        for (let i = 1; i < coords.length; i++) {
            // Calculate distance using Haversine
            const dist = haversineDistance(
                coords[i-1][1], coords[i-1][0],
                coords[i][1], coords[i][0]
            ) * 1000; // Convert to meters

            cumulativeDistance += dist;

            if (cumulativeDistance >= segmentLengthMeters || i === coords.length - 1) {
                const endElevation = coords[i][2] || 0;
                const elevationGain = endElevation - segmentStartElevation;
                const avgGrade = cumulativeDistance > 0 ? elevationGain / cumulativeDistance : 0;

                segments.push({
                    distance: cumulativeDistance,
                    elevationGain,
                    avgGrade,
                    startIndex: segmentStart,
                    endIndex: i
                });

                cumulativeDistance = 0;
                segmentStart = i;
                segmentStartElevation = endElevation;
            }
        }

        return segments;
    }

    /**
     * Calculate difficulty score based on power demands vs rider ability
     * @param {object} routeData - Route data
     * @param {number} weight - Rider weight
     * @param {number} ftp - Rider FTP
     * @returns {number} Difficulty score 1-10
     */
    function calculateDifficultyScore(routeData, weight, ftp) {
        const wPerKg = ftp / weight;
        const distance = routeData.distance || 0;
        const elevation = routeData.elevationGain || 0;

        // Climbing intensity factor (elevation per km)
        const climbingIntensity = distance > 0 ? elevation / distance : 0;

        // Base difficulty from climbing (m/km)
        // 0-10 m/km = easy, 10-20 = moderate, 20-30 = hard, 30+ = extreme
        let baseDifficulty = Math.min(10, climbingIntensity / 4);

        // Adjust for rider's W/kg
        // Higher W/kg = lower perceived difficulty
        // Reference: 3.5 W/kg is "average" fit cyclist
        const wkgFactor = 3.5 / wPerKg;
        let adjustedDifficulty = baseDifficulty * wkgFactor;

        // Factor in total distance (fatigue)
        // > 100km adds difficulty, < 50km reduces it
        const distanceFactor = 0.8 + (distance / 250);
        adjustedDifficulty *= distanceFactor;

        // Clamp to 1-10 range
        return Math.max(1, Math.min(10, Math.round(adjustedDifficulty * 10) / 10));
    }

    /**
     * Get difficulty label from score
     */
    function getDifficultyLabel(score) {
        if (score <= 3) return 'Easy';
        if (score <= 5) return 'Moderate';
        if (score <= 7) return 'Hard';
        if (score <= 9) return 'Very Hard';
        return 'Extreme';
    }

    /**
     * Get difficulty class for styling
     */
    function getDifficultyClass(score) {
        if (score <= 3) return 'easy';
        if (score <= 5) return 'moderate';
        if (score <= 7) return 'hard';
        return 'very-hard';
    }

    /**
     * Detect significant climbs in route
     * A climb is sustained grade > 3% for > 500m
     * @param {object} routeData - Route data
     * @returns {array} Array of climb objects
     */
    function detectClimbs(routeData) {
        const coords = routeData.coordinates;
        const climbs = [];
        const minGrade = 0.02; // 2% to start detecting
        const minDistance = 500; // meters minimum climb length
        const minElevGain = 30; // meters minimum elevation gain
        const flatTolerance = 300; // meters of flat/descent allowed within a climb

        let inClimb = false;
        let climbStart = null;
        let climbDistance = 0;
        let climbElevationGain = 0;
        let flatDistance = 0; // track distance of non-climbing within climb
        let lastElevation = coords[0][2] || 0;
        let cumulativeDistance = 0;
        let peakElevation = lastElevation;

        for (let i = 1; i < coords.length; i++) {
            const dist = haversineDistance(
                coords[i-1][1], coords[i-1][0],
                coords[i][1], coords[i][0]
            ) * 1000;

            const elevation = coords[i][2] || 0;
            const elevDiff = elevation - lastElevation;
            const grade = dist > 0 ? elevDiff / dist : 0;

            cumulativeDistance += dist;

            if (grade >= minGrade) {
                // Climbing segment
                if (!inClimb) {
                    inClimb = true;
                    climbStart = {
                        index: i - 1,
                        distance: cumulativeDistance - dist,
                        elevation: lastElevation
                    };
                    climbDistance = 0;
                    climbElevationGain = 0;
                    flatDistance = 0;
                    peakElevation = lastElevation;
                }
                climbDistance += dist + flatDistance; // include any flat section we tolerated
                flatDistance = 0;
                climbElevationGain += Math.max(0, elevDiff);
                peakElevation = Math.max(peakElevation, elevation);
            } else if (inClimb) {
                // Flat or descending while in a climb
                flatDistance += dist;

                // If we've gone too far without climbing, end the climb
                if (flatDistance > flatTolerance || elevation < peakElevation - 50) {
                    // End of climb - save if significant
                    if (climbDistance >= minDistance && climbElevationGain >= minElevGain) {
                        climbs.push({
                            startDistance: climbStart.distance / 1000,
                            endDistance: (cumulativeDistance - flatDistance) / 1000,
                            distance: climbDistance,
                            elevationGain: climbElevationGain,
                            avgGrade: (climbElevationGain / climbDistance) * 100,
                            startElevation: climbStart.elevation,
                            endElevation: peakElevation
                        });
                    }
                    inClimb = false;
                    flatDistance = 0;
                }
            }

            lastElevation = elevation;
        }

        // Handle climb at end of route
        if (inClimb && climbDistance >= minDistance && climbElevationGain >= minElevGain) {
            climbs.push({
                startDistance: climbStart.distance / 1000,
                endDistance: cumulativeDistance / 1000,
                distance: climbDistance,
                elevationGain: climbElevationGain,
                avgGrade: (climbElevationGain / climbDistance) * 100,
                startElevation: climbStart.elevation,
                endElevation: peakElevation
            });
        }

        // Sort by elevation gain (biggest climbs first)
        climbs.sort((a, b) => b.elevationGain - a.elevationGain);

        return climbs;
    }

    /**
     * Calculate W/kg table for a climb at different speeds
     * @param {object} climb - Climb object
     * @param {number} riderWeight - Rider weight
     * @param {number} ftp - Rider FTP
     * @returns {array} Array of speed/power requirements
     */
    function calculateClimbTable(climb, riderWeight, ftp) {
        const speeds = [8, 10, 12, 15, 18, 20]; // km/h
        const grade = climb.avgGrade / 100;

        return speeds.map(speedKmh => {
            const speedMs = speedKmh / 3.6;
            const power = calculatePowerForSpeed(grade, speedMs, riderWeight);
            const wPerKg = power / riderWeight;
            const percentFtp = (power / ftp) * 100;
            const time = (climb.distance / 1000) / speedKmh * 60; // minutes

            let status = 'sustainable';
            if (percentFtp > 105) status = 'above-ftp';
            else if (percentFtp > 90) status = 'hard';

            return {
                speed: speedKmh,
                power: Math.round(power),
                wPerKg: wPerKg.toFixed(2),
                percentFtp: Math.round(percentFtp),
                time: formatDuration(time * 60),
                status
            };
        });
    }

    /**
     * Calculate power needed at each point for target speed
     * For effort zone coloring on elevation profile
     * @param {object} routeData - Route data
     * @param {number} targetSpeedKmh - Target average speed
     * @param {number} riderWeight - Rider weight
     * @returns {array} Power values for each coordinate
     */
    function calculatePowerProfile(routeData, targetSpeedKmh, riderWeight) {
        const coords = routeData.coordinates;
        const speedMs = targetSpeedKmh / 3.6;
        const powers = [];

        for (let i = 0; i < coords.length; i++) {
            let grade = 0;
            if (i < coords.length - 1) {
                const dist = haversineDistance(
                    coords[i][1], coords[i][0],
                    coords[i+1][1], coords[i+1][0]
                ) * 1000;
                const elevDiff = (coords[i+1][2] || 0) - (coords[i][2] || 0);
                grade = dist > 0 ? elevDiff / dist : 0;
            }

            const power = calculatePowerForSpeed(grade, speedMs, riderWeight);
            powers.push(power);
        }

        return powers;
    }

    /**
     * Haversine distance calculation
     */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth radius in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Format duration in seconds to human-readable string
     */
    function formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    }

    // Public API
    return {
        calculatePowerForSpeed,
        calculateSpeedForPower,
        calculateSegmentTime,
        calculateWPerKgForSpeed,
        getEffortZone,
        calculateRouteMetrics,
        calculateDifficultyScore,
        getDifficultyLabel,
        getDifficultyClass,
        detectClimbs,
        calculateClimbTable,
        calculatePowerProfile,
        formatDuration,
        CONSTANTS,
        ZONES
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PowerCalculator;
}

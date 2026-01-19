/**
 * KOTR 2026 - Elevation Profile Component
 * Interactive elevation visualization with gradient coloring
 * Supports both grade-based and effort zone coloring modes
 */

const ElevationProfile = (function() {
    'use strict';

    // Gradient colors based on grade percentage (default mode)
    const GRADE_COLORS = {
        flat: '#22C55E',      // < 3% - Green
        moderate: '#EAB308',   // 3-6% - Yellow
        hard: '#F97316',       // 6-10% - Orange
        extreme: '#EF4444'     // > 10% - Red
    };

    // Effort zone colors (when rider profile is configured)
    const EFFORT_ZONE_COLORS = {
        recovery:  '#22C55E',  // < 55% FTP - Green
        endurance: '#3B82F6',  // 55-75% FTP - Blue
        tempo:     '#EAB308',  // 75-90% FTP - Yellow
        threshold: '#F97316',  // 90-105% FTP - Orange
        vo2max:    '#EF4444',  // 105-120% FTP - Red
        anaerobic: '#DC2626'   // > 120% FTP - Dark Red
    };

    // Color mode
    const COLOR_MODES = {
        GRADE: 'grade',
        EFFORT: 'effort'
    };

    class ElevationProfileRenderer {
        constructor(canvasId, options = {}) {
            this.canvas = document.getElementById(canvasId);
            if (!this.canvas) {
                throw new Error(`Canvas element '${canvasId}' not found`);
            }

            this.ctx = this.canvas.getContext('2d');
            this.options = {
                padding: { top: 10, right: 10, bottom: 10, left: 10 },
                fillAlpha: 0.6,
                lineWidth: 2,
                ...options
            };

            this.routeData = null;
            this.elevationData = [];
            this.distanceData = [];
            this.grades = [];
            this.minElevation = 0;
            this.maxElevation = 0;
            this.totalDistance = 0;

            // Current position marker
            this.currentPosition = 0;

            // Event callbacks
            this.onPositionChange = null;
            this.onHover = null;

            // Color mode (grade or effort)
            this.colorMode = COLOR_MODES.GRADE;
            this.riderWeight = 75;  // Default weight in kg
            this.riderFTP = 200;    // Default FTP in watts
            this.targetSpeed = 15;  // Target speed in km/h for effort calculations

            // Setup canvas and events
            this.setupCanvas();
            this.setupEvents();
        }

        /**
         * Setup canvas for high-DPI displays
         */
        setupCanvas() {
            const rect = this.canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;

            this.ctx.scale(dpr, dpr);

            this.width = rect.width;
            this.height = rect.height;
        }

        /**
         * Setup mouse/touch events
         */
        setupEvents() {
            this.canvas.addEventListener('mousemove', (e) => this.handleHover(e));
            this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
            this.canvas.addEventListener('click', (e) => this.handleClick(e));

            // Touch events
            this.canvas.addEventListener('touchmove', (e) => {
                e.preventDefault();
                this.handleHover(e.touches[0]);
            }, { passive: false });

            this.canvas.addEventListener('touchend', () => this.handleMouseLeave());

            // Resize handler
            window.addEventListener('resize', () => {
                this.setupCanvas();
                this.render();
            });
        }

        /**
         * Load route data and process elevations
         */
        setRouteData(routeData) {
            this.routeData = routeData;
            this.processElevationData();
            this.render();
        }

        /**
         * Process elevation data from route
         */
        processElevationData() {
            if (!this.routeData || !this.routeData.coordinates) return;

            const coords = this.routeData.coordinates;
            this.elevationData = [];
            this.distanceData = [];
            this.grades = [];

            let cumulativeDistance = 0;
            this.minElevation = Infinity;
            this.maxElevation = -Infinity;

            // First pass: collect elevation and distance data
            for (let i = 0; i < coords.length; i++) {
                const elevation = coords[i][2] || 0;
                this.elevationData.push(elevation);

                if (isFinite(elevation)) {
                    if (elevation < this.minElevation) this.minElevation = elevation;
                    if (elevation > this.maxElevation) this.maxElevation = elevation;
                }

                if (i > 0) {
                    const dist = this.calculateDistance(
                        coords[i - 1][1], coords[i - 1][0],
                        coords[i][1], coords[i][0]
                    );
                    cumulativeDistance += dist;
                }

                this.distanceData.push(cumulativeDistance);
            }

            this.totalDistance = cumulativeDistance;

            // Second pass: calculate segment-based grades (50m segments)
            // This eliminates GPS noise that causes unrealistic point-to-point gradients
            this.grades = this.calculateSegmentGrades(50);

            // Handle edge cases for elevation range
            if (!isFinite(this.minElevation) || !isFinite(this.maxElevation)) {
                this.minElevation = 0;
                this.maxElevation = 100;
            }

            // Add some padding to elevation range
            const elevRange = this.maxElevation - this.minElevation;
            if (elevRange > 0) {
                this.minElevation -= elevRange * 0.05;
                this.maxElevation += elevRange * 0.05;
            } else {
                // If flat, add artificial range
                this.minElevation -= 10;
                this.maxElevation += 10;
            }
        }

        /**
         * Calculate grades over fixed-length segments to reduce GPS noise
         * @param {number} segmentLengthMeters - Length of each segment in meters
         * @returns {number[]} Array of grades for each point
         */
        calculateSegmentGrades(segmentLengthMeters) {
            const grades = [];
            const segmentLengthKm = segmentLengthMeters / 1000;

            let segmentStartIdx = 0;
            let segmentStartDist = 0;

            for (let i = 0; i < this.elevationData.length; i++) {
                const currentDist = this.distanceData[i];
                const segmentDist = currentDist - segmentStartDist;

                // When we've traveled far enough, calculate the segment grade
                if (segmentDist >= segmentLengthKm || i === this.elevationData.length - 1) {
                    const elevDiff = this.elevationData[i] - this.elevationData[segmentStartIdx];
                    const grade = segmentDist > 0 ? (elevDiff / (segmentDist * 1000)) * 100 : 0;
                    const clampedGrade = Math.max(-25, Math.min(25, grade)); // Clamp to realistic range

                    // Fill grades for all points in this segment
                    while (grades.length <= i) {
                        grades.push(isFinite(clampedGrade) ? clampedGrade : 0);
                    }

                    // Start new segment
                    segmentStartIdx = i;
                    segmentStartDist = currentDist;
                }
            }

            // Ensure we have a grade for every point
            while (grades.length < this.elevationData.length) {
                grades.push(grades[grades.length - 1] || 0);
            }

            return grades;
        }

        /**
         * Calculate distance between two points (Haversine)
         */
        calculateDistance(lat1, lon1, lat2, lon2) {
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
         * Get color for a grade percentage
         * Positive grades (climbing) = orange/red, negative grades (descending) = green
         */
        getGradeColor(grade) {
            // Descending - always green
            if (grade < -1) return GRADE_COLORS.flat;

            // Flat or very slight grade
            if (grade < 3) return GRADE_COLORS.flat;

            // Climbing - color by intensity
            if (grade < 6) return GRADE_COLORS.moderate;
            if (grade < 10) return GRADE_COLORS.hard;
            return GRADE_COLORS.extreme;
        }

        /**
         * Set color mode (grade or effort)
         * @param {string} mode - 'grade' or 'effort'
         */
        setColorMode(mode) {
            if (mode === COLOR_MODES.GRADE || mode === COLOR_MODES.EFFORT) {
                this.colorMode = mode;
                this.render();
            }
        }

        /**
         * Get current color mode
         */
        getColorMode() {
            return this.colorMode;
        }

        /**
         * Set rider profile for effort calculations
         * @param {number} weight - Rider weight in kg
         * @param {number} ftp - Functional Threshold Power in watts
         */
        setRiderProfile(weight, ftp) {
            this.riderWeight = weight || 75;
            this.riderFTP = ftp || 200;
            if (this.colorMode === COLOR_MODES.EFFORT) {
                this.render();
            }
        }

        /**
         * Set target speed for effort calculations
         * @param {number} speed - Target speed in km/h
         */
        setTargetSpeed(speed) {
            this.targetSpeed = speed || 15;
            if (this.colorMode === COLOR_MODES.EFFORT) {
                this.render();
            }
        }

        /**
         * Calculate power required for given grade and speed
         * Uses same physics model as PowerCalculator
         */
        calculatePowerForGrade(grade, speed) {
            const weight = this.riderWeight;
            const bikeWeight = 9; // kg
            const totalMass = weight + bikeWeight;
            const g = 9.81;
            const Crr = 0.005;
            const CdA = 0.35;
            const rho = 1.2;

            const gradeDecimal = grade / 100;
            const speedMs = speed / 3.6;

            // Power components
            const Pgravity = totalMass * g * gradeDecimal * speedMs;
            const Prolling = Crr * totalMass * g * Math.cos(Math.atan(gradeDecimal)) * speedMs;
            const Paero = 0.5 * CdA * rho * Math.pow(speedMs, 3);

            const totalPower = Pgravity + Prolling + Paero;

            // For descents, power can be negative (coasting)
            return Math.max(0, totalPower);
        }

        /**
         * Get effort zone color based on power as percentage of FTP
         * @param {number} power - Power in watts
         * @returns {string} Color for the effort zone
         */
        getEffortZoneColor(power) {
            const ftpPercent = (power / this.riderFTP) * 100;

            if (ftpPercent < 55) return EFFORT_ZONE_COLORS.recovery;
            if (ftpPercent < 75) return EFFORT_ZONE_COLORS.endurance;
            if (ftpPercent < 90) return EFFORT_ZONE_COLORS.tempo;
            if (ftpPercent < 105) return EFFORT_ZONE_COLORS.threshold;
            if (ftpPercent < 120) return EFFORT_ZONE_COLORS.vo2max;
            return EFFORT_ZONE_COLORS.anaerobic;
        }

        /**
         * Get color for segment based on current color mode
         * @param {number} index - Index in the data arrays
         * @returns {string} Color for this segment
         */
        getSegmentColor(index) {
            const grade = this.getSmoothedGrade(index);

            if (this.colorMode === COLOR_MODES.EFFORT) {
                const power = this.calculatePowerForGrade(grade, this.targetSpeed);
                return this.getEffortZoneColor(power);
            }

            return this.getGradeColor(grade);
        }

        /**
         * Render the elevation profile
         */
        render() {
            if (this.elevationData.length === 0) return;

            // Guard against invalid data
            if (!isFinite(this.totalDistance) || this.totalDistance <= 0) return;
            if (!isFinite(this.minElevation) || !isFinite(this.maxElevation)) return;

            const ctx = this.ctx;
            const { padding } = this.options;

            // Clear canvas
            ctx.clearRect(0, 0, this.width, this.height);

            const chartWidth = this.width - padding.left - padding.right;
            const chartHeight = this.height - padding.top - padding.bottom;

            // Guard against invalid dimensions
            if (chartWidth <= 0 || chartHeight <= 0) return;

            // Draw gradient fill with grade colors
            this.renderGradientFill(ctx, chartWidth, chartHeight, padding);

            // Draw line
            this.renderLine(ctx, chartWidth, chartHeight, padding);

            // Draw current position marker
            this.renderPositionMarker(ctx, chartWidth, chartHeight, padding);
        }

        /**
         * Render gradient fill based on grade
         * Batches consecutive segments with the same color for clean rendering
         */
        renderGradientFill(ctx, chartWidth, chartHeight, padding) {
            const elevRange = this.maxElevation - this.minElevation;

            // Guard against zero range
            if (!isFinite(elevRange) || elevRange <= 0) return;

            ctx.save();
            ctx.globalAlpha = this.options.fillAlpha;

            // Build color regions by batching consecutive same-color segments
            const regions = [];
            let currentRegion = null;

            for (let i = 0; i < this.elevationData.length; i++) {
                const color = this.getSegmentColor(i);

                if (!currentRegion || currentRegion.color !== color) {
                    // Start new region
                    if (currentRegion) {
                        currentRegion.endIndex = i;
                        regions.push(currentRegion);
                    }
                    currentRegion = { color, startIndex: i, endIndex: i };
                }
            }
            // Push final region
            if (currentRegion) {
                currentRegion.endIndex = this.elevationData.length - 1;
                regions.push(currentRegion);
            }

            // Draw each color region as a single filled path
            for (const region of regions) {
                const { color, startIndex, endIndex } = region;
                if (startIndex >= endIndex) continue;

                ctx.beginPath();

                // Build the top edge (elevation line)
                for (let i = startIndex; i <= endIndex; i++) {
                    const x = padding.left + (this.distanceData[i] / this.totalDistance) * chartWidth;
                    const y = padding.top + chartHeight -
                        ((this.elevationData[i] - this.minElevation) / elevRange) * chartHeight;

                    if (i === startIndex) {
                        ctx.moveTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                }

                // Close the path along the bottom
                const xEnd = padding.left + (this.distanceData[endIndex] / this.totalDistance) * chartWidth;
                const xStart = padding.left + (this.distanceData[startIndex] / this.totalDistance) * chartWidth;
                ctx.lineTo(xEnd, padding.top + chartHeight);
                ctx.lineTo(xStart, padding.top + chartHeight);
                ctx.closePath();

                // Create vertical gradient for this region
                const yTop = padding.top;
                const gradient = ctx.createLinearGradient(0, yTop, 0, padding.top + chartHeight);
                gradient.addColorStop(0, color);
                gradient.addColorStop(1, 'rgba(0,0,0,0)');

                ctx.fillStyle = gradient;
                ctx.fill();
            }

            ctx.restore();
        }

        /**
         * Get grade at index with moderate smoothing for color stability
         */
        getSmoothedGrade(index) {
            // Use moderate window - enough to smooth noise but preserve real gradient changes
            // ~10 points = roughly 100-200m of smoothing
            const windowSize = 10;
            let sum = 0;
            let count = 0;

            for (let i = Math.max(0, index - windowSize); i <= Math.min(this.grades.length - 1, index + windowSize); i++) {
                sum += this.grades[i];
                count++;
            }

            return sum / count;
        }

        /**
         * Render the elevation line
         */
        renderLine(ctx, chartWidth, chartHeight, padding) {
            const elevRange = this.maxElevation - this.minElevation;

            // Guard against zero range
            if (!isFinite(elevRange) || elevRange <= 0) return;

            ctx.save();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = this.options.lineWidth;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';

            ctx.beginPath();

            for (let i = 0; i < this.elevationData.length; i++) {
                const x = padding.left + (this.distanceData[i] / this.totalDistance) * chartWidth;
                const y = padding.top + chartHeight -
                    ((this.elevationData[i] - this.minElevation) / elevRange) * chartHeight;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }

            ctx.stroke();
            ctx.restore();
        }

        /**
         * Render current position marker
         */
        renderPositionMarker(ctx, chartWidth, chartHeight, padding) {
            if (this.currentPosition <= 0 || this.currentPosition >= 1) return;

            const x = padding.left + this.currentPosition * chartWidth;
            const index = Math.floor(this.currentPosition * (this.elevationData.length - 1));
            const elevation = this.elevationData[index] || 0;
            const elevRange = this.maxElevation - this.minElevation;
            const y = padding.top + chartHeight -
                ((elevation - this.minElevation) / elevRange) * chartHeight;

            // Vertical line
            ctx.save();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, padding.top + chartHeight);
            ctx.stroke();
            ctx.restore();

            // Circle at current elevation
            ctx.save();
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        /**
         * Set current position (0-1)
         */
        setPosition(position) {
            this.currentPosition = Math.max(0, Math.min(1, position));
            this.render();

            // Update current elevation display
            const index = Math.floor(this.currentPosition * (this.elevationData.length - 1));
            return {
                distance: this.distanceData[index] || 0,
                elevation: this.elevationData[index] || 0,
                grade: this.grades[index] || 0
            };
        }

        /**
         * Handle hover
         */
        handleHover(e) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const { padding } = this.options;
            const chartWidth = this.width - padding.left - padding.right;

            const position = (x - padding.left) / chartWidth;

            if (position >= 0 && position <= 1) {
                const index = Math.floor(position * (this.elevationData.length - 1));
                const data = {
                    position,
                    distance: this.distanceData[index] || 0,
                    elevation: this.elevationData[index] || 0,
                    grade: this.grades[index] || 0
                };

                if (this.onHover) {
                    this.onHover(data);
                }

                // Show marker
                const marker = document.getElementById('elevation-marker');
                const tooltip = document.getElementById('elevation-tooltip');
                if (marker && tooltip) {
                    marker.style.display = 'block';
                    marker.style.left = `${(position * 100)}%`;
                    tooltip.textContent = `${Math.round(data.elevation)}m | ${data.distance.toFixed(1)}km | ${data.grade.toFixed(1)}%`;
                }
            }
        }

        /**
         * Handle mouse leave
         */
        handleMouseLeave() {
            const marker = document.getElementById('elevation-marker');
            if (marker) {
                marker.style.display = 'none';
            }
        }

        /**
         * Handle click - seek to position
         */
        handleClick(e) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const { padding } = this.options;
            const chartWidth = this.width - padding.left - padding.right;

            const position = (x - padding.left) / chartWidth;

            if (position >= 0 && position <= 1 && this.onPositionChange) {
                this.onPositionChange(position);
            }
        }

        /**
         * Get stats for display
         */
        getStats() {
            return {
                minElevation: Math.round(this.minElevation),
                maxElevation: Math.round(this.maxElevation),
                totalDistance: this.totalDistance.toFixed(1),
                totalElevationGain: this.routeData ? this.routeData.elevationGain : 0
            };
        }
    }

    // Public API
    return {
        ElevationProfileRenderer,
        GRADE_COLORS,
        EFFORT_ZONE_COLORS,
        COLOR_MODES
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ElevationProfile;
}

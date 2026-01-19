/**
 * KOTR 2026 - Elevation Profile Component
 * Interactive elevation visualization with gradient coloring
 */

const ElevationProfile = (function() {
    'use strict';

    // Gradient colors based on grade percentage
    const GRADE_COLORS = {
        flat: '#22C55E',      // < 3% - Green
        moderate: '#EAB308',   // 3-6% - Yellow
        hard: '#F97316',       // 6-10% - Orange
        extreme: '#EF4444'     // > 10% - Red
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

                    // Calculate grade using stored elevation data
                    const prevElevation = this.elevationData[i - 1] || 0;
                    const elevDiff = elevation - prevElevation;
                    const grade = (dist > 0) ? (elevDiff / (dist * 1000)) * 100 : 0;
                    this.grades.push(isFinite(grade) ? grade : 0);
                } else {
                    this.grades.push(0);
                }

                this.distanceData.push(cumulativeDistance);
            }

            this.totalDistance = cumulativeDistance;

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
         */
        getGradeColor(grade) {
            const absGrade = Math.abs(grade);
            if (absGrade < 3) return GRADE_COLORS.flat;
            if (absGrade < 6) return GRADE_COLORS.moderate;
            if (absGrade < 10) return GRADE_COLORS.hard;
            return GRADE_COLORS.extreme;
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
         */
        renderGradientFill(ctx, chartWidth, chartHeight, padding) {
            const elevRange = this.maxElevation - this.minElevation;

            // Guard against zero range
            if (!isFinite(elevRange) || elevRange <= 0) return;

            ctx.save();
            ctx.globalAlpha = this.options.fillAlpha;

            // Draw filled segments
            for (let i = 0; i < this.elevationData.length - 1; i++) {
                const x1 = padding.left + (this.distanceData[i] / this.totalDistance) * chartWidth;
                const x2 = padding.left + (this.distanceData[i + 1] / this.totalDistance) * chartWidth;

                const y1 = padding.top + chartHeight -
                    ((this.elevationData[i] - this.minElevation) / elevRange) * chartHeight;
                const y2 = padding.top + chartHeight -
                    ((this.elevationData[i + 1] - this.minElevation) / elevRange) * chartHeight;

                // Smooth grade calculation using average of nearby points
                const smoothedGrade = this.getSmoothedGrade(i);
                const color = this.getGradeColor(smoothedGrade);

                // Create vertical gradient
                const gradient = ctx.createLinearGradient(x1, y1, x1, padding.top + chartHeight);
                gradient.addColorStop(0, color);
                gradient.addColorStop(1, 'rgba(0,0,0,0)');

                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x2, padding.top + chartHeight);
                ctx.lineTo(x1, padding.top + chartHeight);
                ctx.closePath();
                ctx.fill();
            }

            ctx.restore();
        }

        /**
         * Get smoothed grade using moving average
         */
        getSmoothedGrade(index) {
            const windowSize = 5;
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
        GRADE_COLORS
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ElevationProfile;
}

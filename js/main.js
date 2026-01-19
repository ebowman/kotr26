/**
 * KOTR 2026 - Main JavaScript
 * Landing page functionality
 */

(function() {
    'use strict';

    // Mapbox access token - replace with your own for production
    // For demo purposes, using a placeholder that should be replaced
    const MAPBOX_TOKEN = 'pk.eyJ1IjoiZWJvd21hbiIsImEiOiJjbWE1ZWVwdzYwODhwMmlzZnU4NTlyem1rIn0.E10X5hj2NTgViJexKpvrOg';

    // Route configurations - Updated with DEM-calculated elevation values
    // Elevation gain calculated using industry-standard algorithm matching Strava
    const ROUTES = {
        day1: {
            standard: 'routes/KOTR_Avignon_D1.fit',
            name: 'Day 1 - Warmup',
            tagline: 'Shake out the travel legs',
            type: 'warmup',
            distance: 45,
            elevation: 100,
            difficulty: 1,
            duration: '~2 hours'
        },
        day2: {
            standard: 'routes/KOTR_Avignon_Standard_D2.fit',
            long: 'routes/KOTR_Avignon_Long_D2.fit',
            name: 'Day 2 - Wine Country West',
            tagline: 'Find your rhythm',
            type: 'choice',
            short: { distance: 80, elevation: 540, difficulty: 2, duration: '~3-4 hours' },
            long: { distance: 106, elevation: 910, difficulty: 3, duration: '~4-5 hours' }
        },
        day3: {
            standard: 'routes/KOTR_Avignon_D3_Standard.fit',
            long: 'routes/KOTR_Ventoux_D3_Long.fit',
            name: 'Day 3 - Luberon & Ventoux',
            tagline: 'The Main Event',
            type: 'epic',
            short: { label: 'Luberon', distance: 100, elevation: 1020, difficulty: 3, duration: '~4-5 hours' },
            long: { label: 'Mont Ventoux', distance: 131, elevation: 2230, difficulty: 4, duration: '~6-7 hours', special: true }
        },
        day4: {
            standard: 'routes/KOTR_Avignon_D4_Standard.fit',
            long: 'routes/KOTR_Avignon_D4_Long.fit',
            name: 'Day 4 - Final Celebration',
            tagline: 'Celebrate together',
            type: 'choice',
            short: { distance: 85, elevation: 330, difficulty: 2, duration: '~3-4 hours' },
            long: { distance: 95, elevation: 410, difficulty: 2, duration: '~3.5-4.5 hours' }
        }
    };

    // State
    let map = null;
    let routeLayers = [];
    let selectedVariants = {
        2: 'short',
        3: 'short',
        4: 'short'
    };

    /**
     * Initialize the overview map
     */
    function initOverviewMap() {
        const mapContainer = document.getElementById('overview-map');
        if (!mapContainer || typeof mapboxgl === 'undefined') {
            console.warn('Mapbox GL JS not loaded or map container not found');
            return;
        }

        try {
            mapboxgl.accessToken = MAPBOX_TOKEN;

            map = new mapboxgl.Map({
                container: 'overview-map',
                style: 'mapbox://styles/mapbox/outdoors-v12',
                center: [4.8055, 43.9493], // Avignon
                zoom: 9,
                pitch: 45,
                bearing: -17,
                interactive: false,
                attributionControl: false
            });

            map.on('load', () => {
                // Add terrain
                map.addSource('mapbox-dem', {
                    type: 'raster-dem',
                    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                    tileSize: 512,
                    maxzoom: 14
                });
                map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.2 });

                // Add fog/atmosphere
                map.setFog({
                    color: 'rgb(186, 210, 235)',
                    'high-color': 'rgb(36, 92, 223)',
                    'horizon-blend': 0.02,
                    'space-color': 'rgb(11, 11, 25)',
                    'star-intensity': 0.6
                });

                // Slowly rotate the map
                rotateCamera(0);
            });
        } catch (error) {
            console.warn('Failed to initialize overview map:', error);
            mapContainer.style.display = 'none';
        }
    }

    /**
     * Rotate camera slowly for hero effect
     */
    function rotateCamera(timestamp) {
        if (!map) return;

        // Slowly rotate bearing
        const bearing = (timestamp / 500) % 360;
        map.setBearing(bearing - 180);

        requestAnimationFrame(rotateCamera);
    }

    /**
     * Setup route option buttons
     */
    function setupRouteOptions() {
        const routeCards = document.querySelectorAll('.route-card');

        routeCards.forEach(card => {
            const day = parseInt(card.dataset.day);
            const optionElements = card.querySelectorAll('.route-option');

            optionElements.forEach(option => {
                option.addEventListener('click', () => {
                    // Update active state
                    optionElements.forEach(o => o.classList.remove('active'));
                    option.classList.add('active');

                    // Store selection
                    const variant = option.dataset.variant;
                    selectedVariants[day] = variant;

                    // Update route analysis for this card with new variant
                    if (typeof RiderProfile !== 'undefined' && RiderProfile.isConfigured()) {
                        const profile = RiderProfile.get();
                        updateCardAnalysis(card, profile.weight, profile.ftp);
                    }
                });
            });

            // Set initial active state based on default selection
            const defaultVariant = selectedVariants[day] || 'short';
            const defaultOption = card.querySelector(`.route-option[data-variant="${defaultVariant}"]`);
            if (defaultOption) {
                defaultOption.classList.add('active');
            }
        });
    }

    /**
     * Setup flyover buttons and dropdown items
     */
    function setupFlyoverButtons() {
        // Handle simple flyover buttons (Day 1 warmup)
        const simpleFlyoverButtons = document.querySelectorAll('.btn-flyover:not(.btn-split)');
        simpleFlyoverButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const routeFile = btn.dataset.route;
                if (routeFile) {
                    window.location.href = `flyover.html?route=${encodeURIComponent(routeFile)}`;
                }
            });
        });

        // Handle dropdown flyover items (Days 2-4)
        const flyoverDropdowns = document.querySelectorAll('.action-group:has(.btn-flyover) .dropdown-item');
        flyoverDropdowns.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const actionGroup = item.closest('.action-group');
                const btn = actionGroup.querySelector('.btn-flyover');
                const variant = item.dataset.variant;

                let routeFile;
                if (variant === 'long') {
                    routeFile = btn.dataset.routeLong;
                } else {
                    routeFile = btn.dataset.routeShort;
                }

                if (routeFile) {
                    window.location.href = `flyover.html?route=${encodeURIComponent(routeFile)}`;
                }
            });
        });
    }

    /**
     * Setup download buttons and dropdown items
     */
    function setupDownloadButtons() {
        // Handle simple download buttons (Day 1 warmup)
        const simpleDownloadButtons = document.querySelectorAll('.btn-download:not(.btn-split)');
        simpleDownloadButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const routeFile = btn.dataset.route;
                if (routeFile) {
                    await downloadRoute(btn, routeFile);
                }
            });
        });

        // Handle dropdown download items (Days 2-4)
        const downloadDropdowns = document.querySelectorAll('.action-group:has(.btn-download) .dropdown-item');
        downloadDropdowns.forEach(item => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                const actionGroup = item.closest('.action-group');
                const btn = actionGroup.querySelector('.btn-download');
                const variant = item.dataset.variant;

                let routeFile;
                if (variant === 'long') {
                    routeFile = btn.dataset.routeLong;
                } else {
                    routeFile = btn.dataset.routeShort;
                }

                if (routeFile) {
                    await downloadRoute(btn, routeFile);
                }
            });
        });
    }

    /**
     * Download a route file as GPX
     */
    async function downloadRoute(btn, routeFile) {
        // Show loading state
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span class="icon">⏳</span> Loading...';
        btn.disabled = true;

        try {
            // Load and parse FIT file
            const routeData = await FitParser.loadFitFile(`routes/${routeFile.split('/').pop()}`);

            // Download as GPX
            const gpxFilename = routeFile.replace('.fit', '.gpx').split('/').pop();
            FitParser.downloadGPX(routeData, gpxFilename);
        } catch (error) {
            console.error('Failed to download route:', error);
            alert('Failed to download route. Please try again.');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }

    /**
     * Initialize weather widget
     */
    function initWeather() {
        if (typeof WeatherWidget !== 'undefined') {
            WeatherWidget.init('weather-widget');
        }
    }

    /**
     * Add smooth scroll for anchor links
     */
    function setupSmoothScroll() {
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function(e) {
                e.preventDefault();
                const target = document.querySelector(this.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            });
        });
    }

    /**
     * Setup dropdown toggle for touch devices
     */
    function setupDropdownToggles() {
        const splitButtons = document.querySelectorAll('.btn-split');

        splitButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Check if touch device
                if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
                    e.preventDefault();
                    e.stopPropagation();

                    const actionGroup = btn.closest('.action-group');
                    const dropdown = actionGroup.querySelector('.dropdown');

                    // Close other open dropdowns
                    document.querySelectorAll('.dropdown.open').forEach(d => {
                        if (d !== dropdown) d.classList.remove('open');
                    });

                    // Toggle this dropdown
                    dropdown.classList.toggle('open');
                }
            });
        });

        // Close dropdowns when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.action-group')) {
                document.querySelectorAll('.dropdown.open').forEach(d => {
                    d.classList.remove('open');
                });
            }
        });
    }

    /**
     * Route analysis cache
     */
    const routeAnalysisCache = new Map();

    /**
     * Calculate and display route analysis on cards
     */
    function updateRouteAnalysis() {
        // Check if profile is configured
        if (!RiderProfile || !RiderProfile.isConfigured()) {
            // Remove any existing analysis displays
            document.querySelectorAll('.route-analysis').forEach(el => el.remove());
            return;
        }

        const profile = RiderProfile.get();
        const { weight, ftp } = profile;

        // Update analysis for each route card
        document.querySelectorAll('.route-card').forEach(card => {
            updateCardAnalysis(card, weight, ftp);
        });
    }

    /**
     * Update analysis display for a single route card
     */
    function updateCardAnalysis(card, weight, ftp) {
        const day = parseInt(card.dataset.day);
        const routeConfig = ROUTES[`day${day}`];
        if (!routeConfig) return;

        // Determine which variant is currently selected
        const selectedVariant = selectedVariants[day] || 'standard';
        const isLongSelected = selectedVariant === 'long';

        // Get distance and elevation based on selection
        let distance, elevation;

        if (routeConfig.type === 'warmup') {
            // Day 1 has no variant options
            distance = routeConfig.distance;
            elevation = routeConfig.elevation;
        } else if (isLongSelected && routeConfig.long) {
            // Long variant selected
            distance = routeConfig.long.distance;
            elevation = routeConfig.long.elevation;
        } else if (routeConfig.short) {
            // Short/standard variant selected (or fallback)
            distance = routeConfig.short.distance;
            elevation = routeConfig.short.elevation;
        } else {
            // Fallback to top-level config
            distance = routeConfig.distance || 0;
            elevation = routeConfig.elevation || 0;
        }

        // Create mock route data for calculation
        const mockRouteData = {
            distance: distance,
            elevationGain: elevation,
            coordinates: generateMockCoordinates(distance, elevation)
        };

        // Calculate metrics
        const metrics = PowerCalculator.calculateRouteMetrics(mockRouteData, weight, ftp);
        if (!metrics) return;

        // Remove existing analysis if present
        const existingAnalysis = card.querySelector('.route-analysis');
        if (existingAnalysis) {
            existingAnalysis.remove();
        }

        // Create analysis display
        const analysisHtml = createAnalysisHTML(metrics, weight, ftp);

        // Insert before card actions
        const cardActions = card.querySelector('.card-actions');
        if (cardActions) {
            cardActions.insertAdjacentHTML('beforebegin', analysisHtml);
        }
    }

    /**
     * Generate mock coordinates for route analysis
     * This is a simplified approximation for display purposes
     */
    function generateMockCoordinates(distanceKm, elevationGainM) {
        const numPoints = 100;
        const coords = [];
        const avgGrade = elevationGainM / (distanceKm * 1000);

        for (let i = 0; i < numPoints; i++) {
            const progress = i / (numPoints - 1);
            // Simple sinusoidal elevation profile
            const elevation = elevationGainM * progress * (1 + 0.2 * Math.sin(progress * Math.PI * 4));
            coords.push([
                4.8 + progress * 0.5,  // Longitude (approximate for Avignon area)
                43.9 + progress * 0.3, // Latitude
                Math.max(0, elevation)
            ]);
        }

        return coords;
    }

    /**
     * Create HTML for route analysis display
     */
    function createAnalysisHTML(metrics, weight, ftp) {
        const difficultyClass = PowerCalculator.getDifficultyClass(metrics.difficultyScore);
        const steadyTime = metrics.timeEstimates.find(t => t.label === 'Steady');

        return `
            <div class="route-analysis">
                <div class="route-analysis-header">
                    <span class="profile-icon">&#128692;</span>
                    <span>For You (${weight}kg, ${ftp}W)</span>
                </div>
                <div class="route-analysis-stats">
                    <div class="analysis-stat">
                        <span class="difficulty-badge ${difficultyClass}">${metrics.difficultyScore.toFixed(1)}/10</span>
                        <span class="analysis-stat-label">${metrics.difficultyLabel}</span>
                    </div>
                    <div class="analysis-stat">
                        <span class="analysis-stat-value">${steadyTime ? steadyTime.formatted : '--'}</span>
                        <span class="analysis-stat-label">@ 75% FTP</span>
                    </div>
                    <div class="analysis-stat">
                        <span class="analysis-stat-value">${metrics.energy.kilojoules.toLocaleString()}</span>
                        <span class="analysis-stat-label">kJ (${metrics.energy.calories} kcal)</span>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Initialize everything on DOM ready
     */
    function init() {
        initOverviewMap();
        setupRouteOptions();
        setupFlyoverButtons();
        setupDownloadButtons();
        setupDropdownToggles();
        initWeather();
        setupSmoothScroll();

        // Initialize rider profile
        if (typeof RiderProfile !== 'undefined') {
            RiderProfile.init();

            // Listen for profile changes
            RiderProfile.setOnChange(() => {
                updateRouteAnalysis();
            });

            // Initial analysis update
            updateRouteAnalysis();
        }

        console.log('KOTR 2026 initialized');
    }

    // Run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

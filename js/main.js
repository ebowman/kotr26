/**
 * KOTR 2026 - Main JavaScript
 * Landing page functionality
 */

(function() {
    'use strict';

    // Mapbox access token - replace with your own for production
    // For demo purposes, using a placeholder that should be replaced
    const MAPBOX_TOKEN = 'pk.eyJ1IjoiZWJvd21hbiIsImEiOiJjbWE1ZWVwdzYwODhwMmlzZnU4NTlyem1rIn0.E10X5hj2NTgViJexKpvrOg';

    // Route configurations - Updated with correct data from specification
    const ROUTES = {
        day1: {
            standard: 'routes/KOTR_Avignon_D1.fit',
            name: 'Day 1 - Warmup',
            tagline: 'Shake out the travel legs',
            type: 'warmup',
            distance: 46,
            elevation: 240,
            difficulty: 1,
            duration: '~2 hours'
        },
        day2: {
            standard: 'routes/KOTR_Avignon_Standard_D2.fit',
            long: 'routes/KOTR_Avignon_Long_D2.fit',
            name: 'Day 2 - Wine Country West',
            tagline: 'Find your rhythm',
            type: 'choice',
            short: { distance: 80, elevation: 600, difficulty: 2, duration: '~3-4 hours' },
            long: { distance: 106, elevation: 1000, difficulty: 3, duration: '~4-5 hours' }
        },
        day3: {
            standard: 'routes/KOTR_Avignon_D3_Standard.fit',
            long: 'routes/KOTR_Ventoux_D3_Long.fit',
            name: 'Day 3 - Luberon & Ventoux',
            tagline: 'The Main Event',
            type: 'epic',
            short: { label: 'Luberon', distance: 100, elevation: 1100, difficulty: 3, duration: '~4-5 hours' },
            long: { label: 'Mont Ventoux', distance: 131, elevation: 2200, difficulty: 4, duration: '~6-7 hours', special: true }
        },
        day4: {
            standard: 'routes/KOTR_Avignon_D4_Standard.fit',
            long: 'routes/KOTR_Avignon_D4_Long.fit',
            name: 'Day 4 - Final Celebration',
            tagline: 'Celebrate together',
            type: 'choice',
            short: { distance: 85, elevation: 500, difficulty: 2, duration: '~3-4 hours' },
            long: { distance: 95, elevation: 620, difficulty: 2, duration: '~3.5-4.5 hours' }
        }
    };

    // State
    let map = null;
    let routeLayers = [];
    let selectedVariants = {
        2: 'standard',
        3: 'standard',
        4: 'standard'
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
            const optionButtons = card.querySelectorAll('.btn-option');

            optionButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    // Update active state
                    optionButtons.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    // Store selection
                    const variant = btn.dataset.variant;
                    selectedVariants[day] = variant;
                });
            });
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

        console.log('KOTR 2026 initialized');
    }

    // Run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

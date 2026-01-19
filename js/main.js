/**
 * KOTR 2026 - Main JavaScript
 * Landing page functionality
 */

(function() {
    'use strict';

    // Mapbox access token - replace with your own for production
    // For demo purposes, using a placeholder that should be replaced
    const MAPBOX_TOKEN = 'pk.eyJ1IjoiZWJvd21hbiIsImEiOiJjbWE1ZWVwdzYwODhwMmlzZnU4NTlyem1rIn0.E10X5hj2NTgViJexKpvrOg';

    // Route configurations
    const ROUTES = {
        day1: {
            standard: 'routes/KOTR_Avignon_D1.fit',
            name: 'Day 1 - Avignon Exploration',
            distance: 80,
            elevation: 800
        },
        day2: {
            standard: 'routes/KOTR_Avignon_Standard_D2.fit',
            long: 'routes/KOTR_Avignon_Long_D2.fit',
            name: 'Day 2 - Wine Country',
            distance: 95,
            elevation: 600
        },
        day3: {
            standard: 'routes/KOTR_Avignon_D3_Standard.fit',
            long: 'routes/KOTR_Ventoux_D3_Long.fit',
            name: 'Day 3 - Luberon / Ventoux',
            distance: 95,
            longDistance: 140,
            elevation: 1000,
            longElevation: 2500
        },
        day4: {
            standard: 'routes/KOTR_Avignon_D4_Standard.fit',
            long: 'routes/KOTR_Avignon_D4_Long.fit',
            name: 'Day 4 - Final Celebration',
            distance: null,
            elevation: null
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
     * Setup flyover buttons
     */
    function setupFlyoverButtons() {
        const flyoverButtons = document.querySelectorAll('.btn-flyover');

        flyoverButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const card = btn.closest('.route-card');
                const day = parseInt(card.dataset.day);
                const variant = selectedVariants[day] || 'standard';

                let routeFile;
                if (variant === 'long' && btn.dataset.routeLong) {
                    routeFile = btn.dataset.routeLong;
                } else {
                    routeFile = btn.dataset.route;
                }

                // Navigate to flyover page with route parameter
                window.location.href = `flyover.html?route=${encodeURIComponent(routeFile)}`;
            });
        });
    }

    /**
     * Setup download buttons
     */
    function setupDownloadButtons() {
        const downloadButtons = document.querySelectorAll('.btn-download');

        downloadButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const card = btn.closest('.route-card');
                const day = parseInt(card.dataset.day);
                const variant = selectedVariants[day] || 'standard';

                let routeFile;
                if (variant === 'long' && btn.dataset.routeLong) {
                    routeFile = btn.dataset.routeLong;
                } else {
                    routeFile = btn.dataset.route;
                }

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
            });
        });
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
     * Initialize everything on DOM ready
     */
    function init() {
        initOverviewMap();
        setupRouteOptions();
        setupFlyoverButtons();
        setupDownloadButtons();
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

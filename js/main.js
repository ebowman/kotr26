/**
 * KOTR 2026 - Main JavaScript
 * Landing page functionality
 */

(function() {
    'use strict';

    // Mapbox access token - replace with your own for production
    // For demo purposes, using a placeholder that should be replaced
    const MAPBOX_TOKEN = 'pk.eyJ1IjoiZWJvd21hbiIsImEiOiJjbWE1ZWVwdzYwODhwMmlzZnU4NTlyem1rIn0.E10X5hj2NTgViJexKpvrOg';

    // ========================================================================
    // SINGLE SOURCE OF TRUTH: Route configurations
    // ========================================================================
    // All route stats are defined here and rendered dynamically to HTML.
    // Elevation values calculated using industry-standard DEM algorithm matching Strava.
    // DO NOT hardcode route stats in HTML - they are generated from this config.
    // ========================================================================
    const ROUTES = {
        day1: {
            day: 1,
            date: '2026-05-29',
            dateDisplay: 'May 29',
            name: 'Shake Out the Travel Legs',
            description: 'Ease into the adventure with a gentle spin through Provencal countryside.',
            type: 'warmup',
            fitFile: 'KOTR_Avignon_D1.fit',
            // Stats from FIT/DEM calculation
            distance: 45,
            elevation: 100,
            difficulty: 1,
            difficultyLabel: 'Easy',
            duration: '~2 hours'
        },
        day2: {
            day: 2,
            date: '2026-05-30',
            dateDisplay: 'May 30',
            name: 'Find Your Rhythm',
            description: null, // No description for multi-option days
            type: 'choice',
            standard: {
                label: 'STANDARD',
                fitFile: 'KOTR_Avignon_Standard_D2.fit',
                distance: 80,
                elevation: 540,
                difficulty: 2,
                difficultyLabel: 'Moderate',
                duration: '~3-4 hours'
            },
            long: {
                label: 'LONG',
                fitFile: 'KOTR_Avignon_Long_D2.fit',
                distance: 106,
                elevation: 910,
                difficulty: 3,
                difficultyLabel: 'Challenging',
                duration: '~4-5 hours'
            }
        },
        day3: {
            day: 3,
            date: '2026-05-31',
            dateDisplay: 'May 31',
            name: 'The Main Event',
            description: null,
            type: 'epic',
            featured: true,
            standard: {
                label: 'LUBERON',
                fitFile: 'KOTR_Avignon_D3_Standard.fit',
                distance: 100,
                elevation: 1020,
                difficulty: 3,
                difficultyLabel: 'Challenging',
                duration: '~4-5 hours'
            },
            long: {
                label: 'MONT VENTOUX',
                labelIcon: '&#127956;', // Mountain emoji HTML entity
                fitFile: 'KOTR_Ventoux_D3_Long.fit',
                distance: 131,
                elevation: 2230,
                difficulty: 4,
                difficultyLabel: 'Epic',
                duration: '~6-7 hours',
                special: true,
                specialNote: 'Beast of Provence - Summit 1,909m'
            }
        },
        day4: {
            day: 4,
            date: '2026-06-01',
            dateDisplay: 'June 1',
            name: 'Celebrate Together',
            description: null,
            type: 'choice',
            standard: {
                label: 'STANDARD',
                fitFile: 'KOTR_Avignon_D4_Standard.fit',
                distance: 85,
                elevation: 330,
                difficulty: 2,
                difficultyLabel: 'Moderate',
                duration: '~3-4 hours'
            },
            long: {
                label: 'LONG',
                fitFile: 'KOTR_Avignon_D4_Long.fit',
                distance: 95,
                elevation: 410,
                difficulty: 2,
                difficultyLabel: 'Moderate',
                duration: '~3.5-4.5 hours'
            }
        }
    };

    // Export ROUTES for potential external access
    window.KOTR_ROUTES = ROUTES;

    // ========================================================================
    // Route Card Rendering
    // ========================================================================

    /**
     * Generate SVG gradient definitions for elevation profiles
     * These are added once to the page and referenced by the profile SVGs
     */
    function getElevationGradientDefs() {
        return `
            <svg style="position: absolute; width: 0; height: 0; overflow: hidden;" aria-hidden="true">
                <defs>
                    <linearGradient id="elevGradientEasy" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" style="stop-color: #22C55E; stop-opacity: 0.6" />
                        <stop offset="100%" style="stop-color: #22C55E; stop-opacity: 0.1" />
                    </linearGradient>
                    <linearGradient id="elevGradientModerate" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" style="stop-color: #EAB308; stop-opacity: 0.6" />
                        <stop offset="100%" style="stop-color: #EAB308; stop-opacity: 0.1" />
                    </linearGradient>
                    <linearGradient id="elevGradientHard" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" style="stop-color: #F97316; stop-opacity: 0.6" />
                        <stop offset="100%" style="stop-color: #F97316; stop-opacity: 0.1" />
                    </linearGradient>
                    <linearGradient id="elevGradientEpic" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" style="stop-color: #EF4444; stop-opacity: 0.6" />
                        <stop offset="100%" style="stop-color: #EF4444; stop-opacity: 0.1" />
                    </linearGradient>
                </defs>
            </svg>
        `;
    }

    // Cache for precomputed elevation profiles
    let elevationProfilesCache = null;

    /**
     * Load precomputed elevation profiles from JSON
     */
    async function loadElevationProfiles() {
        if (elevationProfilesCache) return elevationProfilesCache;

        try {
            const response = await fetch('routes/elevation-profiles.json');
            if (response.ok) {
                elevationProfilesCache = await response.json();
            }
        } catch (e) {
            console.warn('Could not load elevation profiles:', e);
        }
        return elevationProfilesCache;
    }

    /**
     * Generate a mini elevation profile SVG using real elevation data
     * @param {number} distance - Route distance in km
     * @param {number} elevation - Total elevation gain in meters
     * @param {number} difficulty - Difficulty level 1-4
     * @param {string} fitFile - FIT file name for flyover link
     * @returns {string} HTML string with SVG elevation profile
     */
    function generateElevationProfileSVG(distance, elevation, difficulty, fitFile) {
        const width = 200;
        const height = 40;
        const padding = 2;

        // Try to use real elevation data from cache
        const realProfile = elevationProfilesCache && elevationProfilesCache[fitFile];
        const points = [];

        if (realProfile && realProfile.elevations && realProfile.elevations.length > 0) {
            // Use real elevation data
            const elevations = realProfile.elevations;
            const minElev = realProfile.min;
            const maxElev = realProfile.max;
            const elevRange = maxElev - minElev || 1;

            for (let i = 0; i < elevations.length; i++) {
                const x = padding + (i / (elevations.length - 1)) * (width - 2 * padding);
                // Normalize elevation to 0-1 range, then to pixel coordinates
                const normalized = (elevations[i] - minElev) / elevRange;
                const y = height - padding - (normalized * 0.85 + 0.05) * (height - 2 * padding);
                points.push({ x, y });
            }
        } else {
            // Fallback to procedural generation
            const numPoints = 50;
            for (let i = 0; i <= numPoints; i++) {
                const x = padding + (i / numPoints) * (width - 2 * padding);
                const progress = i / numPoints;
                let y = 0;

                if (difficulty === 1) {
                    y = 0.15 + 0.08 * Math.sin(progress * Math.PI * 2) + 0.05 * Math.sin(progress * Math.PI * 5);
                } else if (difficulty === 2) {
                    y = 0.25 + 0.15 * Math.sin(progress * Math.PI * 1.5) + 0.08 * Math.sin(progress * Math.PI * 4);
                } else if (difficulty === 3) {
                    const mainClimb = Math.sin(progress * Math.PI) * 0.35;
                    const smallHills = 0.1 * Math.sin(progress * Math.PI * 3);
                    y = 0.2 + mainClimb + smallHills;
                } else {
                    const initialRolling = 0.1 * Math.sin(progress * Math.PI * 2);
                    const majorClimb = progress > 0.3 ? Math.pow((progress - 0.3) / 0.7, 1.5) * 0.6 : 0;
                    const peakDescent = progress > 0.85 ? (progress - 0.85) * 2 * 0.2 : 0;
                    y = 0.15 + initialRolling + majorClimb - peakDescent;
                }

                y = Math.max(0.05, Math.min(0.9, y));
                const pixelY = height - padding - (y * (height - 2 * padding));
                points.push({ x, y: pixelY });
            }
        }

        // Create SVG path
        const linePath = points.map((p, i) =>
            (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)
        ).join(' ');

        // Create fill path (closed area under the line)
        const fillPath = linePath +
            ` L${(width - padding).toFixed(1)},${(height - padding).toFixed(1)}` +
            ` L${padding.toFixed(1)},${(height - padding).toFixed(1)} Z`;

        // Determine gradient ID based on difficulty
        const gradientId = `elevGradient${['Easy', 'Moderate', 'Hard', 'Epic'][difficulty - 1]}`;

        // Get stroke color
        const strokeColors = ['#22C55E', '#EAB308', '#F97316', '#EF4444'];
        const strokeColor = strokeColors[difficulty - 1];

        return `
            <div class="mini-elevation-profile" data-difficulty="${difficulty}" data-route="${fitFile}" title="Click for 3D flyover">
                <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
                    <path class="elevation-fill" d="${fillPath}" fill="url(#${gradientId})" />
                    <path class="elevation-line" d="${linePath}" fill="none" stroke="${strokeColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
            </div>
        `;
    }

    /**
     * Generate difficulty dots HTML based on level (1-4)
     */
    function getDifficultyDots(level) {
        const filled = '&#9679;'; // Filled circle
        const empty = '&#9675;';  // Empty circle
        let dots = '';
        for (let i = 1; i <= 4; i++) {
            dots += i <= level ? filled : empty;
        }
        return dots;
    }

    /**
     * Format elevation with comma for thousands
     */
    function formatElevation(elevation) {
        return elevation >= 1000 ? elevation.toLocaleString() : elevation;
    }

    /**
     * Render a single-option route card (Day 1 warmup style)
     */
    function renderSingleRouteCard(config) {
        const elevationProfile = generateElevationProfileSVG(
            config.distance,
            config.elevation,
            config.difficulty,
            config.fitFile
        );

        return `
            <article class="route-card ${config.type}" data-day="${config.day}">
                <div class="card-header">
                    <span class="day-badge">Day ${config.day}</span>
                    <time datetime="${config.date}">${config.dateDisplay}</time>
                    <span class="route-type-badge ${config.type}">${config.type.toUpperCase()}</span>
                </div>
                <h3>${config.name}</h3>
                <div class="route-stats-single">
                    <div class="stat">
                        <span class="stat-value">${config.distance}</span>
                        <span class="stat-label">km</span>
                    </div>
                    <div class="stat">
                        <span class="stat-value">${formatElevation(config.elevation)}</span>
                        <span class="stat-label">m elev</span>
                    </div>
                    <div class="difficulty" data-level="${config.difficulty}">
                        <span class="difficulty-dots" aria-label="Difficulty: ${config.difficultyLabel}">${getDifficultyDots(config.difficulty)}</span>
                        <span class="difficulty-label">${config.difficultyLabel}</span>
                    </div>
                    <div class="duration">${config.duration}</div>
                </div>
                ${elevationProfile}
                <p class="route-description">${config.description}</p>
                <div class="card-actions">
                    <button class="btn btn-flyover" data-route="${config.fitFile}">
                        <span class="icon">&#127916;</span> 3D Flyover
                    </button>
                    <button class="btn btn-download" data-route="${config.fitFile}">
                        <span class="icon">&#128229;</span> GPX
                    </button>
                </div>
            </article>
        `;
    }

    /**
     * Render a route option (standard or long) for comparison cards
     */
    function renderRouteOption(option, variant, isEpic = false) {
        const specialClass = option.special ? 'ventoux' : '';
        const labelHtml = option.labelIcon
            ? `<span class="mountain-icon">${option.labelIcon}</span> ${option.label}`
            : option.label;

        const elevationProfile = generateElevationProfileSVG(
            option.distance,
            option.elevation,
            option.difficulty,
            option.fitFile
        );

        let html = `
            <div class="route-option ${specialClass}" data-variant="${variant}">
                <div class="option-header">${labelHtml}</div>
                <div class="option-stats">
                    <div class="stat-row"><span class="stat-value">${option.distance}</span> km</div>
                    <div class="stat-row"><span class="stat-value">${formatElevation(option.elevation)}</span> m elev</div>
                </div>
                <div class="difficulty" data-level="${option.difficulty}">
                    <span class="difficulty-dots" aria-label="Difficulty: ${option.difficultyLabel}">${getDifficultyDots(option.difficulty)}</span>
                    <span class="difficulty-label">${option.difficultyLabel}</span>
                </div>
                <div class="duration">${option.duration}</div>
                ${elevationProfile}
                ${option.specialNote ? `<div class="special-note">${option.specialNote}</div>` : ''}
                <div class="option-actions">
                    <button class="btn btn-sm btn-flyover" data-route="${option.fitFile}">
                        <span class="icon">&#127916;</span> 3D Flyover
                    </button>
                    <button class="btn btn-sm btn-download" data-route="${option.fitFile}">
                        <span class="icon">&#128229;</span> GPX
                    </button>
                </div>
            </div>
        `;

        return html;
    }

    /**
     * Render a multi-option route card (Days 2-4 with standard/long choices)
     */
    function renderComparisonRouteCard(config) {
        const isEpic = config.type === 'epic';
        const cardClass = isEpic ? 'route-card featured' : 'route-card';
        const comparisonClass = isEpic ? 'route-comparison epic' : 'route-comparison';

        return `
            <article class="${cardClass}" data-day="${config.day}">
                <div class="card-header">
                    <span class="day-badge">Day ${config.day}</span>
                    <time datetime="${config.date}">${config.dateDisplay}</time>
                    ${isEpic ? '<span class="featured-badge">EPIC DAY</span>' : ''}
                </div>
                <h3>${config.name}</h3>

                <div class="${comparisonClass}">
                    ${renderRouteOption(config.standard, 'standard', isEpic)}
                    ${renderRouteOption(config.long, 'long', isEpic)}
                </div>
            </article>
        `;
    }

    /**
     * Render all route cards from ROUTES config
     */
    function renderRouteCards() {
        const container = document.getElementById('route-cards');
        if (!container) {
            console.warn('Route cards container not found');
            return;
        }

        // Add gradient definitions to the page (only once)
        if (!document.getElementById('elevation-gradients')) {
            const gradientContainer = document.createElement('div');
            gradientContainer.id = 'elevation-gradients';
            gradientContainer.innerHTML = getElevationGradientDefs();
            document.body.appendChild(gradientContainer);
        }

        let html = '';

        // Render each day's card
        Object.keys(ROUTES).forEach(key => {
            const config = ROUTES[key];

            if (config.type === 'warmup') {
                // Single option card (Day 1)
                html += renderSingleRouteCard(config);
            } else {
                // Comparison card (Days 2-4)
                html += renderComparisonRouteCard(config);
            }
        });

        container.innerHTML = html;

        // Setup click handlers for elevation profiles
        setupElevationProfileClicks();
    }

    /**
     * Setup click handlers for mini elevation profiles to open flyover
     */
    function setupElevationProfileClicks() {
        const profiles = document.querySelectorAll('.mini-elevation-profile');
        profiles.forEach(profile => {
            profile.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering route option selection
                const routeFile = profile.dataset.route;
                if (routeFile) {
                    window.location.href = `flyover.html?route=${encodeURIComponent(routeFile)}`;
                }
            });
        });
    }

    // ========================================================================
    // Training Plan Configuration
    // ========================================================================

    const EVENT_DATE = new Date('2026-05-28T00:00:00');
    const VENTOUX_ELEVATION = 2230; // meters of climbing for Ventoux route

    /**
     * Training phases based on weeks until event
     */
    const TRAINING_PHASES = {
        base: {
            name: 'Base Building',
            badgeClass: 'base',
            minWeeks: 12,
            maxWeeks: Infinity,
            weeklyHours: '6-8 hours/week',
            description: 'Focus on building aerobic endurance with long, steady rides. Keep intensity low (Zone 2) and gradually increase weekly volume. This foundation will support harder efforts later.',
            workouts: [
                {
                    icon: '\u{1F6B4}',
                    name: 'Long Endurance Ride',
                    description: 'Steady Zone 2 effort, building duration each week.',
                    target: '2-4 hours'
                },
                {
                    icon: '\u{1F3D4}\u{FE0F}',
                    name: 'Hilly Ride',
                    description: 'Include some climbing to build leg strength and climbing efficiency.',
                    target: '1-2 hours with hills'
                },
                {
                    icon: '\u{1F4AA}',
                    name: 'Recovery Spin',
                    description: 'Easy spinning to promote recovery between harder sessions.',
                    target: '30-60 min very easy'
                }
            ]
        },
        build: {
            name: 'Build Phase',
            badgeClass: 'build',
            minWeeks: 8,
            maxWeeks: 12,
            weeklyHours: '8-10 hours/week',
            description: 'Introduce structured intensity while maintaining endurance. Start adding threshold work and climbing intervals to prepare your body for sustained efforts.',
            workouts: [
                {
                    icon: '\u{26A1}',
                    name: 'Threshold Intervals',
                    description: '20-30 minute efforts at FTP to build sustained power for Ventoux.',
                    target: '2x20min @ FTP'
                },
                {
                    icon: '\u{1F3D4}\u{FE0F}',
                    name: 'Climbing Repeats',
                    description: 'Find a local climb and repeat it to build climbing-specific fitness.',
                    target: '3-5 x 8-12min climbs'
                },
                {
                    icon: '\u{1F6B4}',
                    name: 'Long Endurance Ride',
                    description: 'Continue building aerobic base with weekly long rides.',
                    target: '3-4 hours Zone 2'
                }
            ]
        },
        peak: {
            name: 'Peak Phase',
            badgeClass: 'peak',
            minWeeks: 4,
            maxWeeks: 8,
            weeklyHours: '10-12 hours/week',
            description: 'Maximum training load with event-specific preparation. This is your highest volume period - include long climbs that simulate Ventoux\'s demands.',
            workouts: [
                {
                    icon: '\u{1F525}',
                    name: 'Over-Under Intervals',
                    description: 'Alternate above and below FTP to handle variable gradients.',
                    target: '3x12min (2min over/2min under)'
                },
                {
                    icon: '\u{1F3D4}\u{FE0F}',
                    name: 'Long Sustained Climb',
                    description: '45+ minute continuous climb - key prep for Ventoux.',
                    target: '45-60min steady climb'
                },
                {
                    icon: '\u{1F6B4}',
                    name: 'Back-to-Back Days',
                    description: 'Simulate multi-day event with consecutive riding days.',
                    target: 'Long ride + medium ride'
                }
            ]
        },
        taper: {
            name: 'Taper Phase',
            badgeClass: 'taper',
            minWeeks: 2,
            maxWeeks: 4,
            weeklyHours: '8 hours (reducing 20%/week)',
            description: 'Reduce volume while maintaining some intensity. Your body needs time to absorb the training and arrive fresh. Trust the process!',
            workouts: [
                {
                    icon: '\u{26A1}',
                    name: 'Short Sharp Efforts',
                    description: 'Brief high-intensity to maintain top-end without fatigue.',
                    target: '4-6 x 3min @ VO2max'
                },
                {
                    icon: '\u{1F6B4}',
                    name: 'Moderate Endurance',
                    description: 'Shorter endurance rides to stay loose without building fatigue.',
                    target: '1.5-2 hours easy'
                },
                {
                    icon: '\u{1F9D8}',
                    name: 'Active Recovery',
                    description: 'Very easy spinning to keep legs fresh.',
                    target: '30-45 min Zone 1'
                }
            ]
        },
        finalWeek: {
            name: 'Final Week',
            badgeClass: 'taper',
            minWeeks: 1,
            maxWeeks: 2,
            weeklyHours: '3-4 hours total',
            description: 'Easy spinning only. The hay is in the barn - no training gains possible now. Focus on rest, hydration, nutrition, and mental preparation.',
            workouts: [
                {
                    icon: '\u{1F6B4}',
                    name: 'Openers',
                    description: 'Short ride with a few brief efforts to keep legs snappy.',
                    target: '45min with 3x30sec sprints'
                },
                {
                    icon: '\u{1F9D8}',
                    name: 'Easy Spin',
                    description: 'Very gentle spinning to stay loose without any fatigue.',
                    target: '30-45 min very easy'
                },
                {
                    icon: '\u{1F4A4}',
                    name: 'Rest Day',
                    description: 'Complete rest or light stretching. Sleep is your best friend.',
                    target: 'Full rest'
                }
            ]
        },
        eventWeek: {
            name: 'Event Week',
            badgeClass: 'event',
            minWeeks: 0,
            maxWeeks: 1,
            weeklyHours: 'Light rides only',
            description: 'You\'ve made it! Light rides only to stay fresh. Trust your training, enjoy the experience, and soak in the Provencal scenery.',
            workouts: [
                {
                    icon: '\u{2600}\u{FE0F}',
                    name: 'Pre-Event Spin',
                    description: 'Day before: short easy spin to shake out travel legs.',
                    target: '20-30 min very easy'
                },
                {
                    icon: '\u{1F37D}\u{FE0F}',
                    name: 'Nutrition Focus',
                    description: 'Load carbs, stay hydrated, avoid anything unusual.',
                    target: 'Eat well, rest well'
                },
                {
                    icon: '\u{1F3C6}',
                    name: 'Enjoy the Ride!',
                    description: 'You\'re ready. Pace yourself and savor every kilometer.',
                    target: 'Have fun!'
                }
            ]
        }
    };

    /**
     * Calculate weeks until event from a given date
     * @param {Date} fromDate - Date to calculate from
     * @returns {number} - Weeks until event (can be negative if past)
     */
    function calculateWeeksUntilEvent(fromDate = new Date()) {
        const msPerWeek = 7 * 24 * 60 * 60 * 1000;
        const diff = EVENT_DATE.getTime() - fromDate.getTime();
        return diff / msPerWeek;
    }

    /**
     * Get the current training phase based on weeks until event
     * @param {number} weeksUntil - Weeks until event
     * @returns {object} - Training phase configuration
     */
    function getTrainingPhase(weeksUntil) {
        if (weeksUntil <= 0) {
            return null; // Event has passed
        }
        if (weeksUntil <= 1) {
            return TRAINING_PHASES.eventWeek;
        }
        if (weeksUntil <= 2) {
            return TRAINING_PHASES.finalWeek;
        }
        if (weeksUntil <= 4) {
            return TRAINING_PHASES.taper;
        }
        if (weeksUntil <= 8) {
            return TRAINING_PHASES.peak;
        }
        if (weeksUntil <= 12) {
            return TRAINING_PHASES.build;
        }
        return TRAINING_PHASES.base;
    }

    /**
     * Format date for display
     * @param {Date} date - Date to format
     * @returns {string} - Formatted date string
     */
    function formatEventDate(date) {
        const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
        return date.toLocaleDateString('en-US', options);
    }

    /**
     * Render the Training Countdown section
     */
    function renderTrainingCountdown() {
        const container = document.getElementById('training-countdown-content');
        if (!container) return;

        const now = new Date();
        const weeksUntil = calculateWeeksUntilEvent(now);
        const daysUntil = Math.ceil(weeksUntil * 7);
        const phase = getTrainingPhase(weeksUntil);

        // Event has passed
        if (weeksUntil < 0) {
            container.innerHTML = renderEventComplete();
            return;
        }

        // Get personalized info if available
        let personalizedNote = '';
        if (typeof RiderProfile !== 'undefined' && RiderProfile.isConfigured()) {
            const profile = RiderProfile.get();
            personalizedNote = renderPersonalizedNote(profile, phase);
        }

        // Determine card class based on phase
        let phaseCardClass = 'training-phase-card';
        if (phase === TRAINING_PHASES.finalWeek || phase === TRAINING_PHASES.taper) {
            phaseCardClass += ' taper-week';
        }
        if (phase === TRAINING_PHASES.eventWeek) {
            phaseCardClass += ' event-week';
        }

        const html = `
            <div class="training-countdown-header">
                <div class="countdown-weeks">
                    <span class="weeks-value">${Math.floor(weeksUntil)}</span>
                    <span class="weeks-label">Weeks to go</span>
                </div>
                <div class="countdown-event-date">
                    <div class="event-label">Event starts</div>
                    <div class="event-date">${formatEventDate(EVENT_DATE)}</div>
                </div>
            </div>

            <div class="${phaseCardClass}">
                <div class="training-phase-header">
                    <h4 class="training-phase-name">${phase.name}</h4>
                    <span class="training-phase-badge ${phase.badgeClass}">${phase.badgeClass.toUpperCase()}</span>
                </div>
                <p class="training-phase-description">${phase.description}</p>

                <div class="training-volume">
                    <span class="volume-icon">\u{23F1}\u{FE0F}</span>
                    <div class="volume-details">
                        <span class="volume-label">Recommended Weekly Volume</span>
                        <span class="volume-value">${phase.weeklyHours}</span>
                    </div>
                </div>

                <div class="key-workouts">
                    <h5 class="key-workouts-title">Key Workouts This Week</h5>
                    <div class="workouts-grid">
                        ${phase.workouts.map(workout => renderWorkoutCard(workout)).join('')}
                    </div>
                </div>
            </div>

            ${renderVentouxCallout(phase)}
            ${personalizedNote}
        `;

        container.innerHTML = html;
    }

    /**
     * Render a single workout card
     * @param {object} workout - Workout configuration
     * @returns {string} - HTML string
     */
    function renderWorkoutCard(workout) {
        return `
            <div class="workout-card">
                <div class="workout-header">
                    <span class="workout-icon">${workout.icon}</span>
                    <span class="workout-name">${workout.name}</span>
                </div>
                <p class="workout-description">${workout.description}</p>
                <div class="workout-target">
                    <span>\u{1F3AF}</span>
                    <span>${workout.target}</span>
                </div>
            </div>
        `;
    }

    /**
     * Render Ventoux preparation callout (shown during build and peak phases)
     * @param {object} phase - Current training phase
     * @returns {string} - HTML string
     */
    function renderVentouxCallout(phase) {
        // Only show during build and peak phases
        if (phase !== TRAINING_PHASES.build && phase !== TRAINING_PHASES.peak) {
            return '';
        }

        return `
            <div class="ventoux-prep-callout">
                <span class="callout-icon">\u{1F3D4}\u{FE0F}</span>
                <div class="callout-content">
                    <h4>Preparing for Mont Ventoux</h4>
                    <p>The Ventoux climb features ${VENTOUX_ELEVATION.toLocaleString()}m of climbing over 131km.
                    Focus on sustained threshold efforts of 20-30 minutes to simulate the 21.5km ascent at 7.5% average gradient.
                    If possible, find a local climb of 45+ minutes to practice pacing and nutrition strategy.</p>
                </div>
            </div>
        `;
    }

    /**
     * Render personalized training note based on rider profile
     * @param {object} profile - Rider profile
     * @param {object} phase - Current training phase
     * @returns {string} - HTML string
     */
    function renderPersonalizedNote(profile, phase) {
        const { weight, ftp } = profile;
        const wkg = (ftp / weight).toFixed(2);

        let advice = '';
        if (wkg < 2.5) {
            advice = 'Focus on building FTP through consistent training. Even small improvements will make the climbs more manageable.';
        } else if (wkg < 3.5) {
            advice = 'Good fitness base! Continue building power while focusing on climbing efficiency and pacing.';
        } else if (wkg < 4.5) {
            advice = 'Strong power-to-weight ratio. Fine-tune your pacing strategy and work on sustained efforts at altitude.';
        } else {
            advice = 'Excellent fitness level. Focus on maintaining while perfecting your race-day nutrition and hydration strategy.';
        }

        return `
            <div class="personalized-training-note">
                <span class="note-icon">\u{1F464}</span>
                <div class="note-content">
                    <strong>For you (${weight}kg, <span class="ftp-value">${ftp}W</span> FTP = ${wkg} W/kg):</strong>
                    ${advice}
                </div>
            </div>
        `;
    }

    /**
     * Render event complete message (shown after event has passed)
     * @returns {string} - HTML string
     */
    function renderEventComplete() {
        return `
            <div class="training-event-complete">
                <span class="complete-icon">\u{1F3C6}</span>
                <h4>Thanks for Riding!</h4>
                <p>KOTR 2026 has concluded. We hope you had an incredible experience cycling through Provence and conquering Mont Ventoux!</p>
            </div>
        `;
    }

    /**
     * Update training countdown when profile changes
     */
    function updateTrainingCountdown() {
        renderTrainingCountdown();
    }

    // ========================================================================
    // State
    // ========================================================================

    // State
    let map = null;
    let routeLayers = [];
    let selectedVariants = {
        2: 'standard',
        3: 'standard',
        4: 'standard'
    };

    // ========================================================================
    // Route Comparison Table
    // ========================================================================

    /**
     * Calculate totals for all standard routes or all long routes
     * @param {string} variant - 'standard' or 'long'
     * @returns {object} - { distance, elevation, timeMinutes, energyKj }
     */
    function calculateVariantTotals(variant) {
        let totalDistance = 0;
        let totalElevation = 0;

        Object.keys(ROUTES).forEach(key => {
            const config = ROUTES[key];

            if (config.type === 'warmup') {
                // Day 1 is always the same
                totalDistance += config.distance;
                totalElevation += config.elevation;
            } else {
                // Multi-option day - use specified variant
                const selected = config[variant] || config.standard;
                totalDistance += selected.distance;
                totalElevation += selected.elevation;
            }
        });

        return {
            distance: totalDistance,
            elevation: totalElevation
        };
    }

    /**
     * Calculate time and energy estimates for a variant using PowerCalculator
     * @param {string} variant - 'standard' or 'long'
     * @param {number} weight - Rider weight in kg
     * @param {number} ftp - FTP in watts
     * @returns {object} - { timeMinutes, energyKj }
     */
    function calculateVariantMetrics(variant, weight, ftp) {
        let totalMinutes = 0;
        let totalKj = 0;

        Object.keys(ROUTES).forEach(key => {
            const config = ROUTES[key];
            let distance, elevation;

            if (config.type === 'warmup') {
                distance = config.distance;
                elevation = config.elevation;
            } else {
                const selected = config[variant] || config.standard;
                distance = selected.distance;
                elevation = selected.elevation;
            }

            // Create mock route data for calculation
            const mockRouteData = {
                distance: distance,
                elevationGain: elevation,
                coordinates: generateMockCoordinates(distance, elevation)
            };

            // Calculate metrics using PowerCalculator
            if (typeof PowerCalculator !== 'undefined') {
                const metrics = PowerCalculator.calculateRouteMetrics(mockRouteData, weight, ftp);
                if (metrics) {
                    const steadyTime = metrics.timeEstimates.find(t => t.label === 'Steady');
                    if (steadyTime && steadyTime.seconds) {
                        totalMinutes += steadyTime.seconds / 60;
                    }
                    if (metrics.energy && metrics.energy.kilojoules) {
                        totalKj += metrics.energy.kilojoules;
                    }
                }
            }
        });

        return {
            timeMinutes: totalMinutes,
            energyKj: totalKj
        };
    }

    /**
     * Format time in hours and minutes for comparison table
     * @param {number} totalMinutes - Total time in minutes
     * @returns {string} - Formatted time string (e.g., "11h 20m")
     */
    function formatComparisonTime(totalMinutes) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = Math.round(totalMinutes % 60);

        if (hours === 0) {
            return `${minutes}m`;
        } else if (minutes === 0) {
            return `${hours}h`;
        } else {
            return `${hours}h ${minutes}m`;
        }
    }

    /**
     * Format delta value with + sign for positive numbers
     * @param {number} value - The delta value
     * @param {string} unit - The unit (km, m, etc.)
     * @returns {string} - Formatted delta string
     */
    function formatDelta(value, unit) {
        const sign = value >= 0 ? '+' : '';
        if (unit === 'time') {
            // Format time delta
            const hours = Math.floor(Math.abs(value) / 60);
            const minutes = Math.round(Math.abs(value) % 60);
            if (hours === 0) {
                return `${sign}${minutes}m`;
            }
            return `${sign}${hours}h ${minutes}m`;
        }
        return `${sign}${value.toLocaleString()} ${unit}`;
    }

    /**
     * Render the route comparison table
     */
    function renderComparisonTable() {
        const tableBody = document.getElementById('comparison-table-body');
        const noteElement = document.getElementById('comparison-note');
        const noteText = document.getElementById('comparison-note-text');
        const standardBadge = document.getElementById('standard-easier-badge');
        const longBadge = document.getElementById('long-harder-badge');

        if (!tableBody) return;

        // Calculate totals for both variants
        const standardTotals = calculateVariantTotals('standard');
        const longTotals = calculateVariantTotals('long');

        // Check if rider profile is configured
        const hasProfile = typeof RiderProfile !== 'undefined' && RiderProfile.isConfigured();
        let standardMetrics = null;
        let longMetrics = null;

        if (hasProfile) {
            const profile = RiderProfile.get();
            standardMetrics = calculateVariantMetrics('standard', profile.weight, profile.ftp);
            longMetrics = calculateVariantMetrics('long', profile.weight, profile.ftp);
        }

        // Show badges
        if (standardBadge) standardBadge.hidden = false;
        if (longBadge) longBadge.hidden = false;

        // Build table rows
        let html = '';

        // Distance row
        html += `
            <tr>
                <td class="metric-col">Total Distance</td>
                <td class="standard-col">
                    <span class="value">${standardTotals.distance}</span>
                    <span class="unit">km</span>
                </td>
                <td class="long-col">
                    <span class="value">${longTotals.distance}</span>
                    <span class="unit">km</span>
                </td>
                <td class="delta-col">
                    <span class="delta-value">${formatDelta(longTotals.distance - standardTotals.distance, 'km')}</span>
                </td>
            </tr>
        `;

        // Elevation row
        html += `
            <tr>
                <td class="metric-col">Total Climbing</td>
                <td class="standard-col">
                    <span class="value">${standardTotals.elevation.toLocaleString()}</span>
                    <span class="unit">m</span>
                </td>
                <td class="long-col">
                    <span class="value">${longTotals.elevation.toLocaleString()}</span>
                    <span class="unit">m</span>
                </td>
                <td class="delta-col">
                    <span class="delta-value">${formatDelta(longTotals.elevation - standardTotals.elevation, 'm')}</span>
                </td>
            </tr>
        `;

        // Time estimate row (personalized or hidden)
        if (hasProfile && standardMetrics && longMetrics) {
            html += `
                <tr class="personalized-row">
                    <td class="metric-col">Est. Time</td>
                    <td class="standard-col">
                        <span class="value">${formatComparisonTime(standardMetrics.timeMinutes)}</span>
                        <span class="unit">@ 75% FTP</span>
                    </td>
                    <td class="long-col">
                        <span class="value">${formatComparisonTime(longMetrics.timeMinutes)}</span>
                        <span class="unit">@ 75% FTP</span>
                    </td>
                    <td class="delta-col">
                        <span class="delta-value">${formatDelta(longMetrics.timeMinutes - standardMetrics.timeMinutes, 'time')}</span>
                    </td>
                </tr>
            `;

            // Energy row (personalized)
            html += `
                <tr class="personalized-row">
                    <td class="metric-col">Energy</td>
                    <td class="standard-col">
                        <span class="value">${standardMetrics.energyKj.toLocaleString()}</span>
                        <span class="unit">kJ</span>
                    </td>
                    <td class="long-col">
                        <span class="value">${longMetrics.energyKj.toLocaleString()}</span>
                        <span class="unit">kJ</span>
                    </td>
                    <td class="delta-col">
                        <span class="delta-value">${formatDelta(longMetrics.energyKj - standardMetrics.energyKj, 'kJ')}</span>
                    </td>
                </tr>
            `;

            // Update note for profile configured
            if (noteElement && noteText) {
                const profile = RiderProfile.get();
                noteElement.classList.add('has-profile');
                noteText.textContent = `Personalized estimates based on your profile (${profile.weight}kg, ${profile.ftp}W FTP). Times assume steady 75% FTP effort.`;
            }
        } else {
            // No profile - show note to set up profile
            if (noteElement && noteText) {
                noteElement.classList.remove('has-profile');
                noteText.textContent = 'Set up your rider profile to see personalized time and energy estimates.';
            }
        }

        tableBody.innerHTML = html;
    }

    /**
     * Update the comparison table (called when profile changes)
     */
    function updateComparisonTable() {
        renderComparisonTable();
    }

    // ========================================================================
    // Trip Summary Bar
    // ========================================================================

    /**
     * Calculate trip totals based on current variant selections
     */
    function calculateTripTotals() {
        let totalDistance = 0;
        let totalElevation = 0;

        Object.keys(ROUTES).forEach(key => {
            const config = ROUTES[key];
            const day = config.day;

            if (config.type === 'warmup') {
                // Single option day
                totalDistance += config.distance;
                totalElevation += config.elevation;
            } else {
                // Multi-option day - use selected variant
                const variant = selectedVariants[day] || 'standard';
                const selected = config[variant] || config.standard;
                totalDistance += selected.distance;
                totalElevation += selected.elevation;
            }
        });

        return {
            days: Object.keys(ROUTES).length,
            distance: totalDistance,
            elevation: totalElevation
        };
    }

    /**
     * Calculate total estimated time based on rider profile
     */
    function calculateTotalTime(weight, ftp) {
        let totalMinutes = 0;

        Object.keys(ROUTES).forEach(key => {
            const config = ROUTES[key];
            const day = config.day;

            let distance, elevation;

            if (config.type === 'warmup') {
                distance = config.distance;
                elevation = config.elevation;
            } else {
                const variant = selectedVariants[day] || 'standard';
                const selected = config[variant] || config.standard;
                distance = selected.distance;
                elevation = selected.elevation;
            }

            // Create mock route data for calculation
            const mockRouteData = {
                distance: distance,
                elevationGain: elevation,
                coordinates: generateMockCoordinates(distance, elevation)
            };

            // Calculate metrics
            if (typeof PowerCalculator !== 'undefined') {
                const metrics = PowerCalculator.calculateRouteMetrics(mockRouteData, weight, ftp);
                if (metrics) {
                    const steadyTime = metrics.timeEstimates.find(t => t.label === 'Steady');
                    if (steadyTime && steadyTime.seconds) {
                        totalMinutes += steadyTime.seconds / 60;
                    }
                }
            }
        });

        return totalMinutes;
    }

    /**
     * Format time in hours and minutes
     */
    function formatTime(totalMinutes) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = Math.round(totalMinutes % 60);

        if (hours === 0) {
            return `${minutes}m`;
        } else if (minutes === 0) {
            return `${hours}h`;
        } else {
            return `${hours}h ${minutes}m`;
        }
    }

    /**
     * Update the trip summary bar display
     */
    function updateTripSummary() {
        const totals = calculateTripTotals();

        // Update DOM elements
        const daysEl = document.getElementById('summary-days');
        const distanceEl = document.getElementById('summary-distance');
        const elevationEl = document.getElementById('summary-elevation');
        const timeContainerEl = document.getElementById('summary-time-container');
        const timeEl = document.getElementById('summary-time');
        const timeLabelEl = document.getElementById('summary-time-label');

        if (daysEl) daysEl.textContent = totals.days;
        if (distanceEl) distanceEl.textContent = totals.distance.toLocaleString();
        if (elevationEl) elevationEl.textContent = totals.elevation.toLocaleString();

        // Show time estimate only if rider profile is configured
        if (typeof RiderProfile !== 'undefined' && RiderProfile.isConfigured()) {
            const profile = RiderProfile.get();
            const totalMinutes = calculateTotalTime(profile.weight, profile.ftp);

            if (timeContainerEl) timeContainerEl.style.display = '';
            if (timeEl) timeEl.textContent = '~' + formatTime(totalMinutes);
            if (timeLabelEl) timeLabelEl.textContent = '@ 75% FTP';
        } else {
            if (timeContainerEl) timeContainerEl.style.display = 'none';
        }
    }

    /**
     * Setup sticky behavior for the trip summary bar
     */
    function setupStickyTripSummary() {
        const summaryBar = document.getElementById('trip-summary-bar');
        if (!summaryBar) return;

        // Get the initial offset position
        let summaryBarOffset = summaryBar.offsetTop;

        // Update offset on resize (in case layout changes)
        window.addEventListener('resize', () => {
            // Temporarily remove stuck state to get true offset
            if (!summaryBar.classList.contains('is-stuck')) {
                summaryBarOffset = summaryBar.offsetTop;
            }
        });

        // Handle scroll
        function handleScroll() {
            if (window.pageYOffset >= summaryBarOffset) {
                summaryBar.classList.add('is-stuck');
            } else {
                summaryBar.classList.remove('is-stuck');
            }
        }

        window.addEventListener('scroll', handleScroll, { passive: true });

        // Initial check
        handleScroll();
    }

    /**
     * Get all route files for current selections
     */
    function getSelectedRouteFiles() {
        const files = [];

        Object.keys(ROUTES).forEach(key => {
            const config = ROUTES[key];
            const day = config.day;

            if (config.type === 'warmup') {
                files.push(config.fitFile);
            } else {
                const variant = selectedVariants[day] || 'standard';
                const selected = config[variant] || config.standard;
                files.push(selected.fitFile);
            }
        });

        return files;
    }

    /**
     * Setup Download All GPX button
     */
    function setupDownloadAllGPX() {
        const btn = document.getElementById('download-all-gpx');
        if (!btn) return;

        btn.addEventListener('click', async () => {
            const originalText = btn.innerHTML;
            btn.innerHTML = '<span class="icon">&#8987;</span> Downloading...';
            btn.disabled = true;

            try {
                const files = getSelectedRouteFiles();

                // Download each file sequentially
                for (const file of files) {
                    try {
                        const routeData = await FitParser.loadFitFile(`routes/${file}`);
                        const gpxFilename = file.replace('.fit', '.gpx');
                        FitParser.downloadGPX(routeData, gpxFilename);

                        // Small delay between downloads to prevent browser blocking
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } catch (error) {
                        console.error(`Failed to download ${file}:`, error);
                    }
                }
            } catch (error) {
                console.error('Failed to download routes:', error);
                alert('Failed to download some routes. Please try again.');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });
    }

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
        // Load any saved selections from localStorage
        loadRouteSelections();

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

                    // Persist to localStorage
                    saveRouteSelections();

                    // Update trip summary totals
                    updateTripSummary();

                    // Update route analysis for this card with new variant
                    if (typeof RiderProfile !== 'undefined' && RiderProfile.isConfigured()) {
                        const profile = RiderProfile.get();
                        updateCardAnalysis(card, profile.weight, profile.ftp);
                    }
                });
            });

            // Set initial active state based on saved/default selection
            const defaultVariant = selectedVariants[day] || 'standard';
            const defaultOption = card.querySelector(`.route-option[data-variant="${defaultVariant}"]`);
            if (defaultOption) {
                defaultOption.classList.add('active');
            }
        });
    }

    /**
     * Setup flyover buttons for all routes
     */
    function setupFlyoverButtons() {
        const flyoverButtons = document.querySelectorAll('.btn-flyover');
        flyoverButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const routeFile = btn.dataset.route;
                if (routeFile) {
                    window.location.href = `flyover.html?route=${encodeURIComponent(routeFile)}`;
                }
            });
        });
    }

    /**
     * Setup download buttons for all routes
     */
    function setupDownloadButtons() {
        const downloadButtons = document.querySelectorAll('.btn-download');
        downloadButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const routeFile = btn.dataset.route;
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
     * Storage key for profile setup prompt dismissal
     */
    const PROFILE_PROMPT_DISMISSED_KEY = 'kotr-profile-prompt-dismissed';

    /**
     * Storage key for route selections
     */
    const ROUTE_SELECTIONS_KEY = 'kotr-route-selections';

    /**
     * Load route selections from localStorage
     */
    function loadRouteSelections() {
        try {
            const stored = localStorage.getItem(ROUTE_SELECTIONS_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                // Validate and apply stored selections
                [2, 3, 4].forEach(day => {
                    if (parsed[day] === 'standard' || parsed[day] === 'long') {
                        selectedVariants[day] = parsed[day];
                    }
                });
            }
        } catch (e) {
            console.warn('Failed to load route selections:', e);
        }
    }

    /**
     * Save route selections to localStorage
     */
    function saveRouteSelections() {
        try {
            localStorage.setItem(ROUTE_SELECTIONS_KEY, JSON.stringify(selectedVariants));
        } catch (e) {
            console.warn('Failed to save route selections:', e);
        }
    }

    /**
     * Initialize profile setup prompt
     * Shows the prompt for first-time visitors who haven't configured their profile
     */
    function initProfileSetupPrompt() {
        const promptSection = document.getElementById('profile-setup-prompt');
        if (!promptSection) return;

        // Check if profile is already configured
        if (typeof RiderProfile !== 'undefined' && RiderProfile.isConfigured()) {
            promptSection.hidden = true;
            return;
        }

        // Check if user has dismissed the prompt before
        try {
            const dismissed = localStorage.getItem(PROFILE_PROMPT_DISMISSED_KEY);
            if (dismissed === 'true') {
                promptSection.hidden = true;
                return;
            }
        } catch (e) {
            console.warn('Failed to check profile prompt dismissal:', e);
        }

        // Show the prompt
        promptSection.hidden = false;

        // Setup button handlers
        const setupBtn = document.getElementById('profile-prompt-setup');
        const skipBtn = document.getElementById('profile-prompt-skip');

        if (setupBtn) {
            setupBtn.addEventListener('click', () => {
                // Open the rider profile modal
                if (typeof RiderProfile !== 'undefined') {
                    RiderProfile.showModal();
                }
                // Hide the prompt (will be hidden permanently after profile is saved)
                promptSection.hidden = true;
            });
        }

        if (skipBtn) {
            skipBtn.addEventListener('click', () => {
                // Remember dismissal in localStorage
                try {
                    localStorage.setItem(PROFILE_PROMPT_DISMISSED_KEY, 'true');
                } catch (e) {
                    console.warn('Failed to save profile prompt dismissal:', e);
                }
                // Hide the prompt
                promptSection.hidden = true;
            });
        }
    }

    /**
     * Hide profile setup prompt when profile is configured
     * Called when profile changes
     */
    function updateProfilePromptVisibility() {
        const promptSection = document.getElementById('profile-setup-prompt');
        if (!promptSection) return;

        if (typeof RiderProfile !== 'undefined' && RiderProfile.isConfigured()) {
            promptSection.hidden = true;
        }
    }

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
        } else if (routeConfig.standard) {
            // Standard variant selected (or fallback)
            distance = routeConfig.standard.distance;
            elevation = routeConfig.standard.elevation;
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
     * Creates a simple linear route with the correct haversine distance
     * and elevation profile matching the route statistics
     */
    function generateMockCoordinates(distanceKm, elevationGainM) {
        const numPoints = 100;
        const coords = [];

        // At 44° latitude:
        // 1° longitude ≈ 79km * cos(44°) ≈ 57km
        // 1° latitude ≈ 111km
        // For a diagonal path with aspect 0.6, total distance ≈ sqrt(lonKm² + latKm²)
        // We need coords to span the actual route distance via haversine

        // Scale factor: for every 100km of route, span about 0.8° lat, 0.5° lon
        // This gives haversine distance of ~100km
        const scaleFactor = distanceKm / 100;
        const lonSpan = 0.5 * scaleFactor;  // degrees longitude
        const latSpan = 0.8 * scaleFactor;  // degrees latitude

        // Simple elevation profile: gradual climb to elevationGain, with gentle undulation
        // This matches what cyclists expect - net gain is the specified elevation
        const startElevation = 100; // Avignon area

        for (let i = 0; i < numPoints; i++) {
            const progress = i / (numPoints - 1);

            // Gentle sinusoidal undulation around a linear climb
            // Net elevation gain = elevationGainM at the end
            const baseElevation = startElevation + elevationGainM * progress;
            const undulation = elevationGainM * 0.1 * Math.sin(progress * Math.PI * 6);
            const elevation = Math.max(50, baseElevation + undulation);

            coords.push([
                4.8 + progress * lonSpan,   // Longitude
                43.9 + progress * latSpan,  // Latitude
                elevation
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
    async function init() {
        // Load real elevation profiles before rendering cards
        await loadElevationProfiles();

        // Render route cards from ROUTES config (single source of truth)
        renderRouteCards();

        initOverviewMap();
        setupRouteOptions();
        setupFlyoverButtons();
        setupDownloadButtons();
        setupDropdownToggles();
        initWeather();
        setupSmoothScroll();

        // Initialize trip summary bar
        setupStickyTripSummary();
        setupDownloadAllGPX();
        updateTripSummary();

        // Initialize rider profile
        if (typeof RiderProfile !== 'undefined') {
            RiderProfile.init();

            // Initialize profile setup prompt (must be after RiderProfile.init())
            initProfileSetupPrompt();

            // Listen for profile changes
            RiderProfile.setOnChange(() => {
                updateRouteAnalysis();
                updateTripSummary();
                updateProfilePromptVisibility();
                updateComparisonTable();
                updateTrainingCountdown();
            });

            // Initial analysis update
            updateRouteAnalysis();
            // Update trip summary with profile data if available
            updateTripSummary();
        }

        // Render the route comparison table
        renderComparisonTable();

        // Render the training countdown section
        renderTrainingCountdown();

        console.log('KOTR 2026 initialized');
    }

    // Run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

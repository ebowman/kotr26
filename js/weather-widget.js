/**
 * KOTR 2026 - Weather Widget
 * Uses Open-Meteo API for weather forecasts
 * https://open-meteo.com/
 */

const WeatherWidget = (function() {
    'use strict';

    // Avignon, France coordinates
    const LOCATION = {
        lat: 43.9493,
        lng: 4.8055,
        name: 'Avignon, France'
    };

    // Event dates (May 28 - June 1, 2026)
    const EVENT_DATES = {
        start: '2026-05-28',
        end: '2026-06-01',
        days: [
            { date: '2026-05-28', label: 'Arrival', isEventDay: true },
            { date: '2026-05-29', label: 'Day 1', isEventDay: true },
            { date: '2026-05-30', label: 'Day 2', isEventDay: true },
            { date: '2026-05-31', label: 'Day 3', isEventDay: true },
            { date: '2026-06-01', label: 'Day 4', isEventDay: true }
        ]
    };

    // Weather code to emoji mapping
    const WEATHER_ICONS = {
        0: { icon: '☀️', desc: 'Clear sky' },
        1: { icon: '🌤️', desc: 'Mainly clear' },
        2: { icon: '⛅', desc: 'Partly cloudy' },
        3: { icon: '☁️', desc: 'Overcast' },
        45: { icon: '🌫️', desc: 'Fog' },
        48: { icon: '🌫️', desc: 'Depositing rime fog' },
        51: { icon: '🌦️', desc: 'Light drizzle' },
        53: { icon: '🌦️', desc: 'Moderate drizzle' },
        55: { icon: '🌧️', desc: 'Dense drizzle' },
        56: { icon: '🌨️', desc: 'Freezing drizzle' },
        57: { icon: '🌨️', desc: 'Dense freezing drizzle' },
        61: { icon: '🌧️', desc: 'Slight rain' },
        63: { icon: '🌧️', desc: 'Moderate rain' },
        65: { icon: '🌧️', desc: 'Heavy rain' },
        66: { icon: '🌨️', desc: 'Light freezing rain' },
        67: { icon: '🌨️', desc: 'Heavy freezing rain' },
        71: { icon: '❄️', desc: 'Slight snow' },
        73: { icon: '❄️', desc: 'Moderate snow' },
        75: { icon: '❄️', desc: 'Heavy snow' },
        77: { icon: '🌨️', desc: 'Snow grains' },
        80: { icon: '🌦️', desc: 'Slight rain showers' },
        81: { icon: '🌧️', desc: 'Moderate rain showers' },
        82: { icon: '⛈️', desc: 'Violent rain showers' },
        85: { icon: '🌨️', desc: 'Slight snow showers' },
        86: { icon: '🌨️', desc: 'Heavy snow showers' },
        95: { icon: '⛈️', desc: 'Thunderstorm' },
        96: { icon: '⛈️', desc: 'Thunderstorm with hail' },
        99: { icon: '⛈️', desc: 'Thunderstorm with heavy hail' }
    };

    /**
     * Format date for display
     */
    function formatDate(dateStr) {
        const date = new Date(dateStr);
        const options = { weekday: 'short', month: 'short', day: 'numeric' };
        return date.toLocaleDateString('en-US', options);
    }

    /**
     * Get day of week
     */
    function getDayOfWeek(dateStr) {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { weekday: 'short' });
    }

    /**
     * Fetch weather data from Open-Meteo API
     */
    async function fetchWeatherData() {
        // Open-Meteo API endpoint
        const url = new URL('https://api.open-meteo.com/v1/forecast');

        url.searchParams.set('latitude', LOCATION.lat);
        url.searchParams.set('longitude', LOCATION.lng);
        url.searchParams.set('daily', [
            'weather_code',
            'temperature_2m_max',
            'temperature_2m_min',
            'precipitation_probability_max',
            'precipitation_sum',
            'wind_speed_10m_max',
            'wind_gusts_10m_max'
        ].join(','));
        url.searchParams.set('timezone', 'Europe/Paris');
        url.searchParams.set('forecast_days', '16');

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Weather API error: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('Failed to fetch weather:', error);
            return null;
        }
    }

    /**
     * Get historical climate averages for the event dates
     * (Used when forecast is not yet available)
     */
    function getHistoricalAverages() {
        // Historical averages for Avignon late May/early June
        // Source: Climate data for Avignon
        return EVENT_DATES.days.map(day => ({
            date: day.date,
            label: day.label,
            isEventDay: day.isEventDay,
            isHistorical: true,
            tempMax: 26, // Average high for late May
            tempMin: 14, // Average low for late May
            precipProb: 25, // ~8 rainy days per month
            weatherCode: 1, // Mainly clear typical
            windSpeed: 15 // Mistral wind common
        }));
    }

    /**
     * Check if event dates are within forecast range
     */
    function isEventInForecastRange(weatherData) {
        if (!weatherData || !weatherData.daily || !weatherData.daily.time) {
            return false;
        }
        const forecastDates = weatherData.daily.time;
        return forecastDates.includes(EVENT_DATES.start);
    }

    /**
     * Extract event days from forecast data
     */
    function extractEventDays(weatherData) {
        const daily = weatherData.daily;
        const days = [];

        for (let i = 0; i < daily.time.length; i++) {
            const date = daily.time[i];
            const eventDay = EVENT_DATES.days.find(d => d.date === date);

            if (eventDay || isNearEventDates(date)) {
                days.push({
                    date: date,
                    label: eventDay ? eventDay.label : getDayOfWeek(date),
                    isEventDay: !!eventDay,
                    tempMax: Math.round(daily.temperature_2m_max[i]),
                    tempMin: Math.round(daily.temperature_2m_min[i]),
                    precipProb: daily.precipitation_probability_max[i],
                    precipSum: daily.precipitation_sum[i],
                    weatherCode: daily.weather_code[i],
                    windSpeed: Math.round(daily.wind_speed_10m_max[i]),
                    windGusts: Math.round(daily.wind_gusts_10m_max[i])
                });
            }
        }

        return days;
    }

    /**
     * Check if date is near event dates (for context)
     */
    function isNearEventDates(dateStr) {
        const date = new Date(dateStr);
        const eventStart = new Date(EVENT_DATES.start);
        const eventEnd = new Date(EVENT_DATES.end);

        // Show 2 days before and 2 days after
        const rangeStart = new Date(eventStart);
        rangeStart.setDate(rangeStart.getDate() - 2);
        const rangeEnd = new Date(eventEnd);
        rangeEnd.setDate(rangeEnd.getDate() + 2);

        return date >= rangeStart && date <= rangeEnd;
    }

    /**
     * Get weather icon and description
     */
    function getWeatherDisplay(code) {
        return WEATHER_ICONS[code] || { icon: '🌡️', desc: 'Unknown' };
    }

    /**
     * Render the weather widget
     */
    function renderWidget(container, days, isHistorical = false) {
        container.innerHTML = '';

        if (isHistorical) {
            const notice = document.createElement('div');
            notice.className = 'weather-notice';
            notice.innerHTML = `
                <p><strong>Historical Averages</strong></p>
                <p>Forecast not yet available for event dates. Showing typical conditions for late May in Avignon.</p>
            `;
            container.appendChild(notice);
        }

        for (const day of days) {
            const weather = getWeatherDisplay(day.weatherCode);

            const dayEl = document.createElement('div');
            dayEl.className = `weather-day${day.isEventDay ? ' event-day' : ''}`;
            dayEl.title = weather.desc;

            dayEl.innerHTML = `
                <div class="weather-date">${formatDate(day.date)}</div>
                <div class="weather-day-name">${day.label}</div>
                <div class="weather-icon">${weather.icon}</div>
                <div class="weather-temp">${day.tempMax}°</div>
                <div class="weather-temp-range">${day.tempMin}° / ${day.tempMax}°</div>
                ${day.precipProb > 0 ? `<div class="weather-precip">💧 ${day.precipProb}%</div>` : ''}
            `;

            container.appendChild(dayEl);
        }

        // Add Ventoux summit conditions for Day 3
        const day3 = days.find(d => d.date === '2026-05-31');
        if (day3) {
            const ventouxNote = document.createElement('div');
            ventouxNote.className = 'weather-ventoux-note';
            ventouxNote.innerHTML = `
                <p>🏔️ <strong>Mont Ventoux Summit</strong> (~1,900m): Expect temperatures 10-15°C cooler and potentially stronger winds.</p>
            `;
            container.appendChild(ventouxNote);
        }
    }

    /**
     * Initialize the weather widget
     */
    async function init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) {
            console.error(`Weather widget container '${containerId}' not found`);
            return;
        }

        // Show loading state
        container.innerHTML = '<div class="weather-loading">Loading weather data...</div>';

        try {
            const weatherData = await fetchWeatherData();

            if (weatherData && isEventInForecastRange(weatherData)) {
                // Real forecast available
                const days = extractEventDays(weatherData);
                renderWidget(container, days, false);
            } else {
                // Use historical averages
                const historicalDays = getHistoricalAverages();
                renderWidget(container, historicalDays, true);
            }
        } catch (error) {
            console.error('Weather widget error:', error);
            // Fallback to historical
            const historicalDays = getHistoricalAverages();
            renderWidget(container, historicalDays, true);
        }
    }

    // Public API
    return {
        init,
        fetchWeatherData,
        getHistoricalAverages,
        LOCATION,
        EVENT_DATES
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WeatherWidget;
}

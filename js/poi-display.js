/**
 * KOTR 2026 - POI display helpers
 *
 * FIT course_point names come pre-truncated to ~10 chars by Ride with GPS
 * for legacy Garmin display widths ("Feedzone 1", "Public toi",
 * "Caution ro"). This module rewrites them at display time into the
 * friendlier versions we actually want to show riders.
 *
 * Categories come from js/fit-parser.js / scripts/generate-inline-data.js
 * (COURSE_POINT_CATEGORY table). Navigation cues never arrive here —
 * those are filtered upstream.
 */
(function (root) {
    'use strict';

    const ICON = {
        food: '🍴',
        toilet: '🚻',
        water: '💧',
        danger: '⚠️',
        first_aid: '➕',
        aid_station: '🚑',
        rest_area: '🛋️',
        shower: '🚿',
        marker: '🏁',
    };

    const COLOR = {
        food: '#E8A94C',       // amber
        toilet: '#6A9483',     // teal
        water: '#4A90A4',      // ventoux blue
        danger: '#D9534F',     // red
        first_aid: '#D9534F',
        aid_station: '#D9534F',
        rest_area: '#8A7FB8',
        shower: '#6A9483',
        marker: '#7B3F00',     // terracotta
    };

    // Named overrides first, then category fallbacks. Match raw name prefixes
    // because Ride with GPS truncates mid-word.
    function polishPoiName(rawName, category) {
        if (!rawName) return defaultLabel(category);
        const s = String(rawName).trim();

        // Markers at route endpoints
        if (/^Start( of)?/i.test(s)) return 'Start';
        if (/^End( of)?/i.test(s)) return 'End';

        // Feed zones — "Feedzone", "Feedzone 1", "Feed zone "
        const fz = s.match(/^Feed\s?zone\s*(\d+)?/i);
        if (fz) return fz[1] ? `Feed Zone ${fz[1]}` : 'Feed Zone';

        // Toilets — "Public toi", "Public Toi", "Toilet"
        if (/^Public\s*[tT]oi/i.test(s)) return 'Public Toilets';
        if (/^Toilet/i.test(s)) return 'Toilets';

        // Danger cues — "Caution ro", "Dangerous "
        if (/^Caution\s*ro/i.test(s)) return 'Caution: Road';
        if (/^Caution/i.test(s)) return 'Caution';
        if (/^Dangerous/i.test(s)) return 'Hazard';

        // Fallback: trim trailing punctuation + return whatever we have.
        return s.replace(/[\s,.-]+$/, '') || defaultLabel(category);
    }

    function defaultLabel(category) {
        switch (category) {
            case 'food':        return 'Feed Stop';
            case 'toilet':      return 'Toilets';
            case 'water':       return 'Water';
            case 'danger':      return 'Caution';
            case 'first_aid':   return 'First Aid';
            case 'aid_station': return 'Aid Station';
            case 'rest_area':   return 'Rest Area';
            case 'shower':      return 'Shower';
            case 'marker':      return '';
            default:            return '';
        }
    }

    function getIcon(category) { return ICON[category] || '📍'; }
    function getColor(category) { return COLOR[category] || '#666'; }

    // Narrow to the POIs worth surfacing on small visualizations (skip the
    // generic start/end markers — riders already know where those are).
    function displayable(pois) {
        if (!pois) return [];
        return pois.filter(p => p && p.type !== 'marker');
    }

    const API = { polishPoiName, getIcon, getColor, displayable, ICON, COLOR };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = API;
    } else {
        root.KOTR_POI = API;
    }
})(typeof window !== 'undefined' ? window : globalThis);

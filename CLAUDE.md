# KOTR 2026

King of the Road — charity cycling event in Avignon, France. May 28 (arrival) through June 1, 2026. Supporting Medecins Sans Frontieres. Fundraising target: £500 / €550 / $600 per rider.

Deployed via GitHub Pages from `main` branch: https://ebowman.github.io/kotr26/

## Deployment checklist

```
./scripts/cache-bust.sh    # stamp ?v=<hash> on all local asset URLs
git add -u
git commit ...
git push
```

Always cache-bust before pushing. GitHub Pages caches aggressively and users will see stale JS/CSS without this.

## Pages

| Page | Path | Libs | Description |
|------|------|------|-------------|
| Landing | `index.html` | Mapbox GL, Turf.js | Hero, route cards, 3D overview map, weather widget, rider profile |
| Flyover | `flyover.html` | Mapbox GL, Turf.js | 3D animated camera flyover of routes (~7k lines in flyover-engine.js) |
| Compare | `compare/index.html` | D3 v7 | Side-by-side route comparison grid with Mapbox static maps |
| Skyline | `skyline/index.html` | D3 v7 | Elevation profile strip charts, all days on shared y-axis |
| Pace | `pace/index.html` | D3 v7 | Time-in-saddle physics simulator (easy/steady/hard effort) |
| Radial | `radial/index.html` | D3 v7 | Radial wheel visualization of routes with POI markers |

Each sub-page (compare, skyline, pace, radial) loads a `data-inline.js` containing pre-computed `ROUTE_DATA` and `POI_DATA`. These are generated — don't hand-edit them.

## Data pipeline

```
.fit/.gpx files in routes/
    ↓  node scripts/download-dem.js
.dem.json sidecar files (Mapbox terrain elevation per GPS point)
    ↓  node scripts/generate-inline-data.js
├── routes/elevation-profiles.json    (landing page mini-profiles)
├── compare/data-inline.js + gps-inline.js
├── skyline/data-inline.js
├── pace/data-inline.js
└── radial/data-inline.js
```

When routes change: copy new files to `routes/`, run `download-dem.js`, then `generate-inline-data.js`, then update ROUTES config in `js/main.js`.

`routes/updated/` holds the source files as received — copy to `routes/` for use.

## Route structure

ROUTES config in `js/main.js` (lines ~20-118) is the single source of truth. Day 1 has one route; Days 2-4 have standard + long variants. Standard routes are `.fit`, long routes are `.gpx`.

Stats (distance, elevation, difficulty) are set in the ROUTES config. The `routeFile` property points to the file in `routes/`. The inline data files echo these stats for the visualization pages.

## localStorage keys

- `kotr-rider-profile` — weight (kg) and FTP (watts). Set on landing page, read by pace page.
- `kotr-route-selections` — user's chosen standard/long variants per day.
- `kotr-profile-prompt-dismissed` — hides the rider profile setup prompt.
- `kotr-flyover-pitch` / `kotr-flyover-zoom` — flyover camera preferences.

## External dependencies

- **Mapbox GL JS v2.15.0** — 3D terrain, satellite tiles, FreeCamera API. Token hardcoded in `js/main.js`, `js/flyover-engine.js`, `scripts/download-dem.js`.
- **Turf.js v6.5.0** — geospatial distance/bearing calculations for flyover.
- **D3.js v7** — all chart visualizations (skyline, pace, radial, compare).
- **Open-Meteo API** — free weather forecast, no API key needed. Used by `js/weather-widget.js`.

## Key files

- `js/main.js` — ROUTES config, countdown, route card rendering, download logic
- `js/flyover-engine.js` — 3D flyover engine (FreeCamera, chase cam, cinematic modes)
- `js/fit-parser.js` / `js/gpx-parser.js` — browser-side route file parsers
- `js/elevation-profile.js` — canvas-based interactive elevation renderer (used by flyover)
- `js/weather-widget.js` — Open-Meteo 5-day forecast for Avignon
- `js/rider-profile.js` — weight/FTP modal, localStorage persistence
- `js/power-calculator.js` — physics model for power/speed/time estimation
- `css/main.css` — design system (Provence palette: terracotta, lavender gold, Ventoux blue)
- `css/mobile.css` — responsive breakpoints at 480px, 768px, 1024px
- `radial/poi-data.json` — Points of Interest (towns) for each route, keyed by day/variant
- `scripts/download-dem.js` — fetches Mapbox DEM elevations (requires pngjs: `npm install`)
- `scripts/generate-inline-data.js` — generates all data-inline.js and gps-inline.js files
- `scripts/cache-bust.sh` — stamps git hash on asset URLs

## npm

Only dependency is `pngjs` (for DEM tile PNG decoding in download-dem.js). No build system, no bundler, no test suite. All pages are static HTML.

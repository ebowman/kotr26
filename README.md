# KOTR 2026 — King of the Road Avignon

A static web app for the KOTR 2026 charity cycling event in Avignon, France,
supporting Médecins Sans Frontières (MSF).

Live: https://ebowman.github.io/kotr26/

## Event Details

- **Dates:** May 28 – June 1, 2026 (arrival Thursday, departure Monday)
- **Location:** Avignon, France
- **Charity:** Médecins Sans Frontières (Doctors Without Borders)
- **Fundraising target:** £500 / €550 / $600 per rider

## Route Schedule

| Day | Date | Variant | Distance | Elevation | Route |
|-----|------|---------|----------|-----------|-------|
| 1 (warm-up) | Thu May 28 | — | 48 km | 150 m | Shake Out the Travel Legs |
| 2 | Fri May 29 | Short | 82 km | 428 m | NW Provence |
| 2 | Fri May 29 | Long | 105 km | 703 m | NW Provence |
| 3 | Sat May 30 | Short | 81 km | 369 m | Mazan Loop |
| 3 | Sat May 30 | Long | 140 km | 2,189 m | **Mont Ventoux** (summit 1,897 m) |
| 4 | Sun May 31 | Short | 78 km | 400 m | Luberon Loop |
| 4 | Sun May 31 | Long | 92 km | 713 m | Luberon Loop |

Authoritative stats live in `ROUTES` in `js/main.js`. Elevation values use the
Mapbox DEM (industry-standard algorithm matching Strava).

## Pages

| Page | Path | What it does |
|------|------|--------------|
| Landing | `index.html` | Hero, countdown, route cards, 3D overview map, weather widget, rider profile |
| Flyover | `flyover.html` | 3D animated camera flyover of each route |
| Compare | `compare/index.html` | Side-by-side route comparison grid with static maps |
| Skyline | `skyline/index.html` | Elevation profile strip charts, all days on shared y-axis |
| Pace | `pace/index.html` | Time-in-saddle physics simulator (easy/steady/hard effort) |
| Radial | `radial/index.html` | Radial wheel visualization of routes with POI markers |

## Tech Stack

- **Mapbox GL JS v2.15.0** — 3D terrain, satellite tiles, FreeCamera API
- **Turf.js v6.5.0** — geospatial distance/bearing calculations
- **D3.js v7** — chart visualizations (skyline, pace, radial, compare)
- **Open-Meteo API** — 5-day weather forecast, no API key required
- **Vanilla JavaScript ES6+** — no bundler, no build step, pure static HTML

The only npm dependency is `pngjs`, used by `scripts/download-dem.js` to decode
Mapbox DEM tile PNGs.

## Data Pipeline

```
routes/*.fit
   ↓  node scripts/download-dem.js
routes/*.dem.json                       (Mapbox DEM elevation per GPS point)
   ↓  node scripts/generate-inline-data.js
├── routes/elevation-profiles.json      (landing-page mini-profiles)
├── routes/viz-data.js                  (shared route data for sub-pages)
└── compare/gps-inline.js               (per-point GPS for compare page)
```

When routes change: drop the new `.fit` files in `routes/`, update the `ROUTES`
config in `js/main.js`, run `node scripts/download-dem.js`, then
`node scripts/generate-inline-data.js`.

## Project Structure

```
kotr26/
├── index.html                  # Landing page
├── flyover.html                # 3D flyover
├── compare/, skyline/,         # Visualization sub-pages
│   pace/, radial/
├── js/
│   ├── main.js                 # ROUTES config, countdown, route cards, profile
│   ├── flyover-engine.js       # FreeCamera 3D flyover engine
│   ├── fit-parser.js           # Browser-side FIT parser
│   ├── gpx-parser.js           # Browser-side GPX parser
│   ├── elevation-profile.js    # Canvas-based elevation renderer
│   ├── weather-widget.js       # Open-Meteo forecast widget
│   ├── rider-profile.js        # Weight + FTP modal, localStorage
│   └── power-calculator.js     # Physics model for power/speed/time
├── css/
│   ├── main.css                # Design system (Provence palette)
│   └── mobile.css              # Responsive breakpoints
├── routes/                     # .fit, .dem.json, elevation-profiles.json, viz-data.js
├── radial/poi-data.json        # Points of Interest per route
└── scripts/
    ├── download-dem.js         # Fetches Mapbox DEM elevations
    ├── generate-inline-data.js # Regenerates all inline data files
    └── cache-bust.sh           # Stamps git hash on local asset URLs
```

## Setup

1. Clone the repository.
2. Mapbox tokens are hardcoded in `js/main.js`, `js/flyover-engine.js`, and
   `scripts/download-dem.js`. Replace if you fork.
3. Serve as static files (any HTTP server, or push to GitHub Pages).
4. (Optional, only if regenerating route data) `npm install` to get `pngjs`.

## Deployment

GitHub Pages, served from `main`. Before pushing:

```bash
./scripts/cache-bust.sh    # stamps ?v=<git hash> on all local asset URLs
git add -u && git commit -m "..." && git push
```

GitHub Pages caches aggressively — always cache-bust before pushing or users
will see stale JS/CSS.

## localStorage Keys

- `kotr-rider-profile` — rider weight (kg) and FTP (watts); set on landing, read by pace page
- `kotr-route-selections` — chosen standard/long variant per day
- `kotr-profile-prompt-dismissed` — suppresses the rider-profile setup prompt
- `kotr-flyover-pitch` / `kotr-flyover-zoom` — flyover camera preferences

## Flyover Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| ← / → | Seek backward / forward |
| ↑ / ↓ | Adjust chase-cam pitch |
| 1 / 2 / 3 / 4 | Speed: 0.5x / 1x / 2x / 4x |
| C / B / S / V | Camera mode: Chase / Bird's-eye / Side / Cinematic |
| X | Cycle side-view direction (auto/left/right) |
| J / K | Zoom out / in |
| 0 | Reset zoom |
| F | Toggle fullscreen |
| ? | Show / hide shortcuts panel |

## Credits

- Route planning and FIT files: KOTR Team
- [Mapbox FreeCamera documentation](https://docs.mapbox.com/mapbox-gl-js/example/free-camera-path/)
- [Open-Meteo weather API](https://open-meteo.com/)
- Supporting [Médecins Sans Frontières](https://www.msf.org/)

## License

MIT — feel free to use for other charity cycling events.

# KOTR 2026 - King of the Road Avignon

A web application for the KOTR 2026 charity cycling event in Avignon, France, supporting Médecins Sans Frontières (MSF).

## Event Details

- **Dates:** May 28 - June 1, 2026
- **Location:** Avignon, France
- **Charity:** MSF (Doctors Without Borders)
- **Fundraising Target:** £500/€550/$600 per rider

## Features

- **Interactive Route Preview** - View all cycling routes on a 3D terrain map
- **3D Flyover** - Smooth camera flyover of each route using Mapbox FreeCamera API
- **Elevation Profile** - Interactive elevation visualization with gradient coloring
- **Weather Forecast** - Weather predictions for event dates using Open-Meteo API
- **GPX Downloads** - Download routes for bike computers
- **Mobile Responsive** - Works on phones and tablets

## Route Schedule

| Day | Date | Distance | Elevation | Route |
|-----|------|----------|-----------|-------|
| 1 | May 29 | 80 km | 800 m | Avignon Exploration |
| 2 | May 30 | 95 km | 600 m | Wine Country (North) |
| 3 | May 31 | 95 km | 1,000 m | Luberon Villages |
| 3 (Long) | May 31 | ~140 km | ~2,500 m | **Mont Ventoux!** |
| 4 | Jun 1 | TBD | TBD | Final Celebration |

## Tech Stack

- **Mapbox GL JS v2.15.0** - 3D terrain mapping and FreeCamera API
- **Turf.js v6.5.0** - Geospatial calculations
- **Open-Meteo API** - Weather forecasts (free, no API key required)
- **Vanilla JavaScript ES6+** - No build tools, static HTML

## Project Structure

```
kotr26/
├── index.html              # Main landing page
├── flyover.html            # 3D route flyover
├── routes/                 # FIT route files
│   ├── KOTR_Avignon_D1.fit
│   ├── KOTR_Avignon_Standard_D2.fit
│   ├── KOTR_Avignon_Long_D2.fit
│   ├── KOTR_Avignon_D3_Standard.fit
│   ├── KOTR_Ventoux_D3_Long.fit
│   ├── KOTR_Avignon_D4_Standard.fit
│   └── KOTR_Avignon_D4_Long.fit
├── js/
│   ├── fit-parser.js       # FIT file parsing
│   ├── flyover-engine.js   # FreeCamera flyover
│   ├── elevation-profile.js# Elevation visualization
│   ├── weather-widget.js   # Weather forecasts
│   └── main.js             # Landing page logic
└── css/
    ├── main.css            # Main styles
    └── mobile.css          # Responsive styles
```

## Setup

1. Clone the repository
2. Replace the Mapbox access token in `js/main.js` and `js/flyover-engine.js`:
   ```javascript
   const MAPBOX_TOKEN = 'your-mapbox-token-here';
   ```
3. Serve with any static file server (or GitHub Pages)

## Flyover Engine

The flyover engine uses several techniques to provide smooth camera movement:

- **FreeCamera API** - Direct camera control instead of flyTo() transitions
- **Dual-path pattern** - Camera path offset from focal point path
- **LERP smoothing** - Linear interpolation prevents sudden movements
- **Fixed timestep** - Consistent animation regardless of frame rate

Key configuration in `flyover-engine.js`:
```javascript
const CONFIG = {
    cameraAltitude: 300,    // Base altitude above terrain
    cameraOffset: 100,       // Offset behind current position
    lookAheadDistance: 400,  // How far ahead camera looks
    cameraLerp: 0.04,        // Camera smoothing (lower = smoother)
    lookAtLerp: 0.06,        // Look-at smoothing
};
```

## Keyboard Controls (Flyover)

- **Space** - Play/Pause
- **Left Arrow** - Rewind
- **Right Arrow** - Forward
- **1/2/3/4** - Speed (0.5x/1x/2x/4x)

## Deployment

The site is designed for GitHub Pages deployment:

```bash
git push origin main
```

Then enable GitHub Pages in repository settings.

## Credits

- Route planning and FIT files: KOTR Team
- [Mapbox FreeCamera documentation](https://docs.mapbox.com/mapbox-gl-js/example/free-camera-path/)
- [Open-Meteo weather API](https://open-meteo.com/)
- Supporting [Médecins Sans Frontières](https://www.msf.org/)

## License

MIT License - Feel free to use for other charity cycling events!

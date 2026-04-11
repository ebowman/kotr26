# KOTR 2026

Charity cycling event site — Avignon, France, May 28 - June 1 2026. Deployed via GitHub Pages from `main` branch.

## Deployment

Before pushing to `main`, run cache-busting to avoid stale browser caches on GitHub Pages:

```
./scripts/cache-bust.sh
git add -u
git commit ...
git push
```

This stamps `?v=<git-hash>` on all local CSS/JS references in HTML files. Always do this as the last step before push.

## Route files

- **Standard routes** (Days 2-4): `.fit` files in `routes/`
- **Long routes** (Days 1-4): `.gpx` files in `routes/`
- Each route has a `.dem.json` sidecar with Mapbox DEM elevation data

To regenerate DEM data: `node scripts/download-dem.js [--force]`
To regenerate inline data files: `node scripts/generate-inline-data.js`

## Key files

- `js/main.js` — ROUTES config (single source of truth for route stats)
- `js/fit-parser.js` — browser-side FIT parser
- `js/gpx-parser.js` — browser-side GPX parser
- `scripts/download-dem.js` — fetches Mapbox DEM elevations for route files
- `scripts/generate-inline-data.js` — generates all `data-inline.js` and `gps-inline.js` files
- `scripts/cache-bust.sh` — stamps git hash on asset URLs for cache busting

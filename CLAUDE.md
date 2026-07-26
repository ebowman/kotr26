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


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

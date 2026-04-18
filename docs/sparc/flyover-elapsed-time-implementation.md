# SPARC Plan: Flyover Elapsed-Time Readout

## Specification

See `docs/prd/flyover-elapsed-time.md`. P0 = all items in Success Criteria.

## Pseudocode

```js
// power-calculator.js — new exports

function selectAllDayIF(estimatedHours) {
  if (estimatedHours < 2)  return 0.80;
  if (estimatedHours < 3)  return 0.75;
  if (estimatedHours < 4)  return 0.70;
  if (estimatedHours < 5)  return 0.65;
  if (estimatedHours < 7)  return 0.60;
  return 0.55;
}

function buildElapsedTimeSeries(routeData, weight, ftp, paceMode) {
  const seedMetrics = calculateRouteMetrics(routeData, weight, ftp);
  const steadyHours = seedMetrics.timeEstimates.find(t=>t.label==='Steady').seconds/3600;
  const IF = paceMode === 'hard'   ? 0.90
           : paceMode === 'steady' ? 0.75
           : selectAllDayIF(steadyHours);
  const power = ftp * IF;
  const coords = routeData.coordinates;
  const elapsed = new Float32Array(coords.length);
  let t = 0;
  for (let i = 1; i < coords.length; i++) {
    const dist = haversineDistance(...) * 1000;   // meters
    const grade = dist > 0 ? ((coords[i][2]||0) - (coords[i-1][2]||0)) / dist : 0;
    const speed = calculateSpeedForPower(grade, power, weight);  // m/s
    t += dist / speed;
    elapsed[i] = t;
  }
  return { elapsed, totalSeconds: t, IF, paceMode };
}

// flyover-engine.js — in updateProgress()
// Map distance → index → elapsed seconds (linear interp between indices)
function elapsedAtProgress(p) {
  const targetDist = p * totalDistance * 1000;    // meters
  // binary search in cumulative distance array (built once)
  const i = bisect(cumDistMeters, targetDist);
  const ratio = (targetDist - cumDistMeters[i-1]) / (cumDistMeters[i] - cumDistMeters[i-1]);
  return lerp(elapsed[i-1], elapsed[i], ratio);
}
```

## Architecture

### Files touched

| File | Change |
|------|--------|
| `js/power-calculator.js` | Add `selectAllDayIF`, `buildElapsedTimeSeries`; export both. |
| `js/flyover-engine.js` | Build time-series after `routeData` loads; update HUD in `updateProgress`; rebuild on pace/profile change. |
| `flyover.html` | New `.stat-group.time` block; new `.pace-toggle` controls; script order unchanged. |
| `css/flyover.css` (or inline style block in flyover.html) | Styles for time stat + pace toggle + nudge pill. |
| `js/rider-profile.js` | Emit `kotr:profile-changed` event on save (if not already). |

### Data flow

```
route load → buildElapsedTimeSeries(route, profile, paceMode)
           → cached on routeData._elapsed
playback → updateProgress() → read elapsed[i] → format → HUD
profile change → event → rebuild series → update HUD
pace toggle click → set paceMode → rebuild series → update HUD
```

### localStorage

- New key: `kotr-flyover-pace` — 'allday' | 'steady' | 'hard'. Default 'allday'.
- Reuse: `kotr-rider-profile` (existing).

## Refinement

### Edge cases

- Coords <2 → bail, hide time stat.
- Coord without altitude (NaN) → treat as previous altitude.
- Negative speed (shouldn't happen — `calculateSpeedForPower` clamps to 0.5 m/s) — belt-and-braces clamp anyway.
- Pace toggle click while scrubbing → recompute series synchronously, redisplay on next `updateProgress`.
- Ventoux long (~4k coords): timing → should stay under 10ms. If not, batch-skip every 2-3 points.

### Testing

No test harness in this repo. Manual checks:

1. Load Day 1 (easy warmup) — "All Day" should pick IF ~0.80, total ~1h 50m at default profile.
2. Load Ventoux long — "All Day" picks IF 0.55-0.60, total 6-7h at default profile.
3. Toggle Hard on Ventoux — total should drop by ~25-35%.
4. Set profile to 60 kg / 300 W — Ventoux times should drop substantially.
5. Scrub to 50% progress → time roughly ~50% of total (less on climbs, more past them).
6. Clear localStorage → personalize nudge appears.
7. Fill in custom weight/FTP → nudge replaced by stats.

### Configuration

None beyond the existing MAPBOX_TOKEN in `js/config.js`.

## Completion

### Definition of done

- All Success Criteria in the PRD pass manual verification.
- No console errors in Chrome DevTools during a full flyover of Ventoux long.
- Cache-bust script run, committed, pushed.

### Task breakdown → beads

1. **eta-model** — `power-calculator.js`: add `selectAllDayIF`, `buildElapsedTimeSeries`, export.
2. **eta-profile-event** — `rider-profile.js`: emit `kotr:profile-changed` on save.
3. **eta-hud-markup** — `flyover.html`: add time stat group + pace toggle markup + CSS.
4. **eta-hud-wire** — `flyover-engine.js`: wire build/update/rebuild on profile/pace change.
5. **eta-nudge** — Personalization nudge logic in engine + styles.
6. **eta-verify** — Manual verification pass, cache-bust, commit, push.

Dependencies: 3 depends on 1. 4 depends on 1, 2, 3. 5 depends on 4. 6 depends on 5.

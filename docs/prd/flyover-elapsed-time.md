# PRD: Flyover Elapsed-Time Readout

## Problem

During the flyover ride simulation, riders see cumulative distance, current grade, and cumulative elevation, but no sense of *how long they will actually be on the bike*. The existing `/pace` page shows Easy/Steady/Hard totals, but those are detached from the felt experience of watching the route unfold. Riders watching the Ventoux day flyover see "2,189 m of climbing" without the visceral punchline of "and it will take you 6h 48m."

## Goal

Show elapsed ride time ticking alongside elapsed distance on the flyover HUD, personalized to the user's weight and FTP, with a lightweight pace selector so the rider can see how effort level changes the total.

## Users & Context

- KOTR 2026 riders with varying fitness (FTP 150-350W range).
- Default profile (75 kg / 200 W) is set on first visit via `rider-profile.js`.
- Flyover is a marquee visualization; users already spend ~5-10 minutes watching route previews there.

## Non-Goals

- Fatigue modelling (power decay over time).
- Variable pacing strategies (hold back on climbs, push on descents).
- Heart-rate or HRV-based estimation.
- Personalized estimates on route cards, compare, skyline, radial pages. (May follow; out of scope here.)

## Solution

### 1. Pacing model

Constant target power for the full ride — the approach used by Best Bike Split, Komoot, and bikecalculator.com. Target is expressed as a fraction of FTP (Intensity Factor, IF).

Pace presets:

| Preset  | IF        | Use                                   |
|---------|-----------|---------------------------------------|
| All Day | duration-aware (see below) | Default. Realistic sustainable effort for the ride length. |
| Steady  | 0.75      | Solid endurance effort.               |
| Hard    | 0.90      | Near-threshold, race-pace.            |

**Duration-aware "All Day" IF** — seeded from a Steady-pace duration estimate, then mapped to a realistic IF for that length:

| Est. duration | Target IF |
|---------------|-----------|
| < 2 h         | 0.80      |
| 2-3 h         | 0.75      |
| 3-4 h         | 0.70      |
| 4-5 h         | 0.65      |
| 5-7 h         | 0.60      |
| 7+ h          | 0.55      |

Compute once per route: seed duration via existing `calculateRouteMetrics()` at IF 0.75, look up the bracket, then recompute at the selected IF. One pass is accurate enough — these brackets are already coarse relative to rider variability.

### 2. Per-point elapsed-time series

Precompute a cumulative time array aligned with `routeData.coordinates`. For each segment between consecutive points, use `PowerCalculator.calculateSpeedForPower(grade, targetPower, weight)` (which already handles the steep-descent terminal-velocity branch) to get speed, then `time = dist / speed`. Cumulative sum gives `elapsedAtIndex[i]`.

During flyover animation, `updateProgress()` interpolates into this array at the current distance to read elapsed time. Recomputed whenever pace or rider profile changes.

### 3. HUD changes

Add a fourth stat group to `.progress-stats` in `flyover.html`:

```
⏱  2h 14m          ← primary, H\M format
All Day · 65% FTP  ← secondary, shows preset + IF
```

A compact three-button pace toggle (`All Day / Steady / Hard`) sits above or beside the stats. Selection persists per session via `localStorage`.

### 4. Personalization nudge

- If `kotr-rider-profile` is at defaults (75 kg AND 200 W), show a subtle "Personalize" pill in the secondary line: `All Day · 65% FTP · Personalize →`. Click opens the rider-profile modal.
- If personalized: show `All Day · 65% FTP · 78kg / 220W`.
- Profile changes re-emit an event the flyover listens for to recompute.

### 5. Fallback & edge cases

- Empty/broken routeData → hide the time stat group silently (do not show "--").
- Coordinates without elevation → treat as flat (grade = 0), still produces a plausible time.
- User toggles pace mid-ride → recompute and redisplay from current progress, no animation glitch.
- Elapsed time on the landing page or elsewhere is unchanged; hardcoded `duration: '~3-4 hours'` stays.

## Success Criteria

1. Flyover HUD shows personalized elapsed time that updates smoothly as the camera flies.
2. Pace toggle changes the displayed total and per-point times without stutter.
3. When profile is default, nudge is visible; when customized, it shows the user's stats.
4. Precomputed time series is correct within ±30s of `calculateRouteMetrics()` total for the same IF.
5. No regression on existing HUD (distance, grade, elevation).
6. Works on all routes (Day 1 warmup through Ventoux long).

## Risks & Tradeoffs

- **IF bracket boundaries** are a judgment call. A rider whose Steady estimate lands at 4h 01m gets IF 0.65 but at 3h 59m gets 0.70 — could produce a ~5% time jump at the boundary. Acceptable for a preview tool; add a note if we ever care enough to smooth it.
- **Constant power on descents** underestimates time because real riders coast. Mitigated by the existing terminal-velocity branch in `calculateSpeedForPower` which already handles low-power descents correctly.
- **Increases flyover init time** by ~one pass over coordinates per pace change. Ventoux long has ~4k points; should be sub-10ms.
- **HUD real estate** — flyover HUD is already dense. If the fourth stat group makes mobile cramped, demote it to secondary position or stack.

## Consensus

All expert perspectives reconciled:
- **PM**: Scoped to flyover only. PRD captures falsifiable acceptance.
- **Design**: Single time number in HUD + pace toggle in-widget. Nudge is discreet, not intrusive.
- **UX**: Defaults behave. Customization is discoverable but not required.
- **Engineering**: Reuses existing physics engine and profile module. No new dependencies.
- **Domain (cycling)**: Constant IF mapped to duration is the genre standard; fatigue modelling is not worth the complexity for a preview tool.

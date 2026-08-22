# SPARC Plan: Unified Camera Smoothing Architecture

## S - Specification

### Problem Statement
The camera system has 7+ competing smoothing mechanisms that fight each other during disruptions (seeks, terrain loads, mode changes), causing jitter. State is fragmented across multiple objects with no single source of truth.

### Goals
1. Eliminate camera jitter during seeks (arrow keys)
2. Handle terrain tile loading gracefully
3. Smooth mode transitions
4. Maintain 60fps performance
5. General-purpose solution (not overfitted to specific terrain)

### Success Criteria
- No visible jitter when pressing arrow keys to seek
- Smooth camera motion when terrain tiles load asynchronously
- Clean transitions between camera modes
- Frame-to-frame deltas stay within acceptable limits (bearing <5°, altitude <20m, position <30m)

---

## P - Pseudocode/Plan

### Core Concept: Single Source of Truth

```
┌─────────────────────────────────────────────────────────────┐
│                    UnifiedCameraController                   │
├─────────────────────────────────────────────────────────────┤
│  Input: riderPosition, terrainElevation, mode, deltaTime    │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  1. Calculate Ideal Target (mode-specific geometry)  │   │
│  │     - No smoothing, pure math                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  2. Apply Terrain Constraint to TARGET               │   │
│  │     - OutlierRejectingFilter on terrain input        │   │
│  │     - Ensure target.alt > terrain + clearance        │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  3. Single Spring Update                             │   │
│  │     - CriticallyDampedSpring for position            │   │
│  │     - CriticallyDampedSpring for orientation         │   │
│  │     - No post-processing!                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  Output: smoothedPosition, smoothedOrientation              │
└─────────────────────────────────────────────────────────────┘

Event Handlers:
- onSeek(distance): if large, teleport spring; else let it catch up
- onModeChange(): start blend animation or let spring handle
- onTerrainLoad(): outlier filter absorbs sudden changes
```

### Pseudocode for Key Operations

```javascript
// SEEK HANDLING
function handleSeek(newProgress, oldProgress) {
    const seekDistanceKm = Math.abs(newProgress - oldProgress) * totalDistance;
    const seekDistanceM = seekDistanceKm * 1000;

    if (seekDistanceM > TELEPORT_THRESHOLD) { // e.g., 500m
        // Large seek: teleport camera, zero velocity
        const newRiderPos = getPointAlongRoute(newProgress * totalDistance);
        const newTarget = calculateIdealTarget(newRiderPos, currentMode);

        positionSpring.teleportTo(newTarget);
        orientationSpring.teleportTo(calculateOrientation(newRiderPos));
        terrainFilter.reset(); // Start fresh
    }
    // Small seek: spring naturally catches up
}

// TERRAIN HANDLING
function filterTerrainElevation(rawElevation) {
    if (rawElevation === null) {
        return terrainFilter.lastValue; // Hold previous
    }

    const delta = Math.abs(rawElevation - terrainFilter.lastValue);
    if (delta > OUTLIER_THRESHOLD) { // e.g., 50m
        // Outlier: adapt slowly
        return terrainFilter.updateWithReducedAlpha(rawElevation, 0.05);
    }
    // Normal: adapt normally
    return terrainFilter.update(rawElevation, 0.2);
}

// MAIN UPDATE LOOP
function updateCamera(deltaTime) {
    // 1. Get rider position (no smoothing - turf.along is already smooth)
    const riderPos = getPointAlongRoute(progress * totalDistance);

    // 2. Calculate ideal camera target (pure geometry)
    const idealTarget = calculateIdealTarget(riderPos, currentMode);

    // 3. Filter terrain and apply constraint
    const terrainAtCamera = queryTerrainElevation(idealTarget.lng, idealTarget.lat);
    const filteredTerrain = filterTerrainElevation(terrainAtCamera);
    idealTarget.alt = Math.max(idealTarget.alt, filteredTerrain + CLEARANCE);

    // 4. Spring update (THE ONLY SMOOTHING)
    const smoothedPos = positionSpring.update(idealTarget, deltaTime);
    const smoothedOrient = orientationSpring.update(idealOrientation, deltaTime);

    // 5. Apply to camera (no post-processing!)
    applyToFreeCamera(smoothedPos, smoothedOrient);
}
```

---

## A - Architecture

### New Classes

#### 1. UnifiedCameraController
```javascript
class UnifiedCameraController {
    constructor() {
        this.positionSpring = new CriticallyDampedSpring3D(omega: 2.0);
        this.orientationSpring = new OrientationSpring(omega: 3.0);
        this.terrainFilter = new OutlierRejectingEMA(alpha: 0.2, threshold: 50);
        this.mode = 'chase';
        this.blendState = null;
    }

    update(riderPos, terrainElevation, deltaTime) → CameraState
    teleport(newRiderPos) → void
    setMode(newMode) → void
    reset() → void
}
```

#### 2. CriticallyDampedSpring3D (extend existing)
```javascript
class CriticallyDampedSpring3D extends CriticallyDampedSpring {
    // Adds teleportTo() method
    // Adds maxVelocity constraint
    // Handles {lng, lat, alt} as unit
}
```

#### 3. OutlierRejectingEMA
```javascript
class OutlierRejectingEMA {
    constructor(alpha, outlierThreshold)
    update(value) → filteredValue
    reset() → void
}
```

### Files to Modify

| File | Changes |
|------|---------|
| `flyover-engine.js` | Create UnifiedCameraController, refactor updateCamera() |
| `flyover-engine.js` | Remove: `_terrainCache` smoothing logic |
| `flyover-engine.js` | Remove: `_riderSmoothState`, `_cameraSmoothState` |
| `flyover-engine.js` | Remove: Emergency smoothing in `applyCameraState()` |
| `flyover-engine.js` | Modify: `seekToPosition()` to call controller.teleport() |
| `flyover-engine.js` | Keep: Mode-specific geometry calculations (just remove smoothing) |

### State Consolidation

**Before (fragmented):**
- `window._terrainCache` (8 fields)
- `window._riderSmoothState`
- `window._cameraSmoothState`
- `_lastAppliedState`
- `predictiveCameraController` (2 springs + state)
- `window._sideViewBearingState`
- `window._cinematicState`

**After (unified):**
- `unifiedCameraController` (contains all state)
  - `.positionSpring` (position + velocity)
  - `.orientationSpring` (bearing/pitch + velocity)
  - `.terrainFilter` (filtered terrain + last value)
  - `.mode` (current mode)
  - `.blendState` (if transitioning)

---

## R - Refinement

### Phase 1: Create New Infrastructure (Low Risk)
1. Create `OutlierRejectingEMA` class
2. Extend `CriticallyDampedSpring` with `teleportTo()` and `CriticallyDampedSpring3D`
3. Create `UnifiedCameraController` shell with event methods
4. Add unit tests for new classes

### Phase 2: Wire Up Controller (Medium Risk)
1. Instantiate `UnifiedCameraController` in init
2. In `updateCamera()`, call controller alongside existing logic
3. Log both outputs, compare for discrepancies
4. Verify controller produces similar results

### Phase 3: Cut Over (Higher Risk)
1. In `updateCamera()`, switch to controller output
2. Remove legacy smoothing from `calculateCameraForMode()`
3. Remove emergency smoothing from `applyCameraState()`
4. Remove `_terrainCache` smoothing logic
5. Update `seekToPosition()` to call `controller.teleport()`

### Phase 4: Cleanup
1. Remove dead code: `_riderSmoothState`, `_cameraSmoothState`, old smoothing functions
2. Update debug API to use controller state
3. Update chaos diagnostics to use controller

### Tuning Parameters

| Parameter | Initial Value | Tuning Notes |
|-----------|---------------|--------------|
| Position spring omega | 2.0 | Higher = faster response, more jitter |
| Orientation spring omega | 3.0 | Orientation should be snappier |
| Terrain outlier threshold | 50m | Reject changes > 50m/frame |
| Terrain filter alpha | 0.2 | Lower = smoother, more lag |
| Teleport threshold | 500m | Seeks larger than this teleport |
| Position spring maxVelocity | 50 m/s | Prevents overshoot |

---

## C - Completion Checklist

### Implementation
- [ ] Create `OutlierRejectingEMA` class
- [ ] Create `CriticallyDampedSpring3D` class with teleportTo()
- [ ] Create `UnifiedCameraController` class
- [ ] Wire controller into `updateCamera()`
- [ ] Add teleport call in `seekToPosition()`
- [ ] Remove smoothing from `calculateCameraForMode()`
- [ ] Remove emergency smoothing from `applyCameraState()`
- [ ] Remove legacy smoothing state variables
- [ ] Update mode change handling

### Testing
- [ ] Test normal playback (all 4 modes)
- [ ] Test arrow key seeks (small and large)
- [ ] Test scrubber drags
- [ ] Test mode transitions
- [ ] Test on Ventoux km 51-52 at max zoom
- [ ] Test terrain tile loading (clear cache, reload)
- [ ] Verify smoothness metrics

### Validation
- [ ] No console warnings/errors
- [ ] Frame-to-frame deltas within limits
- [ ] No visible jitter on seeks
- [ ] Smooth terrain adaptation
- [ ] Performance maintained (60fps)

---

## Risk Mitigation

1. **Keep existing code intact initially** - Add controller alongside, compare outputs
2. **Feature flag** - Add `USE_UNIFIED_CAMERA` flag to toggle between old/new
3. **Incremental cutover** - One mode at a time if needed
4. **Revert path** - Git branch, easy to revert if issues

## Timeline Estimate

- Phase 1 (Infrastructure): 2-3 hours
- Phase 2 (Wire Up): 1-2 hours
- Phase 3 (Cut Over): 2-3 hours
- Phase 4 (Cleanup): 1-2 hours
- Testing & Tuning: 2-3 hours

**Total: 8-13 hours**

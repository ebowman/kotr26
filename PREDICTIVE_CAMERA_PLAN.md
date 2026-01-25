# SPARC Plan: Predictive Camera System

## Situation

### Current State
The camera system in `flyover-engine.js` uses a **reactive approach**:
- Camera position calculated from current rider position with mode-specific offsets
- 50m look-ahead used only for bearing calculation (very short)
- Multiple smoothing layers applied post-hoc to eliminate jitter:
  - Rider position smoothing (α = 0.008 to 0.03)
  - Position rate limiting (2-5m/frame)
  - Altitude smoothing (3-8m/frame)
  - Bearing smoothing (0.08-0.15°/frame)
  - Emergency smoothing as safety net

### Problem
Despite 6+ layers of smoothing, the camera still reacts to local path variations because the **fundamental approach is reactive**. The camera chases the rider instead of anticipating movement.

### Opportunity
The route data is fully available - we know exactly where the rider will be in 5, 10, or 15 seconds. A **predictive approach** could:
- Ignore local path variations entirely by design
- Create truly cinematic, smooth camera movement
- Look ahead to anticipate turns and elevation changes
- Reduce computational overhead of multiple smoothing layers

## Problem Statement

Design and implement a predictive camera system that:
1. Samples rider position 5-15 seconds into the future
2. Computes a smoothed "camera target" from future positions
3. Positions camera based on this smoothed target (not current rider)
4. Keeps rider visible near viewport center
5. Works across chase, bird's eye, and side view modes
6. Handles edge cases: route end, sharp turns, speed changes

## Analysis

### Research Findings: Established Algorithms

#### 1. Critically Damped Springs (Recommended Primary Approach)
- **Source**: Game development standard (Ryan Juckett, Orange Duck)
- **Behavior**: Reaches target as fast as possible without oscillation
- **Parameters**: Angular frequency (ω), damping ratio (ζ=1.0)
- **Advantage**: Frame-rate independent, predictable settling time
- **Formula**:
  ```
  acceleration = -ω² × displacement - 2ωζ × velocity
  ```

#### 2. Weighted Centroid of Future Positions
- **Concept**: Sample N future positions, weight by exponential decay
- **Formula**: `target = Σ(position_i × e^(-t_i/τ)) / Σ(e^(-t_i/τ))`
- **Parameters**: Time constant τ (5-8 seconds recommended)
- **Advantage**: Naturally filters out local variations

#### 3. Catmull-Rom Splines Through Sample Points
- **Use case**: When direction/tangent needed, not just position
- **Advantage**: Continuous derivatives, smooth interpolation
- **Application**: Chase view camera orientation

#### 4. 1€ (One Euro) Filter
- **Adaptive smoothing**: Less smoothing at high speeds, more at low speeds
- **Parameters**: Minimum cutoff frequency, speed coefficient
- **Best for**: Final output smoothing (not prediction)

#### 5. Kalman Filter (Considered but Not Recommended)
- **Overkill for this use case**: We have perfect future knowledge
- **Better suited for**: Noisy real-time sensor data

### Architecture Decision

**Hybrid Approach: Weighted Centroid + Critically Damped Spring**

```
[Future Samples] → [Weighted Centroid] → [Prediction Filter] → [Camera Spring] → [Final Position]
     ↓                    ↓                     ↓                    ↓
  6-30 samples         τ = 6s               τ = 3s               ω = 1.5
  every 20m           removes jitter      removes jumps        smooth motion
  (distance-based)
```

**Key insight**: This is NOT path smoothing. The weighted centroid computes a "center of mass" of future positions. Local zigzags (50m left, 50m right) mathematically cancel out in the averaging - the camera moves straight while the rider wiggles.

### Current Codebase Integration Points

| Component | Location | Integration |
|-----------|----------|-------------|
| `getPointAlongRoute()` | Line 671 | Use for future sampling |
| `calculateCameraForMode()` | Line 738 | Replace with predictive version |
| Smoothing helpers | Lines 588-633 | Refactor to use springs |
| Mode switch | Line 1132 | Add predictive calculation |
| Frame update | Line 3427 | Use predicted target |

## Recommendation

### Algorithm: Predictive Camera Controller

```javascript
class PredictiveCameraController {
    // Configuration (tunable)
    config = {
        sampleIntervalMeters: 20,    // Sample every 20m along path
        minSamples: 6,               // Minimum samples even at low speed
        maxSamples: 30,              // Cap for performance
        lookAheadSeconds: 12,        // How far ahead to sample (time-based limit)
        predictionTau: 6.0,          // Centroid time constant (seconds)
        springOmega: 1.5,            // Camera spring frequency
        springZeta: 1.0,             // Critically damped
        riderCenterWeight: 0.65,     // Balance rider vs prediction in look-at
    };

    // State
    predictedTarget = null;          // Smoothed prediction
    cameraSpring = null;             // Spring for camera position
    lookAtSpring = null;             // Spring for look-at point

    update(riderPosition, riderSpeed, pathProgress, deltaTime) {
        // 1. Sample future positions (distance-based for consistent path coverage)
        const samples = this.sampleFuturePositions(
            pathProgress, riderSpeed, this.config.lookAheadSeconds
        );  // Returns 6-30 samples at ~20m intervals

        // 2. Compute weighted centroid (filters local variations)
        const rawTarget = this.computeWeightedCentroid(samples);

        // 3. Smooth the prediction (prevents jumps when samples change)
        this.predictedTarget = this.smoothPrediction(rawTarget, deltaTime);

        // 4. Calculate ideal camera position for current mode
        const idealCamera = this.calculateIdealCamera(
            riderPosition, this.predictedTarget
        );

        // 5. Spring-smooth camera to ideal position
        const smoothedCamera = this.cameraSpring.update(idealCamera, deltaTime);

        // 6. Calculate and smooth look-at point
        const lookAt = lerp(this.predictedTarget, riderPosition, 0.65);
        const smoothedLookAt = this.lookAtSpring.update(lookAt, deltaTime);

        return { position: smoothedCamera, lookAt: smoothedLookAt };
    }
}
```

### Mode-Specific Adjustments

| Mode | Look-Ahead | Spring ω | Notes |
|------|------------|----------|-------|
| Chase | 10-12s | 1.5 | Most benefit from prediction |
| Bird's Eye | 8-10s | 1.2 | Rotation stability key |
| Side View | 6-8s | 1.8 | Faster response for elevation |

### Implementation Phases

#### Phase 1: Core Prediction Engine
- Implement `sampleFuturePositions()` using existing `getPointAlongRoute()`
- Implement `computeWeightedCentroid()` with exponential decay weights
- Implement `CriticallyDampedSpring` class
- Unit test with mock route data

#### Phase 2: Chase View Integration
- Create `PredictiveCameraController` class
- Replace reactive chase camera calculation
- Add parameter tuning UI (temporary)
- A/B test against current implementation

#### Phase 3: Bird's Eye & Side View
- Adapt prediction for bird's eye (focus on rotation)
- Adapt prediction for side view (elevation tracking)
- Ensure smooth transitions between modes

#### Phase 4: Edge Cases & Polish
- Handle route end (< 15 seconds remaining)
- Handle sharp corners (curvature detection)
- Handle speed changes (adaptive look-ahead)
- Remove parameter tuning UI, finalize values

## Constraints

### Must Have
- Rider always visible (within 30% of frame edge)
- No discontinuities when predictions change
- Frame-rate independent behavior
- Works at all zoom levels

### Should Have
- Smoother than current implementation
- Lower CPU usage (fewer smoothing layers)
- Intuitive parameter tuning

### Won't Have (This Phase)
- Cinematic mode changes (saved for future)
- Multi-rider support
- Path visualization of prediction

## Key Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Position stddev | ~0.5m | <0.2m | Existing smoothness metrics |
| Altitude stddev | ~2.0m | <0.5m | Existing smoothness metrics |
| Bearing stddev | ~0.3° | <0.1° | Existing smoothness metrics |
| Smoothing layers | 6+ | 2-3 | Code complexity |
| Emergency smoothing triggers | Occasional | Never | Console log count |

## Technical Details

### Critically Damped Spring Implementation

```javascript
class CriticallyDampedSpring {
    constructor(omega = 1.5) {
        this.omega = omega;  // Angular frequency
        this.position = null;
        this.velocity = { x: 0, y: 0, z: 0 };
    }

    update(target, deltaTime) {
        if (!this.position) {
            this.position = { ...target };
            return this.position;
        }

        // Critically damped: zeta = 1.0
        const omega = this.omega;
        const omega2 = omega * omega;

        for (const axis of ['x', 'y', 'z']) {
            const displacement = this.position[axis] - target[axis];
            const acceleration = -omega2 * displacement - 2 * omega * this.velocity[axis];

            this.velocity[axis] += acceleration * deltaTime;
            this.position[axis] += this.velocity[axis] * deltaTime;
        }

        return this.position;
    }

    // For geographic coordinates
    updateLngLat(target, deltaTime) {
        // Convert to local meters, update, convert back
        // Handle lat/lng appropriately
    }
}
```

### Weighted Centroid Calculation

```javascript
function computeWeightedCentroid(samples, tau = 6.0) {
    let totalWeight = 0;
    const weighted = { lng: 0, lat: 0, alt: 0 };

    for (const sample of samples) {
        const weight = Math.exp(-sample.time / tau);
        weighted.lng += sample.position.lng * weight;
        weighted.lat += sample.position.lat * weight;
        weighted.alt += sample.position.alt * weight;
        totalWeight += weight;
    }

    return {
        lng: weighted.lng / totalWeight,
        lat: weighted.lat / totalWeight,
        alt: weighted.alt / totalWeight
    };
}
```

### Distance-Based Future Sampling

Distance-based sampling ensures consistent path geometry coverage regardless of speed. This is critical for the weighted centroid to properly "see through" zigzags and local variations - we need enough samples to capture the path shape.

```javascript
const SAMPLE_INTERVAL_METERS = 20;  // Sample every 20m along path
const MIN_SAMPLES = 6;              // Minimum samples even at low speed
const MAX_SAMPLES = 30;             // Cap for performance

function sampleFuturePositions(currentProgress, speed, maxSeconds) {
    const samples = [];
    const routeDistanceKm = totalDistance;
    const currentDistanceKm = currentProgress * routeDistanceKm;

    // Calculate total look-ahead distance based on speed and time
    const lookAheadDistanceKm = (speed / 3600) * maxSeconds;  // speed in km/h
    const lookAheadDistanceM = lookAheadDistanceKm * 1000;

    // Determine sample count based on distance, not time
    const rawSampleCount = Math.ceil(lookAheadDistanceM / SAMPLE_INTERVAL_METERS);
    const sampleCount = Math.max(MIN_SAMPLES, Math.min(rawSampleCount, MAX_SAMPLES));

    // Sample at uniform distance intervals
    for (let i = 0; i < sampleCount; i++) {
        const fractionAhead = i / (sampleCount - 1);  // 0 to 1
        const distanceAheadKm = fractionAhead * lookAheadDistanceKm;
        const sampleDistanceKm = Math.min(
            currentDistanceKm + distanceAheadKm,
            routeDistanceKm
        );

        // Calculate time to reach this point (for weighting)
        const timeToReach = (distanceAheadKm * 3600) / speed;  // seconds

        const position = getPointAlongRoute(sampleDistanceKm);
        samples.push({
            time: timeToReach,
            position,
            distanceAhead: distanceAheadKm * 1000  // meters for debugging
        });
    }

    return samples;
}
```

**Why distance-based matters:**

| Speed | Look-ahead (12s) | Samples @ 20m | Path Coverage |
|-------|------------------|---------------|---------------|
| 20 km/h | 67m | 6 (min) | Every ~11m |
| 30 km/h | 100m | 6 (min) | Every ~17m |
| 50 km/h | 167m | 9 | Every ~19m |
| 70 km/h | 233m | 12 | Every ~19m |

This ensures zigzags and S-curves are always captured with enough resolution for the weighted centroid to average them out.
```

## Files to Modify

1. **js/flyover-engine.js** - Main implementation
   - Add `PredictiveCameraController` class
   - Add `CriticallyDampedSpring` class
   - Modify `calculateCameraForMode()` to use predictive system
   - Update `updateCamera()` to use new controller

2. **js/flyover-engine.js** (cleanup)
   - Remove/simplify redundant smoothing layers
   - Update smoothness metrics for new system

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Prediction feels disconnected | High | Tune riderCenterWeight (0.6-0.7) |
| Sharp turns cause jerky prediction | Medium | Add curvature detection, adjust look-ahead |
| Route end causes camera stop | Low | Graceful fallback to current position |
| Performance regression | Low | Spring math is simpler than current layers |

## Success Criteria

1. Camera movement visibly smoother in side-by-side comparison
2. Smoothness metrics improved across all modes
3. No emergency smoothing triggers during normal operation
4. Code complexity reduced (fewer smoothing layers)
5. Camera anticipates turns instead of reacting to them

---

## Appendix: Research Sources

### Algorithm References
- [Ryan Juckett - Damped Springs](https://www.ryanjuckett.com/damped-springs/)
- [Orange Duck - Spring Roll Call](https://theorangeduck.com/page/spring-roll-call)
- [Little Polygon - Third Person Cameras](https://blog.littlepolygon.com/posts/cameras/)
- [Raph Levien - Bezier Path Simplification](https://raphlinus.github.io/curves/2023/04/18/bezpath-simplify.html)
- [GDC - Critically Damped Ease-In/Ease-Out Smoothing](https://www.gdcvault.com/play/1025039/Math-for-Game-Programmers-Juicing)
- [1€ Filter - Noise Filtering](https://jaantollander.com/post/noise-filtering-using-one-euro-filter/)

### Cinematography Principles
- Tour de France broadcast techniques (helicopter leading)
- Racing game cameras (look-ahead for direction)
- Film dolly techniques (anticipation over reaction)

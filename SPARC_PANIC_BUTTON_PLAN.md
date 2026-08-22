# SPARC Plan: Deterministic Camera Replay & Panic Button System

## Executive Summary

This plan addresses the "whack-a-mole" camera jitter debugging problem by creating:
1. A **deterministic camera state machine** that can be replayed exactly
2. A **panic button** that captures the last 30 seconds of state for reproduction
3. A **Chrome MCP replay system** for diagnosing issues in an automated way

---

## S - Specification

### Problem Statement

Camera jitter issues are difficult to debug because:
- They are transient and hard to reproduce
- The camera system has 8+ competing smoothing layers
- State is fragmented across many variables
- External factors (terrain loading, frame timing) introduce non-determinism
- By the time you notice jitter, the conditions that caused it are gone

### Goals

1. **Determinism**: Given identical inputs, the camera produces identical outputs
2. **State Capture**: Continuously record the last 30 seconds of camera state
3. **Panic Button**: One-click capture of reproducible state when jitter occurs
4. **Chrome MCP Integration**: Generate state that can be replayed via browser automation
5. **Minimal Overhead**: Recording should not impact 60fps performance

### Success Criteria

- [ ] Replaying captured state produces pixel-identical camera positions
- [ ] Panic button captures state within 100ms of press
- [ ] State capture adds <1ms per frame overhead
- [ ] Captured state is <1MB for 30 seconds at 60fps
- [ ] Chrome MCP can replay captured state and reproduce jitter
- [ ] System works in all 4 camera modes

### Non-Goals

- Not fixing the jitter itself (that comes after diagnosis)
- Not changing the smoothing algorithms (yet)
- Not adding visual debugging overlays (separate feature)

---

## P - Pseudocode/Plan

### Core Concept: State Ring Buffer

```
┌─────────────────────────────────────────────────────────────────┐
│                    CameraStateRecorder                          │
├─────────────────────────────────────────────────────────────────┤
│  Ring Buffer (1800 frames @ 60fps = 30 seconds)                │
│  ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐            │
│  │ F0  │ F1  │ F2  │ ... │F1797│F1798│F1799│HEAD │            │
│  └─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘            │
│                                                                 │
│  Each Frame Contains:                                          │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ timestamp: number (ms since start)                   │       │
│  │ deltaTime: number (seconds since last frame)         │       │
│  │ progress: number (0-1 route position)                │       │
│  │ riderPosition: {lng, lat, alt}                       │       │
│  │ cameraPosition: {lng, lat, alt}                      │       │
│  │ cameraBearing: number                                │       │
│  │ cameraPitch: number                                  │       │
│  │ terrainElevation: number|null (raw query result)     │       │
│  │ mode: string                                         │       │
│  │ zoomLevel: number                                    │       │
│  │ springState: {position, velocity}                    │       │
│  │ inputEvents: InputEvent[] (for this frame)           │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                 │
│  On Panic Button:                                              │
│  1. Pause animation                                            │
│  2. Copy ring buffer to export array                           │
│  3. Add metadata (route, config, browser info)                 │
│  4. Serialize to JSON                                          │
│  5. Open capture modal                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Pseudocode: State Recording

```javascript
class CameraStateRecorder {
    constructor(maxFrames = 1800) {  // 30 seconds at 60fps
        this.buffer = new Array(maxFrames);
        this.maxFrames = maxFrames;
        this.writeIndex = 0;
        this.frameCount = 0;
        this.startTime = performance.now();
        this.inputEvents = [];  // Pending input events for current frame
    }

    // Called every frame from updateCamera()
    recordFrame(frameData) {
        const frame = {
            timestamp: performance.now() - this.startTime,
            deltaTime: frameData.deltaTime,
            progress: frameData.progress,
            riderPosition: { ...frameData.riderPosition },
            cameraPosition: { ...frameData.cameraPosition },
            cameraBearing: frameData.bearing,
            cameraPitch: frameData.pitch,
            terrainElevation: frameData.terrainElevation,  // Raw, before filtering
            mode: frameData.mode,
            zoomLevel: frameData.zoomLevel,
            chaseCamPitch: frameData.chaseCamPitch,
            speedMultiplier: frameData.speedMultiplier,
            springState: this.captureSpringState(),
            inputEvents: [...this.inputEvents]  // Copy and clear
        };

        this.buffer[this.writeIndex] = frame;
        this.writeIndex = (this.writeIndex + 1) % this.maxFrames;
        this.frameCount++;
        this.inputEvents = [];  // Clear for next frame
    }

    // Record user input events (called from event handlers)
    recordInput(event) {
        this.inputEvents.push({
            type: event.type,  // 'seek', 'mode', 'zoom', 'pitch', 'playPause'
            value: event.value,
            timestamp: performance.now() - this.startTime
        });
    }

    // Export last N seconds of state
    export(seconds = 30) {
        const framesToExport = Math.min(
            this.frameCount,
            Math.ceil(seconds * 60)  // Assume 60fps
        );

        const frames = [];
        let index = (this.writeIndex - framesToExport + this.maxFrames) % this.maxFrames;

        for (let i = 0; i < framesToExport; i++) {
            if (this.buffer[index]) {
                frames.push(this.buffer[index]);
            }
            index = (index + 1) % this.maxFrames;
        }

        return {
            version: '1.0',
            capturedAt: new Date().toISOString(),
            routeFile: routeData?.filename,
            totalDistance: totalDistance,
            config: {
                predictiveEnabled: isPredictiveCameraEnabled(),
                unifiedControllerEnabled: unifiedCameraController?.isEnabled
            },
            browser: {
                userAgent: navigator.userAgent,
                screenSize: { w: window.innerWidth, h: window.innerHeight }
            },
            frames: frames
        };
    }
}
```

### Pseudocode: Panic Button

```javascript
function onPanicButton() {
    // 1. Pause immediately
    if (isPlaying) togglePlay();

    // 2. Capture state
    const capturedState = stateRecorder.export(30);

    // 3. Add diagnostic info
    capturedState.diagnostics = {
        chaosDiag: window._chaosDebugData,
        terrainCache: { ...window._terrainCache },
        predictiveController: predictiveCameraController?.getDebugInfo(),
        unifiedController: unifiedCameraController?.getDebugInfo()
    };

    // 4. Serialize
    const json = JSON.stringify(capturedState, null, 2);

    // 5. Show modal with copyable text
    showPanicCaptureModal(json);
}

function showPanicCaptureModal(json) {
    const modal = document.createElement('div');
    modal.className = 'panic-modal';
    modal.innerHTML = `
        <div class="panic-content">
            <h2>Camera State Captured</h2>
            <p>Copy this state and paste it to Claude Code for analysis:</p>
            <textarea readonly>${json}</textarea>
            <div class="panic-actions">
                <button onclick="copyToClipboard()">Copy to Clipboard</button>
                <button onclick="downloadState()">Download JSON</button>
                <button onclick="closeModal()">Close</button>
            </div>
            <p class="panic-hint">
                In Claude Code, say: "Analyze this camera state capture and
                reproduce the jitter using Chrome MCP"
            </p>
        </div>
    `;
    document.body.appendChild(modal);
}
```

### Pseudocode: Chrome MCP Replay

```javascript
// This would be run via Chrome MCP in Claude Code
async function replayCameraState(capturedState) {
    // 1. Navigate to flyover page with correct route
    await mcp.navigate(`/flyover.html?route=${capturedState.routeFile}`);
    await mcp.waitFor('map loaded');

    // 2. Disable live terrain queries - use recorded values
    await mcp.evaluate(() => {
        window.REPLAY_MODE = true;
        window.REPLAY_TERRAIN = {};  // Will be populated per-frame
    });

    // 3. Initialize to first frame state
    const firstFrame = capturedState.frames[0];
    await mcp.evaluate((frame) => {
        progress = frame.progress;
        currentCameraMode = frame.mode;
        zoomLevel = frame.zoomLevel;
        // ... initialize all state
    }, firstFrame);

    // 4. Step through frames
    for (const frame of capturedState.frames) {
        // Set terrain value for this frame (deterministic)
        await mcp.evaluate((terrain) => {
            window.REPLAY_TERRAIN.current = terrain;
        }, frame.terrainElevation);

        // Apply any input events
        for (const event of frame.inputEvents) {
            await applyInputEvent(event);
        }

        // Advance one frame with recorded deltaTime
        await mcp.evaluate((dt) => {
            updateCamera(dt);
        }, frame.deltaTime);

        // Verify camera matches recorded position
        const actual = await mcp.evaluate(() => getCurrentCameraState());
        const expected = frame.cameraPosition;

        if (positionDiffers(actual, expected)) {
            console.log(`Divergence at frame ${frame.timestamp}ms:`);
            console.log(`  Expected: ${JSON.stringify(expected)}`);
            console.log(`  Actual: ${JSON.stringify(actual)}`);
        }
    }
}
```

---

## A - Architecture

### New Components

#### 1. CameraStateRecorder Class

```javascript
class CameraStateRecorder {
    buffer: FrameState[]       // Ring buffer of recorded frames
    maxFrames: number          // Buffer size (default 1800 = 30s @ 60fps)
    writeIndex: number         // Current write position
    frameCount: number         // Total frames recorded
    startTime: number          // Recording start time
    inputEvents: InputEvent[]  // Pending events for current frame
    isEnabled: boolean         // Recording on/off

    recordFrame(frameData): void
    recordInput(event): void
    export(seconds): CaptureData
    clear(): void
    getStats(): RecorderStats
}
```

#### 2. FrameState Interface

```typescript
interface FrameState {
    timestamp: number;           // ms since recording start
    deltaTime: number;           // seconds since last frame
    progress: number;            // 0-1 route position

    // Positions
    riderPosition: Position3D;   // {lng, lat, alt}
    cameraPosition: Position3D;

    // Orientation
    cameraBearing: number;
    cameraPitch: number;

    // External inputs (for determinism)
    terrainElevation: number | null;  // Raw query result

    // Mode state
    mode: CameraMode;
    modeTransitionProgress: number;

    // User settings
    zoomLevel: number;
    chaseCamPitch: number;
    speedMultiplier: number;

    // Smoothing state (for verification)
    springState: {
        cameraPosition: Position3D;
        cameraVelocity: Position3D;
        lookAtPosition: Position3D;
        lookAtVelocity: Position3D;
    };

    // Input events that occurred this frame
    inputEvents: InputEvent[];
}

interface InputEvent {
    type: 'seek' | 'mode' | 'zoom' | 'pitch' | 'playPause' | 'speed';
    value: any;
    timestamp: number;
}

interface CaptureData {
    version: string;
    capturedAt: string;
    routeFile: string;
    totalDistance: number;
    config: CameraConfig;
    browser: BrowserInfo;
    diagnostics: DiagnosticData;
    frames: FrameState[];
}
```

#### 3. Deterministic Terrain Wrapper

```javascript
// Wrap terrain queries to record/replay values
function queryTerrainDeterministic(lng, lat) {
    if (window.REPLAY_MODE && window.REPLAY_TERRAIN.current !== undefined) {
        // In replay mode, return recorded value
        return window.REPLAY_TERRAIN.current;
    }

    // In normal mode, query and record
    const elevation = map.queryTerrainElevation([lng, lat]);

    if (stateRecorder?.isEnabled) {
        // Record for current frame (will be saved in recordFrame)
        stateRecorder._currentTerrainQuery = elevation;
    }

    return elevation;
}
```

### Files to Modify

| File | Changes |
|------|---------|
| `flyover-engine.js` | Add CameraStateRecorder class |
| `flyover-engine.js` | Add frame recording in updateCamera() |
| `flyover-engine.js` | Add input recording in event handlers |
| `flyover-engine.js` | Add queryTerrainDeterministic wrapper |
| `flyover-engine.js` | Add panic button handler |
| `flyover-engine.js` | Extend flyoverDebug API |
| `flyover.html` | Add panic button UI |
| `styles.css` | Add panic modal styles |

### Integration Points

```
updateCamera() ─────────────────────────────────────────────────────┐
     │                                                              │
     ├─► Calculate rider position                                   │
     │       └─► Record riderPosition                               │
     │                                                              │
     ├─► Query terrain                                              │
     │       └─► queryTerrainDeterministic() ─► Record elevation    │
     │                                                              │
     ├─► Apply smoothing (springs, EMA)                             │
     │       └─► Record springState                                 │
     │                                                              │
     ├─► Calculate camera position                                  │
     │       └─► Record cameraPosition, bearing, pitch              │
     │                                                              │
     └─► stateRecorder.recordFrame(frameData) ◄─────────────────────┘

Event Handlers (seekToPosition, transitionToMode, adjustZoom, etc.)
     │
     └─► stateRecorder.recordInput(event)
```

---

## R - Refinement

### Phase 1: Core Recording Infrastructure (Low Risk)

1. Create `CameraStateRecorder` class with ring buffer
2. Create `FrameState` data structure
3. Add `recordFrame()` call at end of `updateCamera()`
4. Add `recordInput()` calls in existing event handlers
5. Verify recording doesn't impact performance (<1ms overhead)

**Testing:**
- Measure frame time with recording enabled vs disabled
- Verify buffer wraps correctly after 30 seconds
- Verify memory usage stays constant

### Phase 2: Panic Button UI (Low Risk)

1. Add panic button to flyover.html UI
2. Create modal for displaying captured state
3. Add copy-to-clipboard functionality
4. Add JSON download option
5. Add keyboard shortcut (e.g., Ctrl+Shift+P)

**Testing:**
- Verify button is visible but unobtrusive
- Verify modal displays correctly
- Verify copy/download work

### Phase 3: Deterministic Terrain (Medium Risk)

1. Create `queryTerrainDeterministic()` wrapper
2. Replace all `queryTerrainElevation` calls with wrapper
3. Record terrain values in frame state
4. Add `REPLAY_MODE` flag for playback
5. Verify terrain values are recorded correctly

**Testing:**
- Compare recorded terrain values with live queries
- Verify replay mode uses recorded values
- Test with various terrain loading scenarios

### Phase 4: Chrome MCP Replay Script (Medium Risk)

1. Create replay script template
2. Implement frame-by-frame stepping
3. Implement input event application
4. Add divergence detection and logging
5. Create Claude Code prompt template

**Testing:**
- Replay a 5-second capture manually
- Verify positions match within tolerance
- Test with various jitter scenarios

### Phase 5: Full Integration & Polish

1. Add statistics/diagnostics to capture
2. Add capture compression (gzip)
3. Add capture validation
4. Document usage in README
5. Add visual indicator when recording

**Testing:**
- End-to-end test: record, capture, replay, verify
- Test with all 4 camera modes
- Test with seeks, mode changes, zoom changes

---

## C - Completion Checklist

### Implementation

- [ ] CameraStateRecorder class created
- [ ] FrameState interface defined
- [ ] recordFrame() integrated into updateCamera()
- [ ] recordInput() integrated into all event handlers
- [ ] queryTerrainDeterministic() wrapper created
- [ ] Panic button added to UI
- [ ] Panic modal with copy/download
- [ ] Keyboard shortcut (Ctrl+Shift+P)
- [ ] flyoverDebug.recorder API added
- [ ] Chrome MCP replay script created

### Testing

- [ ] Recording overhead <1ms per frame
- [ ] Memory usage constant over time
- [ ] Ring buffer wraps correctly
- [ ] All input events captured
- [ ] Terrain values recorded correctly
- [ ] Replay mode uses recorded terrain
- [ ] Divergence detection works
- [ ] All 4 camera modes tested
- [ ] Seeks, mode changes, zoom tested

### Documentation

- [ ] Usage instructions in code comments
- [ ] Claude Code prompt template
- [ ] Example capture JSON
- [ ] Troubleshooting guide

---

## Risk Mitigation

1. **Performance Impact**: Profile early, use typed arrays if needed
2. **Memory Usage**: Fixed-size ring buffer prevents growth
3. **Serialization Size**: Compress large captures, limit precision
4. **Browser Compatibility**: Test on Chrome, Firefox, Safari
5. **Replay Accuracy**: Start with position tolerance, tighten over time

---

## Hive-Mind Review Perspectives

### Architect Perspective
- Ring buffer pattern is efficient and bounded
- Separation of recording from playback is clean
- Wrapper approach for terrain queries maintains backward compatibility
- Consider: Could use Web Workers for serialization to avoid UI stutter

### Developer Perspective
- Integration points are well-defined
- Event recording covers all user inputs
- State capture is comprehensive
- Consider: Add frame number to help correlate with console logs

### QA/Testing Perspective
- Divergence detection helps identify non-determinism sources
- Multiple capture formats (copy, download) aid debugging
- Consider: Add visual playback mode for human verification

### Security Perspective
- Captured state doesn't include sensitive data
- JSON output is safe for sharing
- Consider: Add option to anonymize route data

### Performance Perspective
- Recording every frame at 60fps is 1.8KB * 60 = 108KB/s
- 30 seconds = 3.2MB uncompressed, ~300KB compressed
- Ring buffer avoids allocation churn
- Consider: Sample every 2nd frame for lower overhead option

### UX Perspective
- Panic button should be easily discoverable but not distracting
- Modal should be dismissible with Escape key
- Copy confirmation should be clear
- Consider: Add "one-click share" that generates pastebin link

---

## Consensus Summary

All perspectives agree that:
1. The ring buffer approach is sound
2. Recording all frames is necessary for accurate reproduction
3. Deterministic terrain is the key technical challenge
4. The Chrome MCP replay is valuable for automated diagnosis

Outstanding questions to resolve:
1. Should we record at 60fps or allow configurable sample rate?
2. Should the panic button auto-pause or ask first?
3. How much historical state do we need (30s, 60s, configurable)?

**Decision**: Start with 30s @ 60fps with auto-pause, iterate based on real-world usage.

---

## Implementation Order

1. **Day 1**: CameraStateRecorder class + basic recording
2. **Day 1**: Panic button UI + modal
3. **Day 2**: Terrain wrapper + deterministic queries
4. **Day 2**: Chrome MCP replay script
5. **Day 3**: Testing, refinement, documentation

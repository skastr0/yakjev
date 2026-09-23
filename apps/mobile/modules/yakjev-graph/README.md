# Yakjev graph

The iOS client renders the server's graph with an Expo native view, `MTKView`, and
Metal instancing. One draw renders directed edges, one renders Jev preview edges,
and one renders node discs. A single CoreGraphics overlay draws at most 64 node
labels and 28 relation labels, with collision avoidance and Dynamic Type support.
There is no UIKit view per node and no recurring idle display loop.

Pan, pinch, hit testing, and node dragging run natively. Three position buffers
protect in-flight GPU reads; camera changes update a uniform without rebuilding
the graph. Node drag callbacks cross to JS at most every 100 ms, plus start/end/
cancel events. Nearby candidates use a uniform spatial grid and are limited to
24 nodes within 240 screen points. The native view never writes server state.
The caller persists the final position and supplies authoritative node arrays.

## Contract

Import `YakjevGraphView` and its types from this module. Pass positions in a world
coordinate system where positive y points down. The mobile graph projection flips
Sigma's saved y coordinate on input and drag output. Ordinary prop updates retain
the camera. Increment `fitRequest` to fit; set `focusNodeId` to center a node.
Setting `connectSourceId` selects the source for a tap or drag connection.

`onNodeDrag` emits `{ id, x, y, nearbyIds, phase }`. Its phase is `start`, `move`,
`end`, or `cancel`; cancellation restores the starting native position. Graph
updates preserve the actively dragged position until that gesture ends. Event
callbacks receive the payload directly, without a `nativeEvent` wrapper.

The native graph requires an iOS development/production build. Expo Go cannot
load this custom module. There is no Android renderer in this module.

## Build and validation

From the mobile app, run prebuild/pod installation after adding native sources,
then rebuild the iOS application. Autolinking uses `expo-module.config.json` and
`ios/YakjevGraph.podspec`. The pod ships the actual `Graph.metal` shader in
`YakjevGraphShaders.bundle`; the loader accepts its raw source or a compiled
`default.metallib`. Shader compilation happens once when the view initializes.
Initialization errors are visible on the canvas and emitted through
`onRendererError`.

Run the platform-independent geometry tests with:

```sh
swift test -c release --package-path apps/mobile/modules/yakjev-graph
```

The fixture includes 10,000 nodes and 30,000 edges. Its measurements cover CPU
geometry only; simulator or host timings are not device frame-rate guarantees.
The Metal shader test uses a real Metal device when available and skips otherwise.

Native Instruments signposts use subsystem `com.yakjev.mobile`, category `Graph`:
`CompileShaders`, `UpdateGraph`, `VisibleLabels`, `EncodeFrame`, and `GPUComplete`.
Use Points of Interest, Time Profiler, and Metal System Trace on a physical device
to check label work, command encoding, GPU duration, and absence of idle frames.
VoiceOver exposes visible nodes plus fit/zoom actions; app search reaches nodes
outside the viewport.

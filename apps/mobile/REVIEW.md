# Mobile review — 2026-09-23

The iOS client is functional and distributed through TestFlight, but graph interaction still needs work before it feels as good as the web app. The color changes below are prepared locally; coordinated release is on hold.

## Built

- Expo/React Native client in the existing Bun workspace, using the existing HTTP server and shared graph contracts. No second server, graph database, or subscription integration.
- Native Swift/Metal graph rendering, pan/pinch/drag, hit testing, spatial lookup, selection and bounded labels. Rendering and gestures do not depend on a WebView.
- SecureStore connection, authenticated HTTP and SSE, revision checks, serialized commands, explicit replay of uncertain writes, foreground recovery, and separate layout persistence.
- Capture and edit intentions, connect and reframe edges, search, archive visibility, history, undo, export, context and taxonomy. Jev typing/drag/link previews use the shared server.
- Recognizable paper/forest design, typography, shared icon, and iPhone/iPad layout. The native graph currently targets iOS.
- App Store Connect setup and TestFlight build 0.1.0 (1), including its icon and owner invitation. Signing account settings remain private local configuration.

## Colors prepared for the next coordinated release

Colors now come from the graph, with the same palette and blending across clients. Mobile paints use `node.paint`, Status resets use explicit `null`, and capture includes its selected color atomically (defaulting to the first palette color).

Existing device colors are imported only where the server has no stored choice. Acknowledged or already-resolved entries are retired; missing-node entries remain available for later snapshots. Failed imports can be retried. Preference cleanup uses Expo's native atomic write, with reads and writes serialized per file across sessions. A paint change does not discard a text draft or create a false content conflict.

Old released clients cannot decode history containing the new command. Updated web, desktop and mobile releases must be coordinated before enabling production migration.

## Findings still open

1. **Pinch lifecycle can reverse a gesture.** `ios/YakjevGraphView.swift` returns early while interaction is disabled, including for pinch begin/end events. If a new begin is skipped and changes subsequently resume, an old `lastPinch` is reused. A reproduction using the current camera code produced a 1.8× outward movement for an intended 0.9× inward change. This establishes a possible defect, not the exact sequence behind the owner's screenshot. Track accepted gesture lifecycles and reset/rebase when interaction changes.
2. **Zoom magnifies spacing while dots stay fixed.** `ios/Shaders/Graph.metal` transforms node positions with camera scale but keeps ordinary dots at a six-point radius. The camera has no practical zoom bounds. The web renderer grows dots with zoom; mobile therefore exposes progressively more empty space. Preserve the pinch anchor, add suitable bounds, and bring dot/label behavior closer to the web. No physics engine is moving the nodes during zoom.
3. **Resume does not refresh another client's layout.** `GraphSession.boot` skips the layout read after `layoutLoaded` becomes true. Graph edits refresh, but positions changed elsewhere remain stale through resume/manual reconnect. Refresh layout while preserving local unsaved positions.
4. **An unchanged Jev edge can be recorded as a correction.** `EdgeEditor.save` calls `correctJev` for an existing Jev edge even without an intentional change. Corrections affect future connection decisions. Disable/no-op an unchanged save and distinguish edits from actual corrections.
5. **Navigation can discard unsaved editor content.** Connect, Focus, opening a connection, and closing the sheet unmount the node's local draft without a dirty-draft decision. Retain drafts or provide an explicit save/discard path.
6. **Accessibility and physical-device performance remain unproven.** Native accessibility exposes a bounded set of visible nodes and fit/zoom actions, without full edge/pan navigation. VoiceOver, large text, sustained phone frame times and representative large graphs need device testing. Offscreen Metal measurements do not establish phone FPS or label-layout cost.

## Verification limits

See [runtime QA](test/README.md) for recorded simulator checks and remaining tests. Automated tests cover real disposable-server HTTP/SSE, session/replay behavior, layout races, shared colors and migration failure cases. The earlier simulator run did not test pinch. Successful live-provider Jev behavior, VoiceOver and physical-device performance are still separate acceptance work. None of the zoom/editing findings above was fixed as part of the color change.

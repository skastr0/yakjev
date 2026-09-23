# Yakjev on iPhone and iPad

`apps/mobile` is an Expo client of the existing Yakjev server. It uses the same protocol, commands, revision checks, journal, layout store, and Jev preview endpoint as the web workbench. There is no mobile backend, embedded SQLite graph, provider credential, RevenueCat integration, or paywall.

## Development

Requirements: Bun 1.4.2, Node supported by Expo SDK 57, Xcode with an iOS simulator, and CocoaPods. Dependencies are pinned to Expo 57.0.24, React Native 0.86.3, and React 19.2.3. Effect remains 4.0.0-rc.117.

From the repository root:

```sh
bun install --frozen-lockfile
YAKJEV_DEV_AUTH=true bun run dev
```

In a second terminal:

```sh
bun run mobile:ios
# Subsequent JS-only development:
bun run mobile:start
```

The app defaults to `https://yakjev-production.up.railway.app`, shared with Electron through `@yakjev/client/config`. Enter your owner token to unlock it. For synthetic simulator development, change the server to `http://127.0.0.1:3210` and use `synthetic-yakjev-owner-token-local-only`. HTTP is accepted only for loopback in development builds. Never put the token in app config, an `EXPO_PUBLIC_` variable, or source code.

The graph is a local Expo native module, so use a development build rather than Expo Go. Native projects are generated and ignored; Swift sources live in `apps/mobile/modules/yakjev-graph`. Rebuild after native changes. If adding Swift or shader files to an existing generated project, run CocoaPods installation again before building.

The initial native target is iOS, including iPad. Android is not declared as a supported build target; its graph renderer would need a native implementation of the same view contract.

## Shared behavior and appearance

`packages/client` contains the HTTP client, command builders, Jev connections/corrections, graph filtering, and color mixing used by mobile and web. The web app retains its browser transport and Sigma renderer, which Electron also uses. Mobile uses authenticated streaming `expo/fetch` for live graph updates and SecureStore for the endpoint/token pair.

The paper canvas, forest text, Avenir Next labels, Georgia italic wordmark, vivid nodes, and fine relationship lines follow the web design. Touch controls expose creation, editing, linking, search, fit, history, context, and undo around the graph. Node coordinates use the server's existing layout store; the native view flips the vertical axis at the display boundary to match Sigma's orientation.

Graph snapshots remain authoritative. Commands are serialized, use the current revision, and retain the same request ID for an explicit retry after a lost response. A revision conflict refreshes the graph without silently reapplying the old edit. Switching servers or locking cancels the prior session. Live streams and preview requests stop when the app backgrounds and reconnect on return.

## Native graph boundary

Swift owns the camera, pan/pinch gestures, drag positions, hit testing, visibility, and rendering. React sends graph data and receives semantic selection/drag/drop events; it does not render an individual React Native view for each node or run a per-frame graph loop.

The Metal renderer batches node and edge instances, reuses pipeline state and GPU buffers, and requests frames only when the graph or camera changes. Labels are bounded and placed to avoid collisions. A spatial index keeps nearby-node queries bounded. `OSSignposter` markers make native work inspectable in Instruments. The Swift geometry core has its own package tests, independent of Expo.

This architecture is intended for large graphs. Simulator timings and geometry benchmarks are not physical-device GPU throughput guarantees; profile representative graphs on the intended device before assigning an FPS budget.

## Checks and builds

```sh
bun run mobile:verify
bun run mobile:native:test # Swift geometry and Metal checks on macOS
bun run verify
# Create a JS production bundle without signing:
bun run --cwd apps/mobile export
# Recreate the generated iOS project:
bun run --cwd apps/mobile prebuild
```

`eas.json` follows the Expo template's development, preview, and production split. It contains no account identifiers or submission configuration. Builds for devices require your own signing setup. No EAS build, App Store submission, server deployment, or production write happens as part of local verification.

The implementation follows [Expo's monorepo guidance](https://docs.expo.dev/guides/monorepos/), [native view modules](https://docs.expo.dev/modules/native-view-tutorial/), and [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/). `../expo-template` supplied the workspace conventions; `../ripple` supplied the local Expo module, native rendering lifecycle, and Swift package testing patterns.

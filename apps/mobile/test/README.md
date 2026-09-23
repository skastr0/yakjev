# Mobile runtime QA

Automated client/server checks: `bun test apps/mobile/test`. These start the existing server with disposable SQLite and synthetic credentials. They cover real bearer requests, command replay/conflicts, layout persistence, journal/SSE decoding, two mobile sessions, foreground recovery, an interrupted response after a successful server commit, and unavailable Jev. They do not measure native rendering or device performance.

For interactive checks, run `bun apps/mobile/scripts/fixture.ts` from the repository root. It prints the local server address and synthetic owner token and seeds six intentions with explicit connections. Keep the command running; Ctrl-C removes its disposable database. The iOS simulator can use its loopback address. This fixture deliberately has no provider credentials.

Use a development build containing the local native graph module, not Expo Go. Record the device/simulator, build configuration, graph size and evidence for each completed check. The checklist below is a runbook, not a record of passed checks.

- [ ] Enter **Server address** and **Owner access token**; press **Open graph**. A wrong token shows an error; the synthetic token opens the seeded graph.
- [ ] Pan, pinch and press **Fit**. Tap a node and an edge. Text, arrows and selection remain legible; sheet controls stay above the keyboard and safe area.
- [ ] Press **+ Intention**, type into **Intention**, then **Capture intention**. With the fixture, Jev reports unavailable and the intention still saves. **Find** → **Find intentions** locates it.
- [ ] Edit the intention's **Title**, **Description**, **Project** and status; press **Save intention**. Add a **Source address** / **Source label**, save, and open the source. Restart the app and confirm server data remains.
- [ ] Use **Connect to…**, select another intention, choose a relation, optionally **⇄ Swap direction**, and press **Connect**. Reopen the edge, change its relation/rationale, press **Save connection**, and inspect the same edge in the web app.
- [ ] Drag a node, release it, reconnect a second client, and confirm its position persisted. Node movement must not add a graph history revision.
- [ ] Open **Workspace tools** → **Jev context**, edit **Jev context**, and press **Save context**. Confirm it appears in the web app. Check **History**, **Relationship types**, archive visibility and **Export graph**.
- [ ] Keep web and mobile connected to this fixture. Edit in each client; the other catches up without manual refresh. Background mobile, edit in web, foreground mobile, and confirm current server state.
- [ ] Stop the fixture while mobile is open. Observe the connection error without losing the visible graph; rejected writes must not claim success. Use **Retry save** only for an unconfirmed save, then check history for a single mutation.
- [ ] Use **Workspace tools** → **Lock graph**. The private graph disappears. Relaunch; it must require reconnection after locking.
- [ ] On a separately authorized server with a real Jev provider, verify typing previews, drag previews/direct connection on drop, drawn-link preselection and **Not related · teach Jev**. Do not mark these passed using the unavailable fixture or fabricated judgments.
- [ ] With VoiceOver and larger text, reach **Workspace tools**, **Find intentions**, editors and **Close editor**. Test reduced motion and both portrait/landscape layouts.
- [ ] On a physical iPhone release build with representative large synthetic graphs, capture frame times, dropped frames, memory and gesture latency during pan/zoom/drag and incoming updates. Report measured results with device and graph counts; simulator smoothness is not a performance result.

## Recorded simulator smoke check — 2026-09-22

Probe drove an ad hoc signed Debug build on iPhone 17 Pro / iOS 26.5 Simulator (`D8C3067E-3C29-4A2C-871F-71AC0679F2CD`). Final native source was `0bee7d5`, including UI camera readiness fix `3c6fbae`. The disposable fixture ran at `http://127.0.0.1:53282`; every graph write used its synthetic owner. No production graph was opened or changed.

Observed results, with `/api/graph` and `/api/layout` read independently after UI writes:

- SecureStore restored the synthetic connection after a cold launch. The final build initially fitted all seven nodes and four edges without pressing **Fit**; visible right-side labels stayed in the viewport.
- **Capture intention** created `Runtime QA intention` at revision 11. **Find intentions** located it. **Save intention** persisted the edited project (`Mobi QA`, the actual field value) and `done` status at revision 12. Explicit sheet scrolling reached the save button above the keyboard.
- Dragging that node changed its saved position from `(-43.333333333333336, 38.333333333333336)` to `(-43.333333333333336, 407.40310077519376)`. Graph revision remained 12. **Undo** then restored the prior project/status at revision 13 while retaining the layout.
- **Jev context** → **Save context** stored exactly `Synthetic QA context.` at revision 14. Switching to Settings and back retained the rendered graph and live revision 14.
- **Lock graph** removed the graph and emptied the token field. A subsequent process termination and cold launch still required a token, with **Open graph** disabled and the production server default restored.

Local screenshots are in `apps/mobile/artifacts/screenshots/`: `06-final-fitted-graph.png`, `07-dragged.png`, `08-foreground.png`, and `09-locked-relaunch.png`. Final Probe session: `8199b828-faf5-4a04-bad9-13eac13c5adb`; snapshots and runner logs remain under `~/.probe/sessions/`. These ignored artifacts are local evidence, not committed fixtures.

Development limitations observed: an unsigned build could not access SecureStore; signing resolved it. Reloading an already loaded Expo development client caused an `ExpoFabricView.swift:197` assertion; a cold process launch without opening the dev-client URL again recovered. Probe's automatic scrolling did not reach an editor field covered by the keyboard; explicit scrolling worked. The simulator screenshots include Expo's debug overlay.

This run did **not** verify link/correction UI, source opening, pinch, VoiceOver, large text, physical-device performance, or a live Jev provider. The fixture has no provider credentials; no successful AI evaluation is claimed. Those checks remain in the runbook above.

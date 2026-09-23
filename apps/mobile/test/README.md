# Mobile runtime QA

Automated client/server checks: `bun test apps/mobile/test`. These start the existing server with disposable SQLite and synthetic credentials. They cover real bearer requests, command replay/conflicts, layout persistence, journal/SSE decoding, two mobile sessions, foreground recovery, an interrupted response after a successful server commit, and unavailable Jev. They do not measure native rendering or device performance.

For interactive checks, run `bun apps/mobile/scripts/fixture.ts` from the repository root. It prints the local server address and synthetic owner token and seeds six intentions with explicit connections. Keep the command running; Ctrl-C removes its disposable database. The iOS simulator can use its loopback address. This fixture deliberately has no provider credentials.

Use a development build containing the local native graph module, not Expo Go. Record the device/simulator, build configuration, graph size and evidence for each completed check. The checklist below is a runbook, not a record of passed checks.

- [ ] Enter **Server address** and **Owner access token**; press **Open graph**. A wrong token shows an error; the synthetic token opens the seeded graph.
- [ ] Pan, pinch and press **Fit**. Tap a node and an edge. Text, arrows and selection remain legible; sheet controls stay above the keyboard and safe area.
- [ ] Press **+ Intention**, type into **Intention**, then **Capture intention**. With the fixture, Jev reports unavailable and the intention still saves. **Find** → **Find intentions** locates it.
- [ ] Edit the intention's **Title**, **Context**, **Project** and status; press **Save intention**. Add a **Source address** / **Source label**, save, and open the source. Restart the app and confirm server data remains.
- [ ] Use **Connect to…**, select another intention, choose a relation, optionally **⇄ Swap direction**, and press **Connect**. Reopen the edge, change its relation/rationale, press **Save connection**, and inspect the same edge in the web app.
- [ ] Drag a node, release it, reconnect a second client, and confirm its position persisted. Node movement must not add a graph history revision.
- [ ] Open **Workspace tools** → **Jev context**, edit **Jev context**, and press **Save context**. Confirm it appears in the web app. Check **History**, **Relationship types**, archive visibility and **Export graph**.
- [ ] Keep web and mobile connected to this fixture. Edit in each client; the other catches up without manual refresh. Background mobile, edit in web, foreground mobile, and confirm current server state.
- [ ] Stop the fixture while mobile is open. Observe the connection error without losing the visible graph; rejected writes must not claim success. Use **Retry save** only for an unconfirmed save, then check history for a single mutation.
- [ ] Use **Workspace tools** → **Lock graph**. The private graph disappears. Relaunch; it must require reconnection after locking.
- [ ] On a separately authorized server with a real Jev provider, verify typing previews, drag previews/direct connection on drop, drawn-link preselection and **Not related · teach Jev**. Do not mark these passed using the unavailable fixture or fabricated judgments.
- [ ] With VoiceOver and larger text, reach **Workspace tools**, **Find intentions**, editors and **Close editor**. Test reduced motion and both portrait/landscape layouts.
- [ ] On a physical iPhone release build with representative large synthetic graphs, capture frame times, dropped frames, memory and gesture latency during pan/zoom/drag and incoming updates. Report measured results with device and graph counts; simulator smoothness is not a performance result.

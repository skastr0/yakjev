# Yakjev desktop

The Electron app is a client of your existing Yakjev server. It bundles the
same React/Sigma workbench from `apps/web/index.html`, with the same graph,
Jev interactions, colors, typography, and keyboard controls. Web development
and deployment remain independent.

## Run

```sh
bun install --frozen-lockfile
bun run desktop:build
bun run desktop:start
```

On first launch, enter your server's HTTPS origin (for example,
`https://your-yakjev.up.railway.app`). Unlock with the existing owner-token form.
Use **File → Connect to Server…** to switch servers. The app remembers the
server address. Each server has its own Chromium session and browser storage.
Source links open in your system browser.

You can also select a server when launching from a terminal:

```sh
YAKJEV_REMOTE_URL=https://your-yakjev.up.railway.app bun run desktop:start
```

`YAKJEV_URL` is an alias. The environment overrides the remembered address for
that launch. Never put an owner token or provider credential in build settings.

## Local development

Start the existing server in one terminal, then the desktop client in another:

```sh
# Existing server, synthetic data/auth only
YAKJEV_DEV_AUTH=true bun run start

# Separate terminal: renderer HMR and Electron main-process rebuilds
YAKJEV_REMOTE_URL=http://127.0.0.1:3210 bun run desktop:dev
```

Unlock with `synthetic-yakjev-owner-token-local-only`. HTTP is accepted only
for loopback hosts; other servers require HTTPS. Desktop development uses
port **5174** and a separate session from the built application. `bun run dev`
continues to start only the web app and server.

`YAKJEV_DESKTOP_USER_DATA=/absolute/path` isolates desktop settings, Chromium
storage, and the single-instance lock. The smoke check uses a disposable path.

## Package

```sh
bun run desktop:package --dir  # local application bundle
bun run desktop:package       # host-platform installer/archive
```

Output goes to `apps/desktop/release/`. macOS produces DMG/ZIP, Windows NSIS,
and Linux AppImage; build on the target platform. macOS packages use a local
ad-hoc signature. Developer ID signing, notarization, publishing and automatic
updates are not configured.

## Runtime and performance

- Electron main owns one Effect v4 `ManagedRuntime`. Services, native windows,
  protocol registrations and shutdown resources have a single lifetime.
- Main and preload are bundled ahead of time; packaged runtime code does not
  traverse workspace dependencies or load Bun/server modules.
- The workbench's assets are loaded locally under the selected server's origin.
  API calls and EventSource streams use Chromium's persistent session and the
  existing server. Responses stream through without parsing graph JSON in main
  or copying graph snapshots through IPC. Mutations are never retried by this
  transport.
- Rendering remains GPU-backed Sigma/WebGL. The main process does asynchronous
  network/file work; it does not perform graph layout or inference. Future CPU
  work should run in workers or utility processes supervised by Effect.
- Closing the app aborts transport work, releases windows/protocols, flushes
  session cookies and awaits runtime disposal. Closing the last window on macOS
  keeps the app running; reopening it reconnects the workbench.

Effect supplies resource management and cancellation; it does not change the
server's throughput or the graph renderer's existing capacity. Desktop ships
the same renderer and server contracts. Local monitoring and data ingestion
are future work.

## Boundaries

The desktop app does not start a server, listen on a local API port, import
server implementation code, or create a graph database. All graph writes,
revision checks, replay, layouts and Jev evaluation remain server-owned.

The workbench has sandboxing, context isolation and web security enabled, with
no Node integration or preload API. Only the first-run connection window has
a bridge: one checked `connect(origin)` operation. Main checks the calling
window, frame and URL before accepting it. Unknown permissions, popups inside
Electron, off-origin navigation and arbitrary local paths are denied. Valid
HTTP(S) source links are handed to the system browser.

The owner token is exchanged by the existing web login for the server's
HttpOnly cookie. Desktop settings store only the server origin. API redirects
are rejected. Development uses separate session storage and is disabled in
packaged builds. The web deployment skips downloading Electron's binary.

## Checks

```sh
bun run desktop:test   # origin, local asset and settings boundaries
bun run desktop:smoke  # real Electron + disposable existing Yakjev server
bun run verify        # repository checks, including desktop build/unit tests
```

The smoke check requires a graphical session. It checks setup/login, native
renderer isolation, graph edits against server truth, live SSE changes, drag
layout persistence, lock/unlock, source links and restart persistence. Screenshots
and measured step durations are saved under `apps/desktop/artifacts/`; timings
are observations on the machine running the check, not latency guarantees.

The Electron session/protocol design follows the upstream
[protocol API](https://www.electronjs.org/docs/latest/api/protocol),
[security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
and [performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance).

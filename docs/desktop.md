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

On first launch, the app connects to **https://yakjev-production.up.railway.app**.
Unlock with the existing owner-token form. Desktop and mobile share this default
through `@yakjev/client/config`.
Use **File → Connect to Server…** to switch servers. The app remembers the
server address. Each server has its own Chromium session and browser storage.
Source links open in your system browser.

Node colors are saved in the server graph and sync between the web browser,
desktop and mobile through the existing live updates. Color edits participate
in Undo and graph exports. **Status color** removes the explicit choice.
On first connection, each updated client imports its previously local colors
only for nodes without a saved server choice. Existing server choices win;
failed imports retain the local values for retry. See [color sync](colors.md)
for the migration and release contract.

You can also select a server when launching from a terminal:

```sh
YAKJEV_REMOTE_URL=https://your-yakjev.up.railway.app bun run desktop:start
```

`YAKJEV_URL` is an alias. Server selection is environment override, then remembered
address, then the shared production default. Never put an owner token or provider
credential in build settings.

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
bun run desktop:package:mac --dir # audited local source application
bun run desktop:package:mac       # audited local source app, ZIP, DMG
bun run desktop:package           # Windows NSIS / Linux AppImage on those hosts
```

Build on the target platform. macOS output goes into a unique directory under
`apps/desktop/release/`. Source packages have no Developer ID identity or Apple
notarization. The public CI builds and audits source packages without credentials
or artifact uploads. No command publishes a release or configures updates.

### Maintainer macOS distribution

Supply `YAKJEV_MAC_TEAM_ID` and the full `YAKJEV_MAC_SIGNING_IDENTITY` from private
local configuration. Signing certificates stay in the macOS Keychain; `asc`
uses its existing local Apple Notary API authentication. The public repository
contains no certificate identity defaults, private keys, account IDs, or auth
profiles. Never commit credentials or raw build/notarization logs.

```sh
# Commit the release source first; signed builds require a clean checkout.
bun run desktop:package:mac --sign      # Developer ID, no Apple submission
bun run desktop:package:mac --notarize  # sign, submit, staple, verify app + DMG
```

The pipeline uses frozen dependencies and the pinned Bun/Electron versions. It
compiles the shared web renderer without environment files or source maps,
packages into a fresh private directory, configures all Electron fuses, signs
with hardened runtime and minimal JIT entitlements, then independently audits
ASAR hashes, archive contents, native signatures, entitlements and fuse values.
Node execution, Node environment options, main-process inspect arguments and
extra `file:` privileges are disabled. Cookie encryption and ASAR-only loading
with integrity validation are enabled. No microphone or filesystem permission
is added for future features.

Notarization requires Apple's `Accepted` response, app ticket stapling and
Gatekeeper assessment. The ZIP is recreated with the stapled app; the DMG is
then created, signed, notarized and stapled independently. Only a completed
attempt receives a final release directory. A local `receipt.json` records the
source commit, tool versions, acceptance IDs and exact archive SHA256 hashes.
Raw logs remain private in the ignored release directory. Distribute only the
intended ZIP/DMG and reviewed checksum metadata, never the whole directory.

To install a completed release, with the same private signing configuration:

```sh
bun run desktop:install:mac --app /absolute/path/to/release/mac-arm64/Yakjev.app --notarized
```

The installer refuses a running Yakjev, audits the candidate and staged copy,
installs into `~/Applications/Yakjev.app`, and verifies the installed signature.
The previous app lives only in a private hidden staging directory during the
upgrade, without an `.app` extension. Verification failure restores it;
success removes it and the staging directory, leaving one installed app.
If cleanup fails, the verified new app remains installed and the command reports
the hidden directory for inspection with a nonzero exit. User settings and
sessions remain in place.

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
no Node integration or preload API. Only the server connection window has
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
bun apps/desktop/e2e/dev-smoke.ts # renderer HMR, after desktop:build
bun run verify        # repository checks, including desktop build/unit tests
```

The smoke check requires a graphical session. It checks setup/login, native
renderer isolation, graph edits against server truth, live SSE changes, drag
layout persistence, lock/unlock, source links and restart persistence. Screenshots
and measured step durations are saved under `apps/desktop/artifacts/`; timings
are observations on the machine running the check, not latency guarantees.

To check a packaged macOS application, use the executable path from its build:

```sh
YAKJEV_DESKTOP_EXECUTABLE="/absolute/path/to/release/mac-arm64/Yakjev.app/Contents/MacOS/Yakjev" \
  bun apps/desktop/e2e/release-smoke.ts
```

This attaches to a disposable renderer through loopback CDP;
shipping fuses keep the main-process inspector disabled. All fixture data and
sessions are synthetic and local.

App icons share the SVG source in `apps/desktop/build/icon.svg`. Regenerate the
desktop variants and the opaque 1024px mobile PNG with
`swift apps/desktop/build/generate-icons.swift` on macOS.

The Electron session/protocol design follows the upstream
[protocol API](https://www.electronjs.org/docs/latest/api/protocol),
[security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
and [performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance).

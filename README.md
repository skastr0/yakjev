# yakjev

A lasting map of intentions, dependencies, and the things that get in the way.

Capture intentions and sources, connect them in a directed graph, inspect claimed blockers, and reframe relationships without losing their original assertions. The React/Sigma workbench and MCP tools use the same SQLite graph, revision checks, history, and undo. Jev connects intentions against your editable taxonomy as you work.

**Settled stack: Effect v4, Bun 1.4 or newer stable, Sigma.js v4 beta.** Exact pins: `effect@4.0.0-rc.117`, [Bun 1.4.2](https://bun.com), `sigma@4.0.0-beta.6`, and Graphology `0.26.0`. See [architecture](docs/architecture.md).

## Run locally

```sh
bun install --frozen-lockfile
YAKJEV_DEV_AUTH=true bun run dev
```

Open **http://127.0.0.1:5173** and unlock with `synthetic-yakjev-owner-token-local-only`. This explicit development mode is limited to non-production loopback origins. The Vite proxy validates the original Host and Origin before forwarding to the API on port 3210. SQLite lives in `.data/yakjev.sqlite` (gitignored).

No provider key is required: absent `TYPESAFE_API_KEY`, evaluations are recorded as unavailable, with no fabricated judgments. Set the key server-side to enable Jev. Source URLs are pointers, not automatically fetched documents.

```sh
bun run verify  # formatting, types, server/MCP/UI tests, HTTP acceptance, build, deployment tests
bun run build
YAKJEV_DEV_AUTH=true bun run start  # built app at http://127.0.0.1:3210
```

Deployment tests also require Bash, Python 3, and curl. Native graph tests run separately with `bun run mobile:native:test` on macOS with Xcode and Swift. See `.env.example` for configuration; never commit secrets or personal graphs.

## Native clients

The [iPhone and iPad app](docs/mobile.md) lives in `apps/mobile`: Expo and React Native around a Swift/Metal graph view. Run `bun run mobile:ios` to build the native development client, then `bun run mobile:start` for Metro. Enter your existing Yakjev server URL and owner token in the app; credentials stay in the device keychain. A native build is required because Expo Go does not contain the graph module.

The [Electron desktop app](docs/desktop.md) builds the same web workbench. Both apps are clients of the existing server; neither creates another graph database.

## Repository

| Path                | Responsibility                                                 |
| ------------------- | -------------------------------------------------------------- |
| `packages/protocol` | Shared validated wire contracts                                |
| `packages/client`   | Shared HTTP transport, graph commands, Jev behavior and colors |
| `packages/server`   | Authoritative application operations and SQLite lifecycle      |
| `packages/mcp`      | Streamable HTTP tools over the shared server services          |
| `apps/web`          | React/Sigma graph, persistent inspector, capture and editing   |
| `apps/mobile`       | Expo iOS client with a native Swift/Metal graph                |
| `apps/desktop`      | Electron client using the web workbench                        |
| `tests/acceptance`  | Black-box HTTP/SSE graph-loop acceptance                       |
| `deploy`            | Railway image and synthetic deployment tests                   |
| `.agents`           | Orb setup/resume and vendored Jev skill                        |

## Amp orbs

`.agents/setup` installs the runtime, dependencies, and builds the web client. It is safe to repeat and contains no authentication. `.amp/services.yaml` declares the API and an authenticated Amp portal for the web client; run `amp orb services ensure` inside an orb. See [orb access](docs/orbs.md) for credential scopes.

The official TypeSafe skill is vendored in `.agents/skills/typesafe-ai`, with its MIT license and pinned source recorded in `THIRD_PARTY_NOTICES.md`. Clones and orbs get the same guidance without installing a global skill manager. No personal skills or private machine configuration are copied into this public repository.

## Private deployment

Public code, private graph. The deployment exposes public HTTPS on a Railway service domain; the owner token is the lock. Reads and writes require application authentication: owner-token exchange for a browser session, or owner bearer for native HTTP/MCP. Read [the deployment guide](docs/deployment.md) for configuration and credentials; see [MCP configuration](docs/mcp.md) for agent access.

**Nothing is deployed by cloning, building, running CI, or starting an orb.** Configured orbs join the tailnet on resume; this does not deploy Yakjev. Deployment, enrollment, and network grants remain separately authorized operations. Production requires `YAKJEV_OWNER_TOKEN` of at least 32 characters and rejects `YAKJEV_DEV_AUTH`.

## License

MIT. See [LICENSE](LICENSE). Third-party material retains its own notices.

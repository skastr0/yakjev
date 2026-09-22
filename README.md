# yakjev

A lasting map of intentions, dependencies, and the things that get in the way.

Capture intentions and sources, connect them in a directed graph, inspect claimed blockers, and reframe relationships without losing their original assertions. The React/Sigma workbench and MCP tools use the same SQLite graph, revision checks, history, and undo. Jev proposes connections against your editable taxonomy; it never accepts its own suggestions.

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

Deployment tests also require Bash, Python 3, and curl. See `.env.example` for configuration; never commit secrets or personal graphs.

## Repository

| Path                | Responsibility                                               |
| ------------------- | ------------------------------------------------------------ |
| `packages/protocol` | Shared validated wire contracts                              |
| `packages/server`   | Authoritative application operations and SQLite lifecycle    |
| `packages/mcp`      | Streamable HTTP tools over the shared server services        |
| `apps/web`          | React/Sigma graph, persistent inspector, capture and editing |
| `tests/acceptance`  | Black-box HTTP/SSE graph-loop acceptance                     |
| `deploy`            | Railway image, Tailscale startup, synthetic deployment tests |
| `.agents`           | Orb setup/resume and vendored Jev skill                      |

## Amp orbs

`.agents/setup` installs the runtime, dependencies, Railway/Quasar/Tailscale clients, and builds the web client. It is safe to repeat and contains no authentication. `.agents/resume` uses Amp OIDC for ephemeral tailnet access when configured. `.amp/services.yaml` declares the API and an authenticated Amp portal for the web client; run `amp orb services ensure` inside an orb. See [orb access](docs/orbs.md) for credential scopes and deployment operations.

The official TypeSafe skill is vendored in `.agents/skills/typesafe-ai`, with its MIT license and pinned source recorded in `THIRD_PARTY_NOTICES.md`. Clones and orbs get the same guidance without installing a global skill manager. No personal skills or private machine configuration are copied into this public repository.

## Private deployment

Public code, private graph. The deployment joins **your** tailnet and exposes HTTPS to permitted tailnet clients. It does not open a public Railway domain. Reads and writes require application authentication: owner-token exchange for a browser session, or owner bearer for HTTP/MCP. Read [the deployment guide](docs/deployment.md) for configuration, grants, credential lifecycle, and validation steps; see [MCP configuration](docs/mcp.md) for agent access.

**Nothing is deployed by cloning, building, running CI, or starting an orb.** Configured orbs join the tailnet on resume; this does not deploy Yakjev. Deployment, enrollment, and network grants remain separately authorized operations. Production requires `YAKJEV_OWNER_TOKEN` of at least 32 characters and rejects `YAKJEV_DEV_AUTH`.

## Product direction

Read [the entanglement graph product direction](docs/product-direction-entanglement-graph.md) for scope and acceptance, then [architecture and first milestone](docs/architecture.md). Yakjev indexes intentions and relationships over canonical sources; it does not mirror full documents or own whole-life prioritization. Authorized agents, including Amp orbs from other projects, must use the same graph as the visual interface. Keep graph facts, user policy, inference, and layout separate.

## License

MIT. See [LICENSE](LICENSE). Third-party material retains its own notices.

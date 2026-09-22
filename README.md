# yakjev

A lasting map of intentions, dependencies, and the things that get in the way.

**Status: scaffold, not a usable graph editor yet.** The repository contains a React web shell, a Bun/Effect server with SQLite health checks, CI, Amp orb setup, and a private Railway/Tailscale deployment baseline. Graph capture, Jev evaluation, and MCP editing are the next milestone.

**Settled stack: Effect v4, Bun 1.4 or newer stable, Sigma.js v4 beta.** The old scaffold pins have not been migrated yet; updating code, dependencies, setup, CI, and the deployment image is the first implementation task. Those pins are not an alternative stack decision. See [architecture](docs/architecture.md#settled-stack-migration-comes-first).

## Run the current scaffold locally

The current scaffold uses [Bun 1.3.14](https://bun.com). This is a reproduction note for the unmigrated code, not the target runtime:

```sh
bun install --frozen-lockfile
bun run dev
```

Open **http://127.0.0.1:5173**. The Vite proxy reaches the loopback API on port 3210. No API keys required. SQLite lives in `.data/yakjev.sqlite` (gitignored).

```sh
bun run verify  # formatting, types, tests, web build, deployment subprocess tests
bun run build
bun run start  # serve the built app at http://127.0.0.1:3210
```

Deployment tests also require Bash, Python 3, and curl. See `.env.example` for configuration; never commit secrets or personal graphs.

## Repository

| Path                | Responsibility                                               |
| ------------------- | ------------------------------------------------------------ |
| `packages/protocol` | Shared validated wire contracts                              |
| `packages/server`   | Authoritative application operations and SQLite lifecycle    |
| `apps/web`          | React client; future graph renderer                          |
| `deploy`            | Railway image, Tailscale startup, synthetic deployment tests |
| `.agents`           | Orb setup/resume and vendored Jev skill                      |

## Amp orbs

`.agents/setup` installs the runtime, dependencies, Railway/Quasar/Tailscale clients, and builds the web client. It is safe to repeat and contains no authentication. `.agents/resume` uses Amp OIDC for ephemeral tailnet access when configured. `.amp/services.yaml` declares the API and an authenticated Amp portal for the web client; run `amp orb services ensure` inside an orb. See [orb access](docs/orbs.md) for credential scopes and deployment operations.

The official TypeSafe skill is vendored in `.agents/skills/typesafe-ai`, with its MIT license and pinned source recorded in `THIRD_PARTY_NOTICES.md`. Clones and orbs get the same guidance without installing a global skill manager. No personal skills or private machine configuration are copied into this public repository.

## Private deployment

Public code, private graph. The planned deployment joins **your** tailnet and exposes a browser-accessible HTTPS address to permitted tailnet clients. It does not open a public Railway domain. Read [the deployment guide](docs/deployment.md) for configuration, grants, credential lifecycle, and validation steps.

**Nothing is deployed by cloning, building, running CI, or starting an orb.** Configured orbs join the tailnet on resume; this does not deploy Yakjev. Railway deployment and service enrollment remain separate operator actions. The scaffold exposes only a shell and `/healthz`, not application data or an MCP server.

## Product direction

Read [the entanglement graph product direction](docs/product-direction-entanglement-graph.md) for scope and acceptance, then [architecture and first milestone](docs/architecture.md). Yakjev indexes intentions and relationships over canonical sources; it does not mirror full documents or own whole-life prioritization. Authorized agents, including Amp orbs from other projects, must use the same graph as the visual interface. Keep graph facts, user policy, inference, and layout separate.

## License

MIT. See [LICENSE](LICENSE). Third-party material retains its own notices.

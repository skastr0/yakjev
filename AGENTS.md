# yakjev

## Product

Guilherme owns the product. The owner's current word supersedes anything written here or in `docs/`; when they disagree, follow the owner and update the doc. Do not invent product rules.

Owner direction (2026-09-22): Jev is not an on-demand action. It runs transparently as the graph is edited: while an intention is typed it shows the nodes it will connect to; on create it connects them; while a node is dragged it shows what will connect on drop; when an edge is drawn it pre-selects as much as it can. Jev connects directly, it does not propose. Corrections to its connections are captured and learned from. The graph should feel alive and beautiful.

## Stack and boundaries

- Settled stack: **Effect v4**, **Bun 1.4 or newer stable**, and **Sigma.js v4 beta** with Graphology; strict TypeScript, React/Vite, and SQLite as the authoritative graph store. Use current releases in these selected lines and pin exact versions. Effect v4 prereleases and Sigma v4 beta are deliberate choices, not reasons to fall back to older majors.
- Pinned foundation: `effect@4.0.0-rc.117`, `bun@1.4.2`, `sigma@4.0.0-beta.6`, Graphology `0.26.0`. Do not relitigate or downgrade the selected stack without an explicit user change of direction.
- The server owns graph writes. HTTP and MCP share `Store`, `Auth`, and `Evaluations`; neither owns a second database. Preserve actor-scoped replay, atomic revision checks, and the transaction journal.
- Authorized Amp orbs must be able to use Yakjev as MCP clients, including from the owner's other projects. Tailnet connectivity and application authorization are separate requirements; access to Yakjev does not grant Railway deployment authority or access to unrelated tailnet services.
- Use the checked-in TypeSafe skill when implementing Jev. Keep provider credentials server-side.
- Deployment is the Mac mini on the owner's tailnet: loopback app behind Tailscale Serve (`svc:yakjev`), launchd from `deploy/macmini`. Railway is paused. The owner token is still the lock. Keep the tailnet name out of the repository. Read `docs/deployment.md` before deployment changes.

## Workflow

- `bun install --frozen-lockfile`; `YAKJEV_DEV_AUTH=true bun run dev` for synthetic loopback development; `bun run verify` before delivery. Never set development auth in production.
- `.agents/setup` prepares orbs without authentication. `.agents/resume` connects via Amp OIDC when configured; `.amp/services.yaml` owns development processes. Runtime credentials come from Amp settings, never repository files or snapshots. See `docs/orbs.md` for deployment access.
- Tests use disposable local SQLite files and synthetic data. Verify visual changes in a rendered browser.
- Commit owned work with Conventional Commits. Push, deploy, tailnet policy changes, and production writes require task authorization.

## Anti-patterns

- ❌ Mock success or invent provider judgments. ✅ Record unavailable/failed evaluations honestly.
- ❌ Wildcard CORS, secrets in Vite, the owner token in client code, or production state in orb snapshots. ✅ Explicit origin, server-only secrets, and synthetic development data.

# yakjev

## Intent

A persistent, editable graph of intentions and claimed dependencies: an index over canonical sources, not another content store or a whole-life priority engine. Preserve the user's understanding across sessions. Original captures, assertions, machine judgments, and user overrides are distinct; recurrence is not priority. Cycles are meaningful, not invalid input.

Read `docs/product-direction-entanglement-graph.md` before product work. It owns product scope and acceptance; `docs/architecture.md` maps that direction to implementation. Full documents remain in their canonical stores. Completing or pruning a graph node never authorizes deleting its sources.

## Stack and boundaries

- Settled stack: **Effect v4**, **Bun 1.4 or newer stable**, and **Sigma.js v4 beta** with Graphology; strict TypeScript, React/Vite, and SQLite as the authoritative graph store. Use current releases in these selected lines and pin exact versions. Effect v4 prereleases and Sigma v4 beta are deliberate choices, not reasons to fall back to older majors.
- Pinned foundation: `effect@4.0.0-rc.117`, `bun@1.4.2`, `sigma@4.0.0-beta.6`, Graphology `0.26.0`. Do not relitigate or downgrade the selected stack without an explicit user change of direction.
- The server owns graph semantics and writes. HTTP and MCP share `Store`, `Auth`, and `Evaluations`; neither owns a second database or rule engine. Preserve actor-scoped replay, atomic revision checks, immutable history, and explicit suggestion acceptance.
- Authorized Amp orbs must be able to use Yakjev as MCP clients, including from the owner's other projects. Tailnet connectivity and application authorization are separate requirements; access to Yakjev does not grant Railway deployment authority or access to unrelated tailnet services.
- Use the checked-in TypeSafe skill when implementing Jev. Keep provider credentials server-side, judgments versioned, and edits reversible. Never treat confidence as permission.
- Deployment is public HTTPS on a Railway service domain. The owner token is the lock. Read `docs/deployment.md` before deployment changes.

## Workflow

- `bun install --frozen-lockfile`; `YAKJEV_DEV_AUTH=true bun run dev` for synthetic loopback development; `bun run verify` before delivery. Never set development auth in production.
- `.agents/setup` prepares orbs without authentication. `.agents/resume` connects via Amp OIDC when configured; `.amp/services.yaml` owns development processes. Runtime credentials come from Amp settings, never repository files or snapshots. See `docs/orbs.md` for deployment access.
- Tests use disposable local SQLite files and synthetic data. Verify visual changes in a rendered browser.
- Commit owned work with Conventional Commits. Push, deploy, tailnet policy changes, and production writes require task authorization.

## Anti-patterns

- ❌ Automatically merging similar ideas or deleting disputed edges. ✅ Preserve provenance and support correction.
- ❌ Re-layout everything on each update. ✅ Preserve positions and the user's mental map.
- ❌ Mock success or invent provider judgments. ✅ Record unavailable/failed evaluations honestly; verify the composed HTTP/MCP and rendered browser loop.
- ❌ Wildcard CORS, secrets in Vite, the owner token in client code, or production state in orb snapshots. ✅ Explicit origin, server-only secrets, and synthetic development data.
- ❌ Building distribution infrastructure or integrations before the graph works. ✅ Ship the smallest useful graph loop first.

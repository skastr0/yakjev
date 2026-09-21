# yakjev

## Intent

A persistent, editable graph of intentions and claimed dependencies. Preserve the user's understanding across sessions. Original captures, assertions, machine judgments, and user overrides are distinct; recurrence is not priority. Cycles are meaningful, not invalid input.

## Stack and boundaries

- Bun 1.3.14, strict TypeScript, Effect services and schemas, SQLite as the authoritative store, React/Vite for the client. Sigma.js/Graphology is the planned renderer, not implemented yet.
- The server owns graph semantics and writes. Future HTTP and MCP surfaces share operations; neither owns a second database or rule engine.
- Use the checked-in TypeSafe skill when implementing Jev. Keep provider credentials server-side, judgments versioned, and edits reversible. Never treat confidence as permission.
- Deployment is private Tailscale Serve HTTPS to a loopback app on Railway. Public source does not mean public user data. Read `docs/deployment.md` before deployment changes.

## Workflow

- `bun install --frozen-lockfile`; `bun run dev`; `bun run verify` before delivery.
- `.agents/setup` prepares orbs without authentication. `.agents/resume` connects via Amp OIDC when configured; `.amp/services.yaml` owns development processes. Runtime credentials come from Amp settings, never repository files or snapshots. See `docs/orbs.md` for deployment access.
- Tests use disposable local SQLite files and synthetic data. Verify visual changes in a rendered browser.
- Commit owned work with Conventional Commits. Push, deploy, tailnet policy changes, and production writes require task authorization.

## Anti-patterns

- ❌ Automatically merging similar ideas or deleting disputed edges. ✅ Preserve provenance and support correction.
- ❌ Re-layout everything on each update. ✅ Preserve positions and the user's mental map.
- ❌ Mock success for unimplemented features. ✅ This is a scaffold; graph editing, Jev calls, and MCP are still pending.
- ❌ Public domains, Funnel, wildcard CORS, secrets in Vite, or production state in orb snapshots. ✅ Private ingress, explicit origins, server-only secrets, and synthetic development data.
- ❌ Building distribution infrastructure or integrations before the graph works. ✅ Ship the smallest useful graph loop first.

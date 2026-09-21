# Architecture and first milestone

## Product model

One long-lived graph, amended rather than reconstructed each day. Capture the unfiltered chain, preserve why a relation was asserted, and make recurrence and downstream consequences visible. A larger node means repeated attention, not an instruction to prioritize it.

Dependencies can be necessary, preferred preparation, or expansion, judged against the user's own versioned definitions. A relationship carries that judgment: the same node can be necessary for one intention and unnecessary for another. Keep uncertainty and overrides visible.

## Implementation direction (not yet implemented)

- Browser: React interface around Sigma.js and Graphology; layout in a worker, saved positions, pinning, focus on upstream/downstream neighborhoods. Overview and executable branches are views of the same graph. Benchmark dense as well as sparse data.
- Server: one Bun/Effect runtime and SQLite store. Atomic validated edits with optimistic revision checks, idempotent agent requests, undo, provenance, and streamed updates to connected clients.
- Agent interface: MCP exposes the same operations as HTTP. An existing agent can translate dictated text into proposed edits; built-in transcription is not a prerequisite.
- Jev: typed choices/scores/probabilities over relevant state and explicit criteria. Preserve source text, model/rule versions, and results; stale inference must not overwrite newer edits. No free-form generation or assumed infallibility.
- Deployment: single instance, private Tailscale HTTPS, persistent volume. Network grants do not replace application authorization when real data or write endpoints are introduced.

## First usable loop

Capture → persistent graph → Jev relationship evaluation → focus a knot → edit/complete → inspect what becomes unblocked. Include search, manual edits, undo, export, and restart persistence.

Before enabling writes, define ownership, authentication for browser and MCP clients, same-origin/CSRF enforcement, and revision conflicts. Do not trust client-supplied Tailscale identity headers. Authorized orbs reach the deployment using ephemeral Tailscale identities and scoped grants; agents without access do not receive a public bypass. Local development data stays separate from production.

Acceptance: capture a real task tangle, stop and restart the application, recover the same understanding, and observe agent edits in the browser without reloading. The current scaffold does **not** meet that acceptance test yet.

Deferred: Quasar ingestion, automatic cross-harness tracking, multi-user collaboration, advanced opportunity-cost scoring, and custom GPU rendering infrastructure.

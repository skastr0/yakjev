# Architecture and first milestone

The [product direction](product-direction-entanglement-graph.md) owns scope and acceptance. This document describes the technical direction, not implemented capabilities. Product changes supersede earlier scaffold assumptions.

## Settled stack; migration comes first

Use **Effect v4**, **Bun 1.4 or newer stable**, and **Sigma.js v4 beta** with Graphology. Prereleases in the chosen Effect and Sigma lines are intentional. Do not substitute Effect v3 or Sigma v3 because an unqualified package `latest` tag points there.

On 2026-09-22, the published channel heads were `effect@rc` = `4.0.0-rc.117`, `bun@latest` = `1.4.2`, and `sigma@beta` = `4.0.0-beta.6`. Resolve the current releases within the selected lines when migrating and pin exact versions for reproducible builds.

The checked-in scaffold still uses Effect 3.21.2 and Bun 1.3.14, with no renderer installed. These are obsolete implementation pins, not alternatives to the settled stack. The first implementation change must consolidate dependencies, Effect APIs, runtime setup/resume, CI, and Docker onto the chosen stack and run the full verification suite. This decision record does not claim that migration has already happened.

## Product model

One long-lived graph, amended rather than reconstructed each day. Yakjev indexes intentions and relationships; full documents remain in Notion, repositories, session archives, or their other canonical stores. Nodes retain concise descriptions and source references. Graph history, edge rationale, classifications, and corrections belong to Yakjev; source documents do not become a second editable copy here.

Capture the unfiltered chain, preserve why a relation was asserted, and make recurrence and downstream consequences visible. An idea is not a commitment. Proximity is not dependency, and recurrence is not priority. Preserve cycles and the distinction between assertions, suggestions, evidence, and user corrections.

Relationship semantics are the central product. The product direction's candidate taxonomy is not yet a locked schema; Jev applies explicit, versioned user definitions to edges. The same node can be necessary for one intention and optional for another. Reframing a prerequisite must retain its rationale and history, and later agent submissions must not silently restore the superseded assertion.

## Implementation direction (not yet implemented)

- Browser: React interface around Sigma.js v4 beta and Graphology; layout in a worker, saved positions, pinning, focus on upstream/downstream neighborhoods. Overview and blocking neighborhoods are views of the same graph. Benchmark dense as well as sparse data.
- Server: one Bun/Effect v4 runtime and SQLite graph store. Atomic validated edits with optimistic revision checks, idempotent agent requests, undo, provenance, and streamed updates to connected clients.
- Agent interface: MCP exposes the same operations as HTTP. An authorized agent captures nodes, sources, and relationships from an active session; prose awaiting manual graph construction is not capture. Built-in transcription and exhaustive Quasar ingestion are not prerequisites.
- Jev: typed choices/scores/probabilities over relevant state and explicit criteria. Preserve source text, model/rule versions, and results; stale inference must not overwrite newer edits. No free-form generation or assumed infallibility.
- Deployment: single instance, private Tailscale HTTPS, persistent volume. Network grants do not replace application authorization when real data or write endpoints are introduced.

## Cross-project agent access

Amp orbs are clients of Yakjev, not only its development environment. The owner's projects must be able to capture into and retrieve relevant neighborhoods from the same graph while preserving project identity and provenance. Access must not depend on working in the Yakjev repository.

Keep three boundaries separate: OIDC enrollment allows an orb to join the tailnet; a narrow network grant allows HTTPS to Yakjev; application authorization controls graph reads and edits. Client projects do not need Railway credentials, the server enrollment key, or access to unrelated tailnet services. The shared enrollment mechanism, MCP credential flow, and permission model still need implementation decisions; this requirement does not authorize blanket tailnet grants. See [orb access](orbs.md).

## First usable loop

Capture → connect → see → expand → reframe → recover a path forward. Include Jev relationship evaluation, search, manual edits, undo, export, and restart persistence. Changing a blocking interpretation does not claim the real-world task is complete; graph cleanup does not authorize source deletion.

Before enabling writes, define ownership, authentication for browser and MCP clients, same-origin/CSRF enforcement, and revision conflicts. Do not trust client-supplied Tailscale identity headers. Authorized orbs reach the deployment using ephemeral Tailscale identities and scoped grants; agents without access do not receive a public bypass. Local development data stays separate from production.

Acceptance is the [first-version scenario](product-direction-entanglement-graph.md#first-version-acceptance-scenario): capture a real bounded tangle through an authorized agent, observe live edits, inspect and reframe a prerequisite, then recover the same sources, relationships, layout, and correction after restart. Undo and stale agent submissions must respect revision history. The current scaffold does **not** meet that acceptance test yet.

Deferred: exhaustive Quasar ingestion, automatic cross-harness tracking, multi-user collaboration, and custom GPU rendering infrastructure. Whole-life prioritization, scheduling, financial models, and automatic execution are outside Yakjev's product boundary, not prerequisites for a later milestone.

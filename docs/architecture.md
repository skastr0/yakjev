# Architecture

The [product direction](product-direction-entanglement-graph.md) owns scope and acceptance. The server owns graph semantics; the browser and MCP are clients of the same operations and SQLite store.

## Settled stack

Use **Effect v4**, **Bun 1.4 or newer stable**, and **Sigma.js v4 beta** with Graphology. Prereleases in the chosen Effect and Sigma lines are intentional. Do not substitute Effect v3 or Sigma v3 because an unqualified package `latest` tag points there.

On 2026-09-22, the published channel heads were `effect@rc` = `4.0.0-rc.117`, `bun@latest` = `1.4.2`, and `sigma@beta` = `4.0.0-beta.6`. Resolve the current releases within the selected lines when migrating and pin exact versions for reproducible builds.

The implementation pins `effect@4.0.0-rc.117`, `bun@1.4.2`, and `sigma@4.0.0-beta.6` with Graphology `0.26.0`. Setup, resume, CI, and the deployment image use the same Bun pin.

## Product model

One long-lived graph, amended rather than reconstructed each day. Yakjev indexes intentions and relationships; full documents remain in Notion, repositories, session archives, or their other canonical stores. Nodes retain concise descriptions and source references. Graph history, edge rationale, classifications, and corrections belong to Yakjev; source documents do not become a second editable copy here.

Capture the unfiltered chain, preserve why a relation was asserted, and make recurrence and downstream consequences visible. An idea is not a commitment. Proximity is not dependency, and recurrence is not priority. Preserve cycles and the distinction between assertions, suggestions, evidence, and user corrections.

The editable initial taxonomy is `requires`, `benefits_from`, `possible_solution`, `related_to`, and `expands_into`. Every definition has explicit criteria and a blocking flag. A directed edge `A → B` means A bears the stated relation to B: for `requires`, A claims B as a prerequisite. An edge blocks only when it is asserted, its current taxonomy definition is blocking, and neither endpoint is done or archived. Cycles remain valid.

Reframing retains the original assertion and records a correction. `edge.put` cannot silently replace an existing pair. Suggestions have separate provenance and pending/accepted/rejected/superseded states; accepting one is an explicit command. Changes to relevant endpoints or taxonomy invalidate suggestions, while unrelated edits do not.

## One store and one operation layer

- `packages/protocol`: Effect schemas for graph snapshots, commands, receipts, history, and evaluation envelopes.
- `packages/server`: `Store`, `Auth`, `Discovery`, and `Evaluations` services, composed once by `createApp`. HTTP and MCP share these instances.
- `packages/mcp`: Streamable HTTP `/mcp`; `graph_read`, `graph_command`, `graph_discover`, and `graph_evaluate`. No parallel persistence or graph engine.
- `apps/web`: three-pane React workbench, directed Sigma/Graphology renderer, explicit worker layout, saved positions and pinning, capture/source editing, inspector, taxonomy, history, and Jev review.

SQLite stores a current graph document and an immutable transaction journal. A command includes `requestId` and `expectedRevision`. Validation, graph evolution, the revision increment, and journal append commit atomically. Identical actor-scoped replay returns the original receipt before checking the now-stale revision; changing its payload conflicts. Undo creates a new revision and only reverts the current revision, so an intervening edit cannot be erased accidentally.

SSE streams bounded journal receipts rather than whole graphs or raw evaluations. The client reconciles snapshots after changes while retaining draft edits and unsaved positions. Ordinary edits do not trigger layout. `layout.set` patches only the named positions.

Graph snapshots hold evaluation summaries. Full input audit, probabilities, provider output, prompt/model/taxonomy versions, and failures remain in the immutable evaluation journal entry, accessible through `/api/evaluations/:id` and MCP. Export includes the graph and complete journal. This avoids copying large provider results into every layout undo image; before-images still grow with graph size.

## Discovery proposes; it does not assert

Candidate retrieval is deterministic lexical and graph-neighborhood selection, capped at 24 nodes with explicit coverage/truncation. Small graphs receive full coverage. Jev then reranks candidates semantically and classifies relation and direction against the supplied taxonomy. This is not a global semantic index. Source URLs are unfetched pointers; only supplied context participates.

`Evaluations.evaluate` serializes requests, checks durable replay before invoking the provider, and commits through the same revision guard as other edits. A concurrent graph change refuses the result rather than applying stale inference. Re-evaluate against the new graph. Rejected or corrected pairs are protected in both directions. Missing credentials and provider errors are recorded as unavailable/failed results, not invented judgments. No result automatically creates an assertion.

## Cross-project agent access

Amp orbs are clients of Yakjev, not only its development environment. The owner's projects must be able to capture into and retrieve relevant neighborhoods from the same graph while preserving project identity and provenance. Access must not depend on working in the Yakjev repository.

The first version has one owner. Bearer credentials produce a server-derived actor; identity headers and actor arguments are not trusted. The browser exchanges the owner token for a signed, expiring HttpOnly/SameSite=Strict cookie (`Secure` and `__Host-` on HTTPS). Cookie mutations require exact Origin. MCP accepts bearer only. Host and Origin checks run before request dispatch. Production rejects synthetic dev auth. The public Railway domain is the ingress; the owner token is the lock. See [MCP configuration](mcp.md).

## First usable loop

Capture → connect → see → expand → reframe → recover a path forward. Include Jev relationship evaluation, search, manual edits, undo, export, and restart persistence. Changing a blocking interpretation does not claim the real-world task is complete; graph cleanup does not authorize source deletion.

`bun run verify` checks formatting, types, package/UI behavior, black-box HTTP/SSE acceptance against disposable SQLite, the production web build, and synthetic deployment/resume branches. Optional `packages/server/scripts/smoke-jev-http.ts` exercises a real provider over loopback TCP with synthetic input; `--unavailable` checks missing-key behavior. Browser acceptance and private deployment health require separate runtime checks, not inference from a successful build.

Product acceptance remains the [first-version scenario](product-direction-entanglement-graph.md#first-version-acceptance-scenario): capture a bounded tangle through an authorized agent, observe live edits, inspect and reframe a prerequisite, then recover sources, relationships, layout, and correction after restart. Synthetic automation verifies mechanics; it does not establish the truth of real-world dependencies or substitute for the owner's judgment.

Deferred: exhaustive Quasar ingestion, automatic cross-harness tracking, multi-user collaboration, and custom GPU rendering infrastructure. Whole-life prioritization, scheduling, financial models, and automatic execution are outside Yakjev's product boundary, not prerequisites for a later milestone.

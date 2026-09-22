# Architecture

This document describes how the code works today. Product direction comes from the owner (see `AGENTS.md`), not from this file. The server owns graph writes; the browser and MCP are clients of the same operations and SQLite store.

## Settled stack

Use **Effect v4**, **Bun 1.4 or newer stable**, and **Sigma.js v4 beta** with Graphology. Prereleases in the chosen Effect and Sigma lines are intentional. Do not substitute Effect v3 or Sigma v3 because an unqualified package `latest` tag points there.

On 2026-09-22, the published channel heads were `effect@rc` = `4.0.0-rc.117`, `bun@latest` = `1.4.2`, and `sigma@beta` = `4.0.0-beta.6`. Resolve the current releases within the selected lines when migrating and pin exact versions for reproducible builds.

The implementation pins `effect@4.0.0-rc.117`, `bun@1.4.2`, and `sigma@4.0.0-beta.6` with Graphology `0.26.0`. Setup, resume, CI, and the deployment image use the same Bun pin.

## Graph model

One long-lived graph. Nodes hold a title, description, status, project, and source references. The editable taxonomy starts as `requires`, `benefits_from`, `possible_solution`, `related_to`, and `expands_into`; each definition has criteria and a blocking flag. A directed edge `A → B` means A bears the stated relation to B. Suggestions carry pending/accepted/rejected/superseded states. `edge.reframe` records a correction on an existing edge.

## One store and one operation layer

- `packages/protocol`: Effect schemas for graph snapshots, commands, receipts, history, and evaluation envelopes.
- `packages/server`: `Store`, `Auth`, `Discovery`, and `Evaluations` services, composed once by `createApp`. HTTP and MCP share these instances.
- `packages/mcp`: Streamable HTTP `/mcp`; `graph_read`, `graph_command`, `graph_discover`, and `graph_evaluate`. No parallel persistence or graph engine.
- `apps/web`: three-pane React workbench, directed Sigma/Graphology renderer, explicit worker layout, saved positions and pinning, capture/source editing, inspector, taxonomy, and history.

SQLite stores a current graph document and an immutable transaction journal. A command includes `requestId` and `expectedRevision`. Validation, graph evolution, the revision increment, and journal append commit atomically. Identical actor-scoped replay returns the original receipt before checking the now-stale revision; changing its payload conflicts. Undo creates a new revision and only reverts the current revision, so an intervening edit cannot be erased accidentally. `node.remove`, `edge.remove`, and `capture.remove` delete current-state entities under the same atomic revision check; the journal keeps their full history, so removal never deletes provenance or sources. Removing an edge supersedes its pending proposals, and removing a corrected or disputed edge records the pair as rejected so inference cannot silently reinstate it.

SSE streams bounded journal receipts rather than whole graphs or raw evaluations. The client reconciles snapshots after changes while retaining draft edits and unsaved positions. Ordinary edits do not trigger layout. `layout.set` patches only the named positions.

Graph snapshots hold evaluation summaries. Full input audit, probabilities, provider output, prompt/model/taxonomy versions, and failures remain in the immutable evaluation journal entry, accessible through `/api/evaluations/:id` and MCP. Export includes the graph and complete journal. This avoids copying large provider results into every layout undo image; before-images still grow with graph size.

## Jev

Jev runs as the graph is edited; there is no "ask" step.

- **Preview** (`POST /api/jev/preview`, `Evaluations.preview`): judges a draft (text being typed) or an existing node against up to 24 candidates and returns, per candidate, relatedness, match, same-intention, relation and direction, and the server's `connect` decision. Nothing is journaled. The browser uses it while typing, while dragging, and when a link is drawn.
- **Connect policy** (`discovery.ts`): connect when the candidate restates the same intention (linked as `related_to`), or when Jev matches it, names a relation, and rates it at least directly relevant; never a suppressed pair or an already linked pair; at most `MAX_CONNECTIONS`, strongest first.
- **Auto-connect** (`Evaluations.command`): every capture from any channel is connected in the background by the `jev` system actor unless it says `autoConnect: false` (the browser sends its previewed edges itself). The evaluation audit and the edges commit in one revision; a concurrent edit retries against the new graph. Failures leave no trace.
- **Learning**: Jev edges carry `origin` (model, prompt version, confidence, same). Reframing one records a correction; removing one suppresses the pair and records a `jev-edge-removed` rejection. Both are sent to Jev as `ownerCorrections`, precedent for later judgments.

Retrieval (`retrieval.ts`) ranks every eligible node: explicit ids and graph neighbours first, then Synthetic nomic embeddings fused with word overlap (lexical only without `SYNTHETIC_API_KEY`). On graphs over 24 nodes, a coarse Jev pass rates the top 480 with one question each, and the packer (`shortlist()` in `discovery.ts`) keeps the best-first prefix up to a ~26k-token soft target under Jev's 64k/32k/128 KB limits.

Known limit (2026-09-22): the live 1,000-node paraphrase test (`bun run jev:retrieval --jev-rerank`, about 330 near-duplicate traps per target) recalls 2 of 3. The miss reaches the coarse window but not the packed set, likely because coarse ratings are relative within each batch. The proposed next step is a single side-by-side re-rating of the coarse top ~60. Source URLs are unfetched pointers; only supplied context participates. Missing credentials and provider errors produce unavailable/failed results, never invented judgments.

## Cross-project agent access

Amp orbs are clients of Yakjev, not only its development environment. The owner's projects must be able to capture into and retrieve relevant neighborhoods from the same graph while preserving project identity and provenance. Access must not depend on working in the Yakjev repository.

The first version has one owner. Bearer credentials produce a server-derived actor; identity headers and actor arguments are not trusted. The browser exchanges the owner token for a signed, expiring HttpOnly/SameSite=Strict cookie (`Secure` and `__Host-` on HTTPS). Cookie mutations require exact Origin. MCP accepts bearer only. Host and Origin checks run before request dispatch. Production rejects synthetic dev auth. The public Railway domain is the ingress; the owner token is the lock. See [MCP configuration](mcp.md).

## Verification

`bun run verify` checks formatting, types, package/UI behavior, black-box HTTP/SSE acceptance against disposable SQLite, the production web build, and synthetic deployment/resume branches. Optional `packages/server/scripts/smoke-jev-http.ts` exercises a real provider over loopback TCP with synthetic input; `--unavailable` checks missing-key behavior. Browser acceptance and private deployment health require separate runtime checks, not inference from a successful build.

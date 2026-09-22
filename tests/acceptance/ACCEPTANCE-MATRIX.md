# Acceptance matrix

Maps the product requirements to the check that verifies them. Maintained by the
product/E2E reviewer. A requirement is only marked verified when a real run
produced a receipt; "not yet" means the surface does not exist.

Source documents: `docs/product-direction-entanglement-graph.md` (owns scope and
acceptance) and `docs/architecture.md` (maps direction to implementation).

## First-version scenario (product direction, "First-version acceptance scenario")

| # | Requirement | Verified by | Status |
| --- | --- | --- | --- |
| 1 | Capture idea, work context, and asserted dependency chain through an authorized agent interface | `graph-loop.test.ts` "capture persists nodes, sources, asserted edges, and capture provenance"; `browser/run.ts` E1 | not yet |
| 2 | Persist source references; distinguish asserted edges from suggested connections | `graph-loop.test.ts` "capture persists…" and "suggestions stay distinct from assertions"; `browser/run.ts` E3 | not yet |
| 3 | Observe edits in the graph without manual reconstruction or reload | `browser/run.ts` E1, E1b (same canvas instance, camera preserved) | not yet |
| 4 | Expand the delayed task's dependencies and inspect their rationale | `browser/run.ts` E4; `neighborhood` assertions in `graph-loop.test.ts` | not yet |
| 5 | Reframe a prerequisite as optional preparation, keeping the idea and edit history | `graph-loop.test.ts` "reframe to optional…"; `browser/run.ts` E5 | not yet |
| 6 | Show the changed blocking interpretation without claiming the real-world task is complete | `graph-loop.test.ts` reframe test (blockingEdges no longer contains the edge) | not yet |
| 7 | Restart, return, and recover the same nodes, relationships, layout, and correction | `graph-loop.test.ts` "positions, search, and export survive a restart…"; `browser/run.ts` E7 | not yet |
| 8 | Undo the edit; later agent submissions must respect revisions and not silently undo it | `graph-loop.test.ts` "undo restores…" and "a reframed pair cannot be silently restored" | not yet |

## Relationship semantics (product direction, "Relationship semantics are the central product")

| Requirement | Verified by | Status |
| --- | --- | --- |
| Proximity suggests a connection; it does not establish a dependency | suggestion tests: recording creates no edge | not yet |
| Original capture, assertion, machine judgment, and user correction stay distinct | `graph-loop.test.ts` provenance assertions; `browser/run.ts` E3 | not yet |
| Cycles are preserved as meaningful evidence, not rejected | "a mutual entanglement is preserved and reported as a cycle" | not yet |
| The same idea may be necessary for one outcome and optional for another | reframe test: original assertion retained alongside the correction | not yet |
| Confidence is not permission; an inferred edge is not established truth | suggestion tests plus Jev module review (see below) | not yet |
| Taxonomy edits do not silently erase previous reasoning or override a correction | not covered yet: needs a taxonomy.replace acceptance test | not yet |

## Architecture requirements

| Requirement | Verified by | Status |
| --- | --- | --- |
| One authoritative store; HTTP and MCP share operations | `graph-loop.test.ts` (HTTP); MCP parity is the security reviewer's protocol work plus my E2E round trip | not yet |
| Atomic validated edits with optimistic revision checks | "stale expectedRevision is rejected…" | not yet |
| Idempotent agent requests | "idempotent replay returns the original receipt…" | not yet |
| Undo, provenance, history retained without compaction | "undo restores…", `history`/`export` assertions | not yet |
| Streamed updates to connected clients | "the change stream delivers a receipt…" | not yet |
| Sources and captures are never mutated by node edits | "node edits never mutate captures or sources…" | not yet |
| Archived nodes keep valid references | same test | not yet |
| Writes fail closed without a credential | "graph reads and writes fail closed…" | not yet |

## Product-boundary checks that must stay false

These are anti-patterns from `AGENTS.md`; a pass here means the bad thing did not
happen.

| Anti-pattern | Check |
| --- | --- |
| Automatically merging similar ideas | suggestion recording must not create an edge or change node count |
| Deleting disputed edges | reframe keeps `assertion` and adds `correction`; undo restores rather than deletes |
| Re-laying out everything on each update | `browser/run.ts` E1b canvas identity plus localized canvas change |
| Mock success for unimplemented features | every step reports blocked/fail; no silent skips |
| Public exposure | `deploy/tests/run.sh` (funnel-refused, public-domain) plus the security reviewer's scope |

## Not yet verifiable, and why

- **Real provider calls (Jev)**: needs provider credentials, which stay server-side.
  I reproduce the credential-free behavior only and report the owner's receipts as
  their receipts.
- **MCP round trip from another project's orb**: needs the deployed instance and an
  authorized client; planned as a read-only smoke after deployment.
- **Deployed-instance smoke**: read-only checks only, after the parent deploys.

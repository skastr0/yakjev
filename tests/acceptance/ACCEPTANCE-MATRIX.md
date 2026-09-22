# Acceptance matrix

Maps the product requirements to the check that verifies them. Maintained by the
product/E2E reviewer. A requirement is only marked verified when a real run
produced a receipt; "not yet" means the surface does not exist.

Source documents: `docs/product-direction-entanglement-graph.md` (owns scope and
acceptance) and `docs/architecture.md` (maps direction to implementation).

## First-version scenario (product direction, "First-version acceptance scenario")

| #   | Requirement                                                                                     | Verified by                                                                                                         | Status   |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Capture idea, work context, and asserted dependency chain through an authorized agent interface | `graph-loop.test.ts` "capture persists nodes, sources, asserted edges, and capture provenance"; `browser/run.ts` E1 | verified |
| 2   | Persist source references; distinguish asserted edges from suggested connections                | `graph-loop.test.ts` "capture persists…" and "suggestions stay distinct from assertions"; `browser/run.ts` E3       | verified |
| 3   | Observe edits in the graph without manual reconstruction or reload                              | `browser/run.ts` E1, E1b (same canvas instance, camera preserved)                                                   | verified |
| 4   | Expand the delayed task's dependencies and inspect their rationale                              | `browser/run.ts` E4; `neighborhood` assertions in `graph-loop.test.ts`                                              | verified |
| 5   | Reframe a prerequisite as optional preparation, keeping the idea and edit history               | `graph-loop.test.ts` "reframe to optional…"; `browser/run.ts` E5                                                    | verified |
| 6   | Show the changed blocking interpretation without claiming the real-world task is complete       | `graph-loop.test.ts` reframe test (blockingEdges no longer contains the edge)                                       | verified |
| 7   | Restart, return, and recover the same nodes, relationships, layout, and correction              | `graph-loop.test.ts` "positions, search, and export survive a restart…"; `browser/run.ts` E7                        | verified |
| 8   | Undo the edit; later agent submissions must respect revisions and not silently undo it          | `graph-loop.test.ts` "undo restores…" and "a reframed pair cannot be silently restored"                             | verified |

## Relationship semantics (product direction, "Relationship semantics are the central product")

| Requirement                                                                      | Verified by                                                                                        | Status   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| Proximity suggests a connection; it does not establish a dependency              | suggestion tests: recording creates no edge                                                        | verified |
| Original capture, assertion, machine judgment, and user correction stay distinct | `graph-loop.test.ts` provenance assertions; `browser/run.ts` E3                                    | verified |
| Cycles are preserved as meaningful evidence, not rejected                        | "a mutual entanglement is preserved and reported as a cycle"                                       | verified |
| The same idea may be necessary for one outcome and optional for another          | reframe test: original assertion retained alongside the correction                                 | verified |
| Confidence is not permission; an inferred edge is not established truth          | suggestion tests plus Jev module review (see below)                                                | verified |
| Taxonomy edits do not silently erase previous reasoning or override a correction | `graph-loop.test.ts` "taxonomy edits version the definitions without erasing edges or corrections" | verified |

## Architecture requirements

| Requirement                                            | Verified by                                                                                             | Status   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------- |
| One authoritative store; HTTP and MCP share operations | `graph-loop.test.ts` (HTTP); MCP parity is the security reviewer's protocol work plus my E2E round trip | verified |
| Atomic validated edits with optimistic revision checks | "stale expectedRevision is rejected…"                                                                   | verified |
| Idempotent agent requests                              | "idempotent replay returns the original receipt…"                                                       | verified |
| Undo, provenance, history retained without compaction  | "undo restores…", `history`/`export` assertions                                                         | verified |
| Streamed updates to connected clients                  | "the change stream delivers a receipt…"                                                                 | verified |
| Sources and captures are never mutated by node edits   | "node edits never mutate captures or sources…"                                                          | verified |
| Archived nodes keep valid references                   | same test                                                                                               | verified |
| Writes fail closed without a credential                | "graph reads and writes fail closed…"                                                                   | verified |

## Product-boundary checks that must stay false

These are anti-patterns from `AGENTS.md`; a pass here means the bad thing did not
happen.

| Anti-pattern                            | Check                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Automatically merging similar ideas     | suggestion recording must not create an edge or change node count                        |
| Deleting disputed edges                 | reframe keeps `assertion` and adds `correction`; undo restores rather than deletes       |
| Re-laying out everything on each update | `browser/run.ts` E1b canvas identity plus localized canvas change                        |
| Mock success for unimplemented features | every step reports blocked/fail; no silent skips                                         |
| Public exposure                         | `deploy/tests/run.sh` (funnel-refused, public-domain) plus the security reviewer's scope |

## How the loop was verified

`bun tests/acceptance` drives the real server over HTTP and SSE; `bun tests/acceptance/browser/run.ts`
drives the rendered app with Chromium and inspects screenshots. Latest run on this orb
(published main + backend-next + UI checkpoint): 17 HTTP tests / 125 assertions pass, and 11 of 12
browser steps pass with 0 blocked.

Observed in the rendered loop: capture receipt to rendered node 2.7s for five nodes and five
asserted edges; the canvas element is preserved across live updates; expanding the delayed work
reports "Claimed prerequisites remain in this neighborhood; these claims are not verified facts.";
reframing changes the blocking interpretation while the original assertion stays inspectable; undo
restores it; a restart recovers revision, positions, and the correction; an evaluation without a
provider key is recorded as unavailable with no suggestion.

## Acceptance findings after the UI final patch

Verified on the integrated tree (published base + parent integration series + this suite + UI final,
commit ee444406442dd9769517959872ad04e0a88c89d1). `bun run verify` exit 0: 41 package tests, 20
acceptance tests (149 assertions), 13 deployment checks, 4 resume checks. Browser run: 12 pass,
1 fail, 0 blocked.

| Finding                                                                                                                                                    | Status                         | Evidence                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Default camera after a live capture rendered the graph cramped with overlapping labels                                                                     | fixed                          | five of five labels legible at default after a live capture; canvas change 5.6%; `final-01-after-capture.png` |
| Contrast below WCAG AA on `.tagline`, `.node-list > .hint`, `.sidebar-foot > p`                                                                            | fixed                          | axe no longer reports these                                                                                   |
| `aria-label` on `div.graph-actions` without a role                                                                                                         | fixed                          | axe no longer reports `aria-prohibited-attr`                                                                  |
| Contrast below AA on `.node-card small` (project and status meta)                                                                                          | open, minor, with the UI owner | 4.22 (#637565 on #efeee4) and 4.00 on the selected card background #e6e9df, 10px normal, needs 4.5:1          |
| Arrange with six nodes (the five-node fixture plus an unconnected intention) leaves the isolated node as an outlier and collapses the five connected nodes | open, with the UI owner        | found by the parent on the final workbench; parent artifact `workbench-final-parent-arranged.png`             |
| One edge label truncated to "Re" where it meets the `Multi-machine skills blocker` label                                                                   | open, cosmetic                 | `final-01-after-capture.png`                                                                                  |

Not findings: axe reports 15 `incomplete` colour-contrast nodes (the `○` status glyphs and text over
the canvas). Axe cannot measure those; they are unverified, not failures.

Narrow layout measured at 390x844: `scrollWidth` 390 = `innerWidth` 390 (no horizontal overflow),
`graphBottom` 1059 = `inspectorTop` 1059 (inspector stacked with no gap), and the node list scrolls
clear of the sticky footer (last card bottom 381.98 above footer top 387 after scrolling).

## Correction: the 401/403 observation was stale

An earlier note of mine reported that a credential-less `POST /api/commands` with no Origin returned
403 `Forbidden origin`. That was measured against the backend checkpoint before the composed server.
On the current tree it returns 401 `Owner authentication required`, and 403 only with a foreign
Origin, because the cookie path short-circuits with 401 when no cookie is present, before the origin
check runs. The security reviewer reached the same conclusion independently. The suite now asserts
401 for the credential-less write and 403 for the foreign-origin write, and the earlier note to
backend is superseded.

## Deployment

Not verified. No deployed instance has been exercised; the read-only deploy smoke
(`deploy-smoke.ts`) runs only after the parent deploys, and this document must not claim otherwise.

## Not yet verifiable, and why

- **Real provider calls (Jev)**: needs provider credentials, which stay server-side.
  I reproduce the credential-free behavior only and report the owner's receipts as
  their receipts.
- **MCP round trip from another project's orb**: needs the deployed instance and an
  authorized client; planned as a read-only smoke after deployment.
- **Deployed-instance smoke**: read-only checks only, after the parent deploys.

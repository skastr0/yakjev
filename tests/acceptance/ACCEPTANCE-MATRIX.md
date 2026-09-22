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

`bun test tests/acceptance` drives the real server over HTTP, MCP, and SSE;
`bun tests/acceptance/browser/run.ts` drives the rendered app with Chromium and records screenshots
for inspection. The final composed run passed 20 acceptance tests / 149 assertions and all 14
browser steps with 0 blocked. The counts below refer to that composition, not earlier checkpoints.

Observed in the rendered loop: capture receipt to rendered node 2.7s for five nodes and five
asserted edges; the canvas element is preserved across live updates; expanding the delayed work
reports "Claimed prerequisites remain in this neighborhood; these claims are not verified facts.";
reframing changes the blocking interpretation while the original assertion stays inspectable; undo
restores it; a restart recovers revision, positions, and the correction; an evaluation without a
provider key is recorded as unavailable with no suggestion.

## Acceptance status after the UI polish patch

Verified on the integrated tree: published base, parent integration series, this suite, UI final,
and UI polish. `bun run verify` exited 0: 41 package tests, 20 acceptance tests (149 assertions),
13 deployment checks, and 4 resume checks.

Browser run: **14 steps, 14 pass, 0 fail, 0 blocked.**

| Check                                                               | Result                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Login surface, rejected token, no client-side token storage         | pass                                                                                      |
| HTTP capture live without reload                                    | revision 1, receipt to rendered node 2949ms, canvas +5.1%                                 |
| MCP capture live without reload                                     | revision 3, receipt to rendered node 791ms, canvas +2292px, channel `mcp`                 |
| Canvas instance preserved across live updates                       | pass                                                                                      |
| Edge rationale, original assertion, reframe reachable               | pass                                                                                      |
| Suggestion as a proposal; explicit acceptance creates the assertion | pass                                                                                      |
| Expand reports the blocking interpretation honestly                 | "Claimed prerequisites remain in this neighborhood; these claims are not verified facts." |
| Arrange with an unconnected intention                               | positions saved for every node; layout inspected, spread with no overlap                  |
| Reframe changes blocking, original assertion retained               | revision 7 -> 8                                                                           |
| Undo restores the blocking interpretation                           | pass                                                                                      |
| Restart recovers revision, positions, correction                    | pass                                                                                      |
| Evaluation without a provider key                                   | recorded unavailable, no suggestion                                                       |
| Narrow layout at 390px                                              | no horizontal overflow                                                                    |
| Accessibility                                                       | axe-core 4.12.1: 0 violations                                                             |

Findings from earlier rounds and the remaining cosmetic limit:

| Finding                                                                    | Status         | Evidence                                                                                                           |
| -------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Default camera rendered the graph cramped with overlapping labels          | closed         | five of five labels legible at default; `polish-01-after-capture.png`                                              |
| Contrast below AA on `.tagline`, `.node-list > .hint`, `.sidebar-foot > p` | closed         | axe reports 0 violations                                                                                           |
| Contrast below AA on `.node-card small` and other metadata text            | closed         | axe reports 0 violations; metadata colour now #566853                                                              |
| `aria-label` on `div.graph-actions` without a role                         | closed         | axe no longer reports `aria-prohibited-attr`                                                                       |
| Edge label truncated to "Re" where it meets a node label                   | cosmetic limit | Can recur in a selected 1280px fit; endpoints and the full relation remain inspectable in the connection inspector |
| Six-node Arrange collapsed the connected cluster                           | closed         | arranged layout spread with no overlap; `polish-04b-arranged.png`                                                  |

Axe still reports `incomplete` colour-contrast items, which are the `○` status glyphs, gradient fills,
and text drawn over the canvas. Axe cannot measure those; they are unverified, not failures. The UI
owner's selected-inspector run reports 40 passes, 0 violations, and the same class of unmeasurable
items.

The Arrange step measures rendered node discs from canvas pixels (nodes share one colour, so
overlapping discs merge into larger blobs). It reports distinct discs and merged blobs against the
node count and requires one separate disc per node with no merged blobs. Missing discs can also
mean clipping or label occlusion, so the capture remains necessary to diagnose a failure.
On the pre-polish capture the geometric classifier reports 3 distinct discs and 2 merged blobs for
8 nodes; the final capture has 8 distinct discs and 0 merged blobs. Components below 400 pixels are
excluded as text or antialiasing noise. This corrects the earlier area-band classifier's undercount
of one merged blob; that version still caught the original collapse but could miss fully overlapped
nodes. Both primary captures were checked again with the corrected classifier.

Narrow layout measured at 390x844: `scrollWidth` 390 = `innerWidth` 390, `graphBottom` = `inspectorTop`,
and the node list scrolls clear of the sticky footer.

## Correction: the 401/403 observation was stale

An earlier note of mine reported that a credential-less `POST /api/commands` with no Origin returned
403 `Forbidden origin`. That was measured against the backend checkpoint before the composed server.
On the current tree a credential-less write with no Origin or the exact Origin returns 401
`Owner authentication required`. A foreign Origin returns 403 even without credentials.
The security reviewer reached the same conclusion independently. The suite now asserts
401 for the credential-less write and 403 for the foreign-origin write, and the earlier note to
backend is superseded.

## Deployment

Public HTTPS on the Railway service domain. The owner token is the lock. Private network ingress is not part of this deploy.

## Not yet verifiable, and why

- **Real provider calls (Jev)**: needs provider credentials, which stay server-side.
  I reproduce the credential-free behavior only and report the owner's receipts as
  their receipts.
- **MCP round trip from another project's orb**: needs the deployed instance and an
  authorized client; blocked on private ingress from the orbs.
- **Deployed-instance smoke**: attempted after deployment; blocked at name resolution.

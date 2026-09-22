# Product direction: make the entanglement visible and editable

## Status and purpose

This document captures Guilherme's product direction developed with ARIA. It is a handoff for the team shaping the next version, not a claim that these capabilities are implemented or a complete technical specification. Read alongside `docs/architecture.md`.

**Yakjev is the yak-shaving graph, not the full context of life's priorities.** It preserves intentions and their relationships so that Guilherme can see, inspect, and reframe entanglements that are difficult to consolidate mentally.

## The problem

“What should I do now?” can expand into an enormous graph of possibilities, prerequisites, and prerequisites of prerequisites. A small task can remain delayed because it has become mentally chained to a large system-building effort. The relationships are often implicit, and a helpful improvement can quietly become an absolute prerequisite.

Ideas also represent real intellectual effort: context, reasoning, scoping, and alternatives. Losing those means reconstructing work. Quasar preserves conversations, but recovering the relevant understanding and reconnecting it remains a separate operation. Adding another note, dashboard, or inbox that requires later manual reconciliation creates another chore rather than continuity.

The need is not simply fewer items. It is an external, persistent representation of the relationships, available for correction. An idea must be preservable without becoming a commitment to implement it.

## Product boundary

### In scope

- A persistent, editable graph of ideas, intentions, work, claimed dependencies, and blockers.
- Original context and source references, including links to AI sessions and captured reasoning.
- Keyword proximity and semantic connections that help discover related material across projects.
- Tight Jev integration against a bespoke, user-defined taxonomy.
- Live graph updates as authorized users and agents submit captures and edits.
- Expansion of dependency neighborhoods to reveal why work is stuck.
- Reframing, disputing, or removing blocking force from relationships without losing the underlying ideas.
- Stable, resumable understanding across sessions.

### Out of scope

- Financial accounts, bills, cash-flow models, or payment processing.
- Calendars, capacity scheduling, or a whole-life priority engine.
- A universal task manager or autonomous software factory.
- Mandatory orbit stages, extensive model choreography, or automatic execution of captured ideas.
- Requiring a new recurring review chore from Guilherme.

Other systems may reference Yakjev node IDs and use its relationships. They own financial facts, schedules, prioritization, and execution. Yakjev may reference external work without importing those systems' full domain models.

## Core interaction

**Capture → connect → see → expand → reframe → recover a path forward.**

1. Hand off an idea, dependency, blocker, or chain of reasoning from the current conversation or work session.
2. Preserve the meaningful reasoning and scope, not merely a generated title.
3. Identify existing related nodes and propose relationships without silently merging distinct ideas.
4. Show the evolving graph in real time, with stable positions and a navigable neighborhood.
5. Expand the blocking edges of a delayed piece of work.
6. Inspect why each edge exists and whether it is actually necessary.
7. Reframe the relationship and see which claimed constraints no longer block the work.
8. Return later to the same understanding, including sources and corrections, rather than reconstructing it.

Capture must not depend on first determining whether an idea is useful, procrastination, or harmful. The graph provides material for that judgment; it does not pretend to know motives.

## Relationship semantics are the central product

**Proximity suggests a connection; it does not establish a dependency.**

The following are candidate distinctions for the bespoke taxonomy, not a locked schema:

- Requires: a claimed necessary prerequisite.
- Would benefit from: useful preparation or improvement, not a hard blocker.
- Possible solution to: a hypothesis about addressing a problem.
- Related to: shared context without a prerequisite claim.
- Expands into: added scope or a branch of exploration.

Relationship evaluation belongs on the edge. The same idea may be necessary for one outcome and optional for another. Preserve cycles as meaningful evidence of entanglement rather than rejecting them as invalid input.

Separate:

- Original capture and the user's assertion.
- Machine-proposed connection or judgment.
- Supporting evidence and uncertainty.
- User correction or override.

Jev should apply explicit, versioned user criteria. Keyword recurrence is not priority, model confidence is not permission, and an inferred edge is not established truth. Changes to the taxonomy should not silently erase previous reasoning or override a user's correction.

## Worked example: this idea and Vouch

The idea of human-owned work inboxes might become connected to Vouch through a proposed chain:

> Vouch work → needs delegation → needs human-owned inboxes → needs Yakjev implemented.

This is an illustrative hypothesis, **not a verified dependency of Vouch**.

The graph should make it possible to inspect the crucial relation: does the particular Vouch outcome require the inbox system, or would the system make repeated work easier?

Reframing “requires” as “would benefit from” removes the claimed prerequisite without deleting the inbox idea. Preserve why the original edge existed, why it changed, and who changed it. Later ingestion or another agent must not silently reinstate the old dependency as current truth.

That is the desired value: a small task stops carrying the weight of an entire proposed system, while the intellectual work remains available.

## Ideas accumulating around problems

Recurring concepts such as “can't delegate” or “stuck open loops” can help locate clusters. Several ideas may connect as possible interventions for the same problem; one idea may address several problems.

Support both directions:

- From a problem: what proposed interventions and related work exist?
- From an idea: what might it address, and what evidence supports those relationships?

This is an opportunities map, not an automatic ranking. Do not equate frequency of discussion, graph centrality, visual size, or enthusiasm with importance. Keep cross-project relationships discoverable while preserving project identity and provenance.

## Continuity, not another pile

Working/hot/cold distinctions describe attention and processing, not disconnected containers the user must maintain. Preserved material may remain inactive while still connected and retrievable. Capturing an idea does not promise execution or force it into the current working set.

For the first version, agent-assisted capture from an active session is sufficient; exhaustive automatic Quasar ingestion is not a prerequisite. However, the handoff must actually persist nodes, sources, and relationships. Merely writing a prose note and expecting future manual graph construction does not satisfy this direction.

HTTP, MCP, and the visual interface should operate on the same authoritative graph. The user must be able to inspect and correct what agents propose. External assistants can retrieve relevant neighborhoods for a work session; Yakjev need not become the global assistant or scheduling system to provide that context.

## First-version acceptance scenario

Use a real, bounded task tangle chosen with Guilherme:

1. Capture its idea, work context, and asserted dependency chain through an authorized agent interface.
2. Persist source references and distinguish asserted edges from suggested connections.
3. Observe those edits in the graph without manually reconstructing the graph or reloading the page.
4. Expand the delayed task's dependencies and inspect their rationale.
5. Reframe a purported prerequisite as optional preparation, retaining the idea and edit history.
6. Show the changed blocking interpretation without claiming that the real-world task is complete.
7. Restart and return in another session; recover the same nodes, relationships, layout, and correction.
8. Undo the edit if needed. Subsequent agent submissions must respect revisions and not silently undo it.

**Success: Guilherme sees a real knot, corrects its structure, and recovers a path forward that was difficult to see mentally.**

## Decisions for the product team

Resolve these during implementation rather than treating this handoff as an invented specification:

- The initial bespoke taxonomy and how Guilherme edits its definitions.
- How suggested connections differ visually and operationally from accepted assertions.
- How captures map to existing nodes without destructive automatic merging.
- Edge direction, blocking interpretation, and behavior around cycles.
- Minimum context required to resume an idea without loading an entire transcript.
- Versioning, authorization, conflict handling, undo, and propagation of user corrections.

Keep the first milestone centered on the usable graph loop. Neither a full priority engine nor extensive integration infrastructure is required to demonstrate the benefit.

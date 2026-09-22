import {
  type Actor,
  type Command,
  type Edge,
  type Graph,
  type JevOrigin,
  type Neighborhood,
  type Node,
  type Provenance,
  type SuggestionInput,
} from "@yakjev/protocol";
import { Data, Effect, Schema } from "effect";
import { createHash } from "node:crypto";

export class DomainError extends Data.TaggedError("DomainError")<{
  readonly code: "Invalid" | "NotFound" | "Conflict";
  readonly message: string;
  readonly currentRevision?: number;
}> {}

const fail = (code: DomainError["code"], message: string) =>
  Effect.fail(new DomainError({ code, message }));

// A correction or rejected judgment protects both directions from implicit inference.
// An explicit revision-checked reframe is still available to every authorized caller.
export function inferenceSuppressed(
  graph: Graph,
  source: string,
  target: string,
) {
  const pair = (item: { source: string; target: string }) =>
    (item.source === source && item.target === target) ||
    (item.source === target && item.target === source);
  return (
    graph.edges.some((edge) => pair(edge) && edge.correction !== null) ||
    graph.suggestions.some((item) => pair(item) && item.status === "rejected")
  );
}

export function suggestionStale(graph: Graph, suggestion: SuggestionInput) {
  return (
    suggestion.taxonomyVersion !== graph.taxonomy.version ||
    !graph.nodes.some((node) => node.id === suggestion.source) ||
    !graph.nodes.some((node) => node.id === suggestion.target) ||
    graph.nodes.some(
      (node) =>
        (node.id === suggestion.source || node.id === suggestion.target) &&
        node.updated.revision > suggestion.basedOnRevision,
    ) ||
    graph.edges.some(
      (edge) =>
        ((edge.source === suggestion.source &&
          edge.target === suggestion.target) ||
          (edge.source === suggestion.target &&
            edge.target === suggestion.source)) &&
        edge.updated.revision > suggestion.basedOnRevision,
    ) ||
    inferenceSuppressed(graph, suggestion.source, suggestion.target)
  );
}

export function supersedeSuggestions(graph: Graph): Graph {
  return {
    ...graph,
    suggestions: graph.suggestions.map((suggestion) =>
      suggestion.status === "pending" && suggestionStale(graph, suggestion)
        ? { ...suggestion, status: "superseded" }
        : suggestion,
    ),
  };
}

export const evolve = Effect.fn("Graph.evolve")(function* (
  graph: Graph,
  command: Exclude<Command, { type: "undo" }>,
  actor: Actor,
  at: string,
) {
  const provenance: typeof Provenance.Type = {
    actor,
    at,
    revision: graph.revision + 1,
  };
  let nodes = [...graph.nodes];
  let edges = [...graph.edges];
  let captures = [...graph.captures];
  let suggestions = [...graph.suggestions];
  let evaluations = [...graph.evaluations];
  let taxonomy = graph.taxonomy;
  const relationExists = (id: string) =>
    taxonomy.relations.some((relation) => relation.id === id);
  const nodeExists = (id: string) => nodes.some((node) => node.id === id);
  const addEdge = Effect.fnUntraced(function* (input: {
    id: string;
    source: string;
    target: string;
    relation: string;
    rationale: string;
    origin?: JevOrigin;
  }) {
    if (!nodeExists(input.source) || !nodeExists(input.target))
      return yield* fail("NotFound", "Both edge endpoints must exist");
    if (!relationExists(input.relation))
      return yield* fail("Invalid", "Unknown relationship type");
    if (
      edges.some(
        (edge) =>
          edge.id === input.id ||
          (edge.source === input.source && edge.target === input.target),
      )
    )
      return yield* fail(
        "Conflict",
        "An assertion for this directed pair already exists; explicitly reframe it",
      );
    const { origin, ...claim } = input;
    edges.push({
      ...claim,
      ...(origin ? { origin } : {}),
      state: "asserted",
      assertion: {
        relation: input.relation,
        rationale: input.rationale,
        provenance,
      },
      correction: null,
      updated: provenance,
    });
  });
  // Removing an edge can leave suppression behind: a rejected record for the
  // pair keeps machine inference from silently restoring a deliberate removal.
  // Tombstones are rejected records, never pending, so missing endpoints do
  // not supersede them — protection survives re-registered node ids.
  const suppressPair = (
    removed: Edge,
    via: "edge.remove" | "node.remove",
    key: string,
    rationale: string | undefined,
  ) => {
    const pair = (item: { source: string; target: string }) =>
      (item.source === removed.source && item.target === removed.target) ||
      (item.source === removed.target && item.target === removed.source);
    const alreadySuppressed =
      edges.some((edge) => pair(edge) && edge.correction !== null) ||
      suggestions.some(
        (suggestion) => pair(suggestion) && suggestion.status === "rejected",
      );
    if (alreadySuppressed) return;
    // An owner removing Jev's own connection is a correction Jev learns from.
    const jevRemoved = via === "edge.remove" && removed.origin !== undefined;
    let id = `suppressed-r${provenance.revision}${key === "" ? "" : `-${key}`}`;
    // Persisted suggestions decode through the 128-char Id schema on every
    // read: hash long edge ids rather than wedge the store. A bare slice
    // could collide between same-prefix edges in one revision.
    if (id.length > 128)
      id = `suppressed-r${provenance.revision}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
    suggestions.push({
      id,
      source: removed.source,
      target: removed.target,
      relation: removed.relation,
      rationale:
        rationale ??
        `Suppressed when edge ${removed.id} (${removed.source}→${removed.target}) was removed`,
      confidence: null,
      evidence: [],
      model: jevRemoved ? removed.origin!.model : "actor-suppression",
      promptVersion: jevRemoved ? "jev-edge-removed" : via,
      taxonomyVersion: taxonomy.version,
      basedOnRevision: graph.revision,
      status: "rejected",
      provenance,
      decision: provenance,
    });
  };
  const recordSuggestion = Effect.fnUntraced(function* (
    input: SuggestionInput,
  ) {
    if (
      input.basedOnRevision !== graph.revision ||
      input.taxonomyVersion !== taxonomy.version
    )
      return yield* fail(
        "Conflict",
        "Inference observed an older graph or taxonomy",
      );
    if (!nodeExists(input.source) || !nodeExists(input.target))
      return yield* fail("NotFound", "Unknown suggestion endpoint");
    if (!relationExists(input.relation))
      return yield* fail("Invalid", "Unknown relationship type");
    if (suggestions.some((suggestion) => suggestion.id === input.id))
      return yield* fail("Conflict", "Suggestion already exists");
    if (inferenceSuppressed(graph, input.source, input.target))
      return yield* fail(
        "Conflict",
        "A correction or rejection suppresses inference for this pair",
      );
    if (
      (input.evaluationId || input.inputHash) &&
      !evaluations.some(
        (evaluation) =>
          evaluation.id === input.evaluationId &&
          evaluation.inputHash === input.inputHash,
      )
    )
      return yield* fail(
        "Invalid",
        "Suggestion must reference its recorded evaluation",
      );
    suggestions.push({
      ...input,
      status: "pending",
      provenance,
      decision: null,
    });
  });

  switch (command.type) {
    case "capture": {
      if (captures.some((capture) => capture.id === command.capture.id))
        return yield* fail("Conflict", "Capture already exists");
      for (const input of command.nodes) {
        if (nodeExists(input.id))
          return yield* fail(
            "Conflict",
            "Capture creates new nodes only; refer to existing nodes by nodeIds",
          );
        nodes.push({
          ...input,
          position: null,
          created: provenance,
          updated: provenance,
        });
      }
      for (const input of command.edges) yield* addEdge(input);
      if (command.capture.nodeIds.some((id) => !nodeExists(id)))
        return yield* fail("NotFound", "Capture references an unknown node");
      captures.push({ ...command.capture, provenance });
      break;
    }
    case "capture.remove": {
      if (!captures.some((capture) => capture.id === command.id))
        return yield* fail("NotFound", "Unknown capture");
      captures = captures.filter((capture) => capture.id !== command.id);
      break;
    }
    case "node.put": {
      const old = nodes.find((node) => node.id === command.node.id);
      const node: Node = {
        ...command.node,
        position: old?.position ?? null,
        created: old?.created ?? provenance,
        updated: provenance,
      };
      nodes = old
        ? nodes.map((item) => (item.id === node.id ? node : item))
        : [...nodes, node];
      break;
    }
    case "node.remove": {
      const missing = command.ids.filter((id) => !nodeExists(id));
      if (missing.length > 0)
        return yield* fail("NotFound", `Unknown nodes: ${missing.join(", ")}`);
      const removed = new Set(command.ids);
      const incident = edges.filter(
        (edge) => removed.has(edge.source) || removed.has(edge.target),
      );
      if (incident.length > 0 && command.removeEdges !== true)
        return yield* fail(
          "Conflict",
          `Incident edges must be removed first or cascaded: ${incident.map((edge) => edge.id).join(", ")}. Re-send with removeEdges: true.`,
        );
      edges = edges.filter(
        (edge) => !(removed.has(edge.source) || removed.has(edge.target)),
      );
      nodes = nodes.filter((node) => !removed.has(node.id));
      // Cascaded corrections and disputes keep their suppression, same as
      // edge.remove's default; plain cascaded assertions leave no trace.
      for (const edge of incident)
        if (edge.correction !== null || edge.state === "disputed")
          suppressPair(edge, "node.remove", edge.id, command.rationale);
      break;
    }
    case "edge.put":
      yield* addEdge(command.edge);
      break;
    case "edge.remove": {
      let found: Edge | undefined;
      if (command.id !== undefined) {
        found = edges.find((edge) => edge.id === command.id);
        if (
          found &&
          ((command.source !== undefined && found.source !== command.source) ||
            (command.target !== undefined && found.target !== command.target))
        )
          return yield* fail(
            "Invalid",
            "id disagrees with the given source or target",
          );
      } else if (command.source !== undefined && command.target !== undefined) {
        found = edges.find(
          (edge) =>
            edge.source === command.source && edge.target === command.target,
        );
      } else {
        return yield* fail(
          "Invalid",
          "edge.remove requires an id or a directed source and target",
        );
      }
      if (!found) return yield* fail("NotFound", "Unknown edge");
      const removed = found;
      edges = edges.filter((edge) => edge.id !== removed.id);
      // A pending proposal for exactly this claim dies with it; the reverse
      // direction and unrelated pairs are untouched.
      suggestions = suggestions.map((suggestion) =>
        suggestion.status === "pending" &&
        suggestion.source === removed.source &&
        suggestion.target === removed.target
          ? { ...suggestion, status: "superseded" as const }
          : suggestion,
      );
      // Corrected or disputed claims keep their suppression once the edge that
      // carried it is gone; plain assertions stay removable without a trace.
      const suppress =
        command.suppress ??
        (removed.correction !== null ||
          removed.state === "disputed" ||
          removed.origin !== undefined);
      if (suppress) suppressPair(removed, "edge.remove", "", command.rationale);
      break;
    }
    case "edge.reframe": {
      if (!edges.some((edge) => edge.id === command.id))
        return yield* fail("NotFound", "Unknown edge");
      if (!relationExists(command.relation))
        return yield* fail("Invalid", "Unknown relationship type");
      const correction = {
        relation: command.relation,
        rationale: command.rationale,
        state: command.state,
        provenance,
      };
      edges = edges.map((edge) =>
        edge.id === command.id
          ? { ...edge, ...correction, correction, updated: provenance }
          : edge,
      );
      break;
    }
    case "layout.set": {
      const ids = new Set(command.positions.map((position) => position.id));
      if (ids.size !== command.positions.length)
        return yield* fail("Invalid", "Duplicate layout node");
      if (command.positions.some((position) => !nodeExists(position.id)))
        return yield* fail("NotFound", "Unknown layout node");
      nodes = nodes.map((node) => {
        const position = command.positions.find((item) => item.id === node.id);
        if (!position) return node;
        return {
          ...node,
          position:
            "clear" in position
              ? null
              : {
                  x: position.x,
                  y: position.y,
                  pinned: position.pinned,
                },
        };
      });
      break;
    }
    case "taxonomy.replace": {
      const ids = new Set(command.relations.map((relation) => relation.id));
      if (ids.size !== command.relations.length)
        return yield* fail("Invalid", "Duplicate relationship type");
      const referenced = [
        ...edges.flatMap((edge) => [edge.relation, edge.assertion.relation]),
        ...suggestions.map((suggestion) => suggestion.relation),
      ];
      if (referenced.some((id) => !ids.has(id)))
        return yield* fail(
          "Conflict",
          "Referenced relationship types cannot be removed",
        );
      taxonomy = {
        version: taxonomy.version + 1,
        relations: command.relations,
      };
      break;
    }
    case "suggestion.record": {
      yield* recordSuggestion(command.suggestion);
      break;
    }
    case "evaluation.record": {
      const evaluation = command.evaluation;
      if (
        evaluation.basedOnRevision !== graph.revision ||
        evaluation.taxonomyVersion !== taxonomy.version
      )
        return yield* fail(
          "Conflict",
          "Inference observed an older graph or taxonomy",
        );
      if (evaluations.some((item) => item.id === evaluation.id))
        return yield* fail("Conflict", "Evaluation already exists");
      const { status } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          status: Schema.Literals(["succeeded", "failed", "unavailable"]),
        }),
      )(evaluation.result).pipe(
        Effect.mapError(
          () =>
            new DomainError({
              code: "Invalid",
              message: "Evaluation requires a status",
            }),
        ),
      );
      const { result: _, ...summary } = evaluation;
      evaluations.push({ ...summary, status, provenance });
      for (const suggestion of command.suggestions) {
        if (
          suggestion.evaluationId !== evaluation.id ||
          suggestion.inputHash !== evaluation.inputHash
        )
          return yield* fail(
            "Invalid",
            "Batch suggestion must identify its evaluation",
          );
        yield* recordSuggestion(suggestion);
        if (command.connect !== true) continue;
        // Jev connects directly: the record is accepted and the edge exists in
        // this same revision. A pair that gained an edge meanwhile is skipped.
        suggestions = suggestions.map((item) =>
          item.id === suggestion.id
            ? { ...item, status: "accepted" as const, decision: provenance }
            : item,
        );
        if (
          edges.some(
            (edge) =>
              (edge.source === suggestion.source &&
                edge.target === suggestion.target) ||
              (edge.source === suggestion.target &&
                edge.target === suggestion.source),
          )
        )
          continue;
        yield* addEdge({
          id: suggestion.id,
          source: suggestion.source,
          target: suggestion.target,
          relation: suggestion.relation,
          rationale: suggestion.rationale,
          origin: {
            model: suggestion.model,
            promptVersion: suggestion.promptVersion,
            confidence: suggestion.confidence,
            ...(suggestion.same ? { same: true } : {}),
          },
        });
        edges = edges.map((edge) =>
          edge.id === suggestion.id
            ? { ...edge, suggestionId: suggestion.id }
            : edge,
        );
      }
      break;
    }
    case "suggestion.decide": {
      const suggestion = suggestions.find((item) => item.id === command.id);
      if (!suggestion) return yield* fail("NotFound", "Unknown suggestion");
      if (suggestion.status !== "pending")
        return yield* fail("Conflict", "Suggestion already decided");
      if (command.decision === "accept") {
        if (suggestionStale(graph, suggestion))
          return yield* fail(
            "Conflict",
            "Suggestion is stale; explicitly reframe or evaluate again",
          );
        const existing = edges.find(
          (edge) =>
            edge.source === suggestion.source &&
            edge.target === suggestion.target,
        );
        if (existing) {
          // Accept is an explicit, revision-checked correction, not inference applying itself.
          const correction = {
            relation: suggestion.relation,
            rationale: command.rationale,
            state: "asserted" as const,
            provenance,
          };
          edges = edges.map((edge) =>
            edge.id === existing.id
              ? {
                  ...edge,
                  relation: correction.relation,
                  rationale: correction.rationale,
                  state: correction.state,
                  correction,
                  updated: provenance,
                  suggestionId: suggestion.id,
                }
              : edge,
          );
        } else {
          yield* addEdge({
            id: suggestion.id,
            source: suggestion.source,
            target: suggestion.target,
            relation: suggestion.relation,
            rationale: command.rationale,
          });
          edges = edges.map((edge) =>
            edge.id === suggestion.id
              ? { ...edge, suggestionId: suggestion.id }
              : edge,
          );
        }
      }
      suggestions = suggestions.map((item) =>
        item.id === suggestion.id
          ? {
              ...item,
              status: command.decision === "accept" ? "accepted" : "rejected",
              decision: provenance,
            }
          : item,
      );
      break;
    }
    default: {
      // New Command members must name their semantics here, never no-op.
      const exhaustive: never = command;
      return yield* fail("Invalid", `Unknown command ${exhaustive}`);
    }
  }
  return supersedeSuggestions({
    revision: provenance.revision,
    nodes,
    edges,
    captures,
    suggestions,
    evaluations,
    taxonomy,
  });
});

export function searchNodes(graph: Graph, query: string): readonly Node[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return graph.nodes
    .filter((node) => {
      const text =
        `${node.title} ${node.description} ${node.project}`.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, 100);
}

export const neighborhood = Effect.fn("Graph.neighborhood")(function* (
  graph: Graph,
  root: string,
  direction: "outgoing" | "incoming" | "both" = "outgoing",
  blocking = false,
) {
  if (!graph.nodes.some((node) => node.id === root))
    return yield* fail("NotFound", "Unknown node");
  const inactive = new Set(
    graph.nodes
      .filter((node) => node.status === "done" || node.status === "archived")
      .map((node) => node.id),
  );
  const blockingTypes = new Set(
    graph.taxonomy.relations
      .filter((relation) => relation.blocking)
      .map((relation) => relation.id),
  );
  const isBlocking = (edge: Edge) =>
    edge.state === "asserted" &&
    blockingTypes.has(edge.relation) &&
    !inactive.has(edge.source) &&
    !inactive.has(edge.target);
  const eligible = graph.edges.filter((edge) => !blocking || isBlocking(edge));
  const visited = new Set([root]);
  const included = new Set<string>();
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const edge of eligible) {
      const next =
        direction !== "incoming" && edge.source === current
          ? edge.target
          : direction !== "outgoing" && edge.target === current
            ? edge.source
            : undefined;
      if (next === undefined) continue;
      included.add(edge.id);
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  const edges = eligible.filter((edge) => included.has(edge.id));
  // Kahn's algorithm detects directed cycles without recursion or mistaking a diamond for a cycle.
  const degree = new Map([...visited].map((id) => [id, 0]));
  for (const edge of edges)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  const ready = [...visited].filter((id) => degree.get(id) === 0);
  let processed = 0;
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    processed++;
    for (const edge of edges.filter((item) => item.source === id)) {
      const count = degree.get(edge.target)! - 1;
      degree.set(edge.target, count);
      if (count === 0) ready.push(edge.target);
    }
  }
  const blockingEdges = edges.filter(isBlocking).map((edge) => edge.id);
  return {
    root,
    revision: graph.revision,
    nodes: graph.nodes.filter((node) => visited.has(node.id)),
    edges,
    blockingEdges,
    cycleDetected: processed !== visited.size,
    interpretation:
      blockingEdges.length > 0
        ? "Claimed prerequisites remain in this neighborhood; these claims are not verified facts."
        : "No active claimed prerequisites in this view; this does not establish real-world completion.",
  } satisfies Neighborhood;
});

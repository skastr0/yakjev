import { MultiDirectedGraph } from "graphology";
import type { Graph } from "@yakjev/protocol";
import { initialPosition, nodeColor } from "@yakjev/client/graph-model";

export * from "@yakjev/client/graph-model";

// Graphology is a render projection only. SQLite snapshots remain authoritative.
// Reconcile in-place: no clear(), no layout restart, no camera reset on events.
export function syncGraph(
  target: MultiDirectedGraph,
  data: Graph,
  placed?: ReadonlyMap<string, { x: number; y: number }>,
  colors?: {
    nodes: ReadonlyMap<string, string>;
    edges: ReadonlyMap<string, string>;
  },
) {
  const nodes = new Set(data.nodes.map((node) => node.id));
  const saved = data.nodes.flatMap((node) =>
    node.position ? [node.position] : [],
  );
  for (const id of target.nodes()) if (!nodes.has(id)) target.dropNode(id);
  for (const node of data.nodes) {
    const existing = target.hasNode(node.id);
    const position =
      placed?.get(node.id) ??
      node.position ??
      (existing
        ? {
            x: target.getNodeAttribute(node.id, "x") as number,
            y: target.getNodeAttribute(node.id, "y") as number,
          }
        : initialPosition(node.id, saved));
    target.mergeNode(node.id, {
      x: position.x,
      y: position.y,
      label: node.title,
      size: 12,
      color: colors?.nodes.get(node.id) ?? nodeColor(node.status),
      fixed: placed ? false : (node.position?.pinned ?? false),
      status: node.status,
    });
  }
  const edges = new Set([
    ...data.edges.map((edge) => edge.id),
    ...data.suggestions
      .filter((s) => s.status === "pending")
      .map((s) => `suggestion:${s.id}`),
  ]);
  for (const id of target.edges()) if (!edges.has(id)) target.dropEdge(id);
  for (const edge of data.edges) {
    const relation = data.taxonomy.relations.find(
      (item) => item.id === edge.relation,
    );
    const corrected = edge.correction !== null;
    const disputed = edge.state === "disputed";
    const attributes = {
      source: edge.source,
      target: edge.target,
      label: `${disputed ? "Disputed · " : corrected ? "Corrected · " : ""}${relation?.label ?? edge.relation}`,
      color:
        colors?.edges.get(edge.id) ??
        (disputed ? "#92998c" : relation?.blocking ? "#ab653e" : "#668477"),
      size: 1.5,
      suggestion: false,
    };
    if (
      target.hasEdge(edge.id) &&
      (target.source(edge.id) !== edge.source ||
        target.target(edge.id) !== edge.target)
    )
      target.dropEdge(edge.id);
    target.mergeDirectedEdgeWithKey(
      edge.id,
      edge.source,
      edge.target,
      attributes,
    );
  }
  for (const suggestion of data.suggestions.filter(
    (item) => item.status === "pending",
  )) {
    if (!nodes.has(suggestion.source) || !nodes.has(suggestion.target))
      continue;
    const label =
      data.taxonomy.relations.find((r) => r.id === suggestion.relation)
        ?.label ?? suggestion.relation;
    target.mergeDirectedEdgeWithKey(
      `suggestion:${suggestion.id}`,
      suggestion.source,
      suggestion.target,
      {
        source: suggestion.source,
        target: suggestion.target,
        label: `Suggestion · ${label}`,
        color: colors?.edges.get(`suggestion:${suggestion.id}`) ?? "#9b88a6",
        size: 1,
        suggestion: true,
      },
    );
  }
}

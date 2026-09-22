import { MultiDirectedGraph } from "graphology";
import type { Graph, Node } from "@yakjev/protocol";

export type Selection = {
  kind: "node" | "edge" | "suggestion";
  id: string;
} | null;
export type LayoutPosition = {
  id: string;
  x: number;
  y: number;
  pinned: boolean;
};

// Seed new nodes within the saved layout's coordinate scale, without moving
// existing nodes. Stable for the same ID and persisted positions, not array order.
export function initialPosition(
  id: string,
  saved: readonly { x: number; y: number }[] = [],
) {
  let hash = 2166136261;
  for (const char of id)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const angle = (hash % 6283) / 1000;
  const radius = 80 + ((hash >>> 12) % 240);
  const bounds = layoutBounds(saved);
  const span = Math.max(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]);
  return {
    x:
      (bounds.x[0] + bounds.x[1]) / 2 + (Math.cos(angle) * radius * span) / 800,
    y:
      (bounds.y[0] + bounds.y[1]) / 2 + (Math.sin(angle) * radius * span) / 800,
  };
}

export function layoutBounds(positions: readonly { x: number; y: number }[]): {
  x: [number, number];
  y: [number, number];
} {
  if (positions.length === 0) return { x: [-400, 400], y: [-400, 400] };
  if (positions.length === 1) {
    const point = positions[0]!;
    return {
      x: [point.x - 200, point.x + 200],
      y: [point.y - 200, point.y + 200],
    };
  }
  const xs = positions.map((point) => point.x);
  const ys = positions.map((point) => point.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  // Fit in the layout's own units. ForceAtlas2 coordinates can be much smaller
  // than the initial fallback, or far from zero when a user pins a node.
  return {
    x: minX === maxX ? [minX - 0.5, maxX + 0.5] : [minX, maxX],
    y: minY === maxY ? [minY - 0.5, maxY + 0.5] : [minY, maxY],
  };
}

export function safeSourceHref(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    return ["https:", "http:"].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function nodeColor(status: Node["status"]) {
  if (status === "active") return "#1d4a3c";
  if (status === "done" || status === "archived") return "#a4ada1";
  return "#386253";
}

// Archived nodes leave the drawing. The derived layout then follows what is shown.
export function visibleGraph(graph: Graph, showArchived: boolean): Graph {
  if (showArchived) return graph;
  const nodes = graph.nodes.filter((node) => node.status !== "archived");
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    ),
    suggestions: graph.suggestions.filter(
      (item) => ids.has(item.source) && ids.has(item.target),
    ),
  };
}

export function searchNodes(nodes: readonly Node[], query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return nodes.filter((node) => {
    const text =
      `${node.title} ${node.description} ${node.project} ${node.sources.map((s) => `${s.label} ${s.uri}`).join(" ")}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

// Graphology is a render projection only. SQLite snapshots remain authoritative.
// Reconcile in-place: no clear(), no layout restart, no camera reset on events.
export function syncGraph(
  target: MultiDirectedGraph,
  data: Graph,
  placed?: ReadonlyMap<string, { x: number; y: number }>,
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
      color: nodeColor(node.status),
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
      color: disputed ? "#92998c" : relation?.blocking ? "#ab653e" : "#668477",
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
        color: "#9b88a6",
        size: 1,
        suggestion: true,
      },
    );
  }
}

import { MultiDirectedGraph } from "graphology";
import type { Graph, Node, PreviewJudgment } from "@yakjev/protocol";

// Screen pixels, not graph units: dragging toward a node is the gesture, at
// whatever zoom the owner is using.
export const DRAG_REACH = 200;

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

// Unpainted nodes take their status color, so these are the colors most of the
// graph wears. They mirror palette entries on purpose: three vivid, well-apart
// hues that read as a progression rather than three shades of the same mud.
// Kept as literals because blend.ts imports this module; importing back would
// close a cycle.
export function nodeColor(status: Node["status"]) {
  if (status === "active") return "#e35b00"; // orange, in flight
  if (status === "done" || status === "archived") return "#159b05"; // green, settled
  return "#2c84ff"; // blue, captured and not yet started
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

// Closest first. Hidden nodes are omitted by the caller.
export function idsWithinReach(
  focusId: string,
  points: readonly { id: string; x: number; y: number }[],
  reach: number,
) {
  const focus = points.find((point) => point.id === focusId);
  if (!focus) return [];
  return points
    .flatMap((point) => {
      if (point.id === focusId) return [];
      const distance = Math.hypot(point.x - focus.x, point.y - focus.y);
      return distance <= reach ? [{ id: point.id, distance }] : [];
    })
    .sort((a, b) => a.distance - b.distance)
    .map((point) => point.id);
}

// Ghosts the owner will commit on drop: nearby, related, and not already linked
// in the direction Jev chose. Closest first. A later judgment for the same node
// wins.
export function dragJudgments(
  focusId: string,
  nearby: readonly string[],
  judgments: readonly PreviewJudgment[],
  edges: readonly { source: string; target: string }[],
) {
  const byId = new Map<string, PreviewJudgment>();
  for (const judgment of judgments) byId.set(judgment.nodeId, judgment);
  const taken = new Set(edges.map((edge) => `${edge.source}\0${edge.target}`));
  const picked: PreviewJudgment[] = [];
  for (const id of nearby) {
    const judgment = byId.get(id);
    if (!judgment || id === focusId) continue;
    if (judgment.suppressed || !judgment.relation || !judgment.direction)
      continue;
    if (!judgment.connect && !judgment.match) continue;
    const forward = judgment.direction === "focus_to_candidate";
    const source = forward ? focusId : judgment.nodeId;
    const target = forward ? judgment.nodeId : focusId;
    if (taken.has(`${source}\0${target}`)) continue;
    picked.push(judgment);
  }
  return picked;
}

// Nearby nodes with no judgment yet, closest first, capped for PreviewRequest.
export function unjudgedIds(
  nearby: readonly string[],
  judged: ReadonlySet<string>,
  limit = 24,
) {
  const missing: string[] = [];
  for (const id of nearby) {
    if (judged.has(id)) continue;
    missing.push(id);
    if (missing.length === limit) break;
  }
  return missing;
}

// Where a dropped node should rest so the new edge is as long as the layout's
// link. Null when it is already far enough from the target. Direction is back
// toward where the drag started.
export function settlePoint(
  focus: { x: number; y: number },
  home: { x: number; y: number },
  target: { x: number; y: number },
  distance: number,
): { x: number; y: number } | null {
  const gap = Math.hypot(focus.x - target.x, focus.y - target.y);
  if (gap >= distance * 0.85) return null;
  let dx = home.x - target.x;
  let dy = home.y - target.y;
  let length = Math.hypot(dx, dy);
  if (length < 1) {
    dx = focus.x - target.x;
    dy = focus.y - target.y;
    length = Math.hypot(dx, dy);
  }
  if (length < 1) {
    dx = 1;
    dy = 0;
    length = 1;
  }
  return {
    x: target.x + (dx / length) * distance,
    y: target.y + (dy / length) * distance,
  };
}

// Jev edges that arrived after the snapshot the canvas already showed.
// The caller records the first snapshot without animating it.
export function freshJevEdges<
  T extends {
    id: string;
    origin?: unknown;
    updated: { revision: number };
  },
>(edges: readonly T[], seen: ReadonlySet<string>, previousRevision: number) {
  return edges.filter(
    (edge) =>
      edge.origin != null &&
      !seen.has(edge.id) &&
      edge.updated.revision > previousRevision,
  );
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

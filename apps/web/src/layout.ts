import type { Graph } from "@yakjev/protocol";

export type Point = { readonly x: number; readonly y: number };

export const BLOCKING_DISTANCE = 140;
export const ASSERTED_DISTANCE = 230;
const SUGGESTED = 310;
const EXTENT = 700;
const ITERATIONS = 80;
const SPRING = 0.08;
const REPULSION = 8000;
const DAMPING = 0.6;
const MAX_FORCE = 500;
const MAX_STEP = 50;

// Deterministic placement derived from graph structure alone: sorted ids seed a
// circle, undirected pair springs use the minimum link distance, and repulsion
// keeps unlinked nodes from stacking. Stored node.position is ignored so the
// map reflects claims, never revisions from dragging.
export function placeGraph(graph: Graph): Map<string, Point> {
  const placed = new Map<string, Point>();
  const ids = graph.nodes.map((node) => node.id).sort();
  const count = ids.length;
  if (count === 0) return placed;

  const index = new Map(ids.map((id, i) => [id, i]));
  const blocking = new Set(
    graph.taxonomy.relations
      .filter((relation) => relation.blocking)
      .map((relation) => relation.id),
  );

  const links = new Map<number, number>();
  const link = (a: string, b: string, target: number) => {
    if (a === b) return;
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) return;
    const key = i < j ? i * count + j : j * count + i;
    const current = links.get(key);
    if (current === undefined || target < current) links.set(key, target);
  };
  for (const edge of graph.edges)
    link(
      edge.source,
      edge.target,
      blocking.has(edge.relation) ? BLOCKING_DISTANCE : ASSERTED_DISTANCE,
    );
  for (const suggestion of graph.suggestions)
    if (suggestion.status === "pending")
      link(suggestion.source, suggestion.target, SUGGESTED);

  const springs = [...links].map(([key, target]) => ({
    i: Math.floor(key / count),
    j: key % count,
    target,
  }));

  const radius = Math.max(80, (count * 90) / (2 * Math.PI));
  const px = new Array<number>(count);
  const py = new Array<number>(count);
  const vx = new Array<number>(count).fill(0);
  const vy = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    const angle = (i * 2 * Math.PI) / count;
    px[i] = Math.cos(angle) * radius;
    py[i] = Math.sin(angle) * radius;
  }

  const fx = new Array<number>(count);
  const fy = new Array<number>(count);
  const delta = (i: number, j: number) => {
    let dx = px[j]! - px[i]!;
    let dy = py[j]! - py[i]!;
    let distance = Math.hypot(dx, dy);
    if (distance < 1e-3) {
      const angle = ((i * 31 + j * 17 + 7) % 97) * ((2 * Math.PI) / 97);
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      distance = 1;
    }
    return { dx, dy, distance };
  };

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    fx.fill(0);
    fy.fill(0);
    for (const { i, j, target } of springs) {
      const { dx, dy, distance } = delta(i, j);
      const force = (SPRING * (distance - target)) / distance;
      fx[i] = fx[i]! + force * dx;
      fy[i] = fy[i]! + force * dy;
      fx[j] = fx[j]! - force * dx;
      fy[j] = fy[j]! - force * dy;
    }
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++) {
        const { dx, dy, distance } = delta(i, j);
        const force =
          Math.min(REPULSION / (distance * distance), MAX_FORCE) / distance;
        fx[i] = fx[i]! - force * dx;
        fy[i] = fy[i]! - force * dy;
        fx[j] = fx[j]! + force * dx;
        fy[j] = fy[j]! + force * dy;
      }
    for (let i = 0; i < count; i++) {
      vx[i] = Math.max(
        -MAX_STEP,
        Math.min(MAX_STEP, (vx[i]! + fx[i]!) * DAMPING),
      );
      vy[i] = Math.max(
        -MAX_STEP,
        Math.min(MAX_STEP, (vy[i]! + fy[i]!) * DAMPING),
      );
      px[i] = px[i]! + vx[i]!;
      py[i] = py[i]! + vy[i]!;
    }
  }

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i++) {
    cx += px[i]!;
    cy += py[i]!;
  }
  cx /= count;
  cy /= count;
  let maxAbs = 0;
  for (let i = 0; i < count; i++) {
    px[i] = px[i]! - cx;
    py[i] = py[i]! - cy;
    maxAbs = Math.max(maxAbs, Math.abs(px[i]!), Math.abs(py[i]!));
  }
  const scale = maxAbs > EXTENT ? EXTENT / maxAbs : 1;
  for (let i = 0; i < count; i++) {
    const x = px[i]! * scale;
    const y = py[i]! * scale;
    placed.set(ids[i]!, { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y });
  }
  return placed;
}

// A newcomer sits near the nodes it already touches. Existing coordinates stay
// put: recomputing the whole map on every capture is what throws the canvas.
export function placeNewcomer(
  id: string,
  neighbors: readonly Point[],
  fallback: readonly Point[] = [],
): Point {
  const anchors = neighbors.length > 0 ? neighbors : fallback;
  let hash = 2166136261;
  for (const char of id)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const angle = ((hash % 360) * Math.PI) / 180;
  const distance = 180;
  if (anchors.length === 0)
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  let cx = 0;
  let cy = 0;
  for (const point of anchors) {
    cx += point.x;
    cy += point.y;
  }
  cx /= anchors.length;
  cy /= anchors.length;
  let anchor = anchors[0]!;
  let best = Math.hypot(anchor.x - cx, anchor.y - cy);
  for (const point of anchors.slice(1)) {
    const gap = Math.hypot(point.x - cx, point.y - cy);
    if (gap < best) {
      best = gap;
      anchor = point;
    }
  }
  return {
    x: anchor.x + Math.cos(angle) * distance,
    y: anchor.y + Math.sin(angle) * distance,
  };
}

export function rememberLayout(
  previous: ReadonlyMap<string, Point>,
  graph: Graph,
): Map<string, Point> {
  if (previous.size === 0 && graph.nodes.length > 0) return placeGraph(graph);
  const next = new Map(previous);
  // Anchors and fallback come only from the previous map, so a chain of
  // newcomers in one snapshot can never drift away from placed nodes.
  const existing = [...previous.values()];
  for (const node of graph.nodes) {
    if (next.has(node.id)) continue;
    const neighbors: Point[] = [];
    const consider = (other: string) => {
      const point = previous.get(other);
      if (point) neighbors.push(point);
    };
    for (const edge of graph.edges) {
      if (edge.source === node.id) consider(edge.target);
      if (edge.target === node.id) consider(edge.source);
    }
    for (const suggestion of graph.suggestions) {
      if (suggestion.status !== "pending") continue;
      if (suggestion.source === node.id) consider(suggestion.target);
      if (suggestion.target === node.id) consider(suggestion.source);
    }
    next.set(node.id, placeNewcomer(node.id, neighbors, existing));
  }
  return next;
}

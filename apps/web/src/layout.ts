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

const LABEL_CHAR = 7;
const LABEL_HALF = 11;

export function labelContains(
  label: { x: number; y: number; text: string },
  point: { x: number; y: number },
) {
  const right = label.x + 14 + label.text.length * LABEL_CHAR;
  return (
    point.x >= label.x + 8 &&
    point.x <= right &&
    point.y >= label.y - LABEL_HALF &&
    point.y <= label.y + LABEL_HALF
  );
}

function placementBlocked(
  x: number,
  y: number,
  label: string,
  obstacles: readonly { x: number; y: number; label: string }[],
) {
  for (const obstacle of obstacles) {
    if (Math.hypot(x - obstacle.x, y - obstacle.y) < 36) return true;
    if (labelContains({ ...obstacle, text: obstacle.label }, { x, y }))
      return true;
    if (labelContains({ x, y, text: label }, obstacle)) return true;
  }
  return false;
}

// A newcomer sits near the nodes it already touches, off their labels.
// Existing coordinates stay put: recomputing the whole map on every capture
// is what throws the canvas. Labels extend to the right in screen space.
export function placeNewcomer(
  id: string,
  neighbors: readonly Point[],
  fallback: readonly Point[] = [],
  options?: {
    label?: string;
    obstacles?: readonly { x: number; y: number; label: string }[];
  },
): Point {
  const anchors = neighbors.length > 0 ? neighbors : fallback;
  let hash = 2166136261;
  for (const char of id)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const angle = ((hash % 360) * Math.PI) / 180;
  const distance = 180;
  const label = options?.label ?? "";
  const obstacles = options?.obstacles ?? [];
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
  for (let step = 0; step < 16; step++) {
    const theta = angle + step * ((2 * Math.PI) / 16);
    const point = {
      x: anchor.x + Math.cos(theta) * distance,
      y: anchor.y + Math.sin(theta) * distance,
    };
    if (!placementBlocked(point.x, point.y, label, obstacles)) return point;
  }
  return {
    x: anchor.x + Math.cos(angle) * distance,
    y: anchor.y + Math.sin(angle) * distance,
  };
}

// What a node occupies on screen: its disc and the label to its right, plus
// half the breathing gap on every side. Discs and labels are drawn at a fixed
// screen size, so `unit` (graph units per screen pixel, the camera ratio)
// converts them. Long titles are capped so one essay-length label cannot
// shove a whole neighbourhood aside.
type Box = { left: number; right: number; top: number; bottom: number };
const DISC = 16;
const GAP = 6;
const LABEL_CAP = 48;

function boxAt(point: Point, title: string, unit: number): Box {
  const pad = GAP / 2;
  return {
    left: point.x - (DISC + pad) * unit,
    right:
      point.x +
      (14 + Math.min(title.length, LABEL_CAP) * LABEL_CHAR + pad) * unit,
    top: point.y - (DISC + pad) * unit,
    bottom: point.y + (DISC + pad) * unit,
  };
}

function overlapArea(a: Box, b: Box) {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? x * y : 0;
}

export function overlaps(
  points: ReadonlyMap<string, Point>,
  titles: ReadonlyMap<string, string>,
  unit = 1,
): [string, string][] {
  const ids = [...points.keys()].sort();
  const boxes = ids.map((id) =>
    boxAt(points.get(id)!, titles.get(id) ?? "", unit),
  );
  const found: [string, string][] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (overlapArea(boxes[i]!, boxes[j]!) > 0) found.push([ids[i]!, ids[j]!]);
  return found;
}

// Boxes bucketed on a coarse grid, so a spot is checked against its
// surroundings instead of the whole graph.
const CELL = 96;
function occupancy(unit: number) {
  const size = CELL * unit;
  const grid = new Map<string, Box[]>();
  const cells = (box: Box, visit: (key: string) => void) => {
    for (
      let cx = Math.floor(box.left / size);
      cx <= Math.floor(box.right / size);
      cx++
    )
      for (
        let cy = Math.floor(box.top / size);
        cy <= Math.floor(box.bottom / size);
        cy++
      )
        visit(`${cx}:${cy}`);
  };
  return {
    add(box: Box) {
      cells(box, (key) => {
        const bucket = grid.get(key);
        if (bucket) bucket.push(box);
        else grid.set(key, [box]);
      });
    },
    cost(box: Box) {
      const seen = new Set<Box>();
      let total = 0;
      cells(box, (key) => {
        for (const other of grid.get(key) ?? []) {
          if (seen.has(other)) continue;
          seen.add(other);
          total += overlapArea(box, other);
        }
      });
      return total;
    },
  };
}
type Occupancy = ReturnType<typeof occupancy>;

const RING = 24;

// The nearest spot to `wanted` where the node and its label clear everything
// occupied, searched ring by ring in a fixed order. When nothing within reach
// is free, the spot that overlaps least.
function nearestFree(
  wanted: Point,
  title: string,
  occupied: Occupancy,
  reach: number,
  unit: number,
): { point: Point; clear: boolean } {
  let best = { point: wanted, cost: Infinity };
  const ring = RING * unit;
  for (let radius = 0; radius <= reach * unit; radius += ring) {
    const steps =
      radius === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * radius) / ring));
    for (let step = 0; step < steps; step++) {
      // Start straight below and go round: stacking reads well next to
      // labels that run sideways.
      const theta = Math.PI / 2 + (step * 2 * Math.PI) / steps;
      const point = {
        x: wanted.x + Math.cos(theta) * radius,
        y: wanted.y + Math.sin(theta) * radius,
      };
      const cost = occupied.cost(boxAt(point, title, unit));
      if (cost === 0) return { point, clear: true };
      if (cost < best.cost) best = { point, cost };
    }
  }
  return { point: best.point, clear: false };
}

const NEWCOMER_REACH = 360;
const FAR_REACH = 4000;

// The first map has no mental map to keep yet: nodes settle from the centre
// outward, each at the free spot nearest its force-directed position.
function settleAll(
  points: ReadonlyMap<string, Point>,
  titles: ReadonlyMap<string, string>,
  unit: number,
): Map<string, Point> {
  const order = [...points.entries()].sort(
    ([a, pa], [b, pb]) =>
      Math.hypot(pa.x, pa.y) - Math.hypot(pb.x, pb.y) || (a < b ? -1 : 1),
  );
  const occupied = occupancy(unit);
  const next = new Map<string, Point>();
  for (const [id, point] of order) {
    const title = titles.get(id) ?? "";
    const { point: spot } = nearestFree(
      point,
      title,
      occupied,
      FAR_REACH,
      unit,
    );
    next.set(id, spot);
    occupied.add(boxAt(spot, title, unit));
  }
  return next;
}

// Existing nodes whose position differs between two layouts: what the canvas
// should animate after a relaxation.
export function shifted(
  previous: ReadonlyMap<string, Point>,
  next: ReadonlyMap<string, Point>,
): string[] {
  const moved: string[] = [];
  for (const [id, point] of previous) {
    const now = next.get(id);
    if (now && (now.x !== point.x || now.y !== point.y)) moved.push(id);
  }
  return moved.sort();
}

// `unit` is graph units per screen pixel (the camera ratio when the change
// arrives); labels are cleared at that zoom.
export function rememberLayout(
  previous: ReadonlyMap<string, Point>,
  graph: Graph,
  unit = 1,
): Map<string, Point> {
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  const boxOf = (id: string, point: Point) =>
    boxAt(point, titles.get(id) ?? "", unit);
  if (previous.size === 0 && graph.nodes.length > 0)
    return settleAll(placeGraph(graph), titles, unit);
  const next = new Map(previous);
  const obstacles: { x: number; y: number; label: string }[] = [];
  for (const node of graph.nodes) {
    const point = previous.get(node.id);
    if (point) obstacles.push({ ...point, label: node.title });
  }
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
    const wanted = placeNewcomer(node.id, neighbors, existing, {
      label: node.title,
      obstacles,
    });
    const occupied = occupancy(unit);
    for (const [id, point] of next) occupied.add(boxOf(id, point));
    const { point: spot, clear } = nearestFree(
      wanted,
      node.title,
      occupied,
      NEWCOMER_REACH,
      unit,
    );
    next.set(node.id, spot);
    obstacles.push({ ...spot, label: node.title });
    if (clear) continue;
    // No free spot nearby: the newcomer stays, and only the nodes it lands
    // on step to their own nearest free spot.
    const box = boxOf(node.id, spot);
    const crowd = [...next.keys()]
      .filter(
        (id) =>
          id !== node.id && overlapArea(box, boxOf(id, next.get(id)!)) > 0,
      )
      .sort();
    const rest = occupancy(unit);
    for (const [id, point] of next)
      if (!crowd.includes(id)) rest.add(boxOf(id, point));
    for (const id of crowd) {
      const title = titles.get(id) ?? "";
      const moved = nearestFree(next.get(id)!, title, rest, FAR_REACH, unit);
      next.set(id, moved.point);
      rest.add(boxOf(id, moved.point));
    }
  }
  return next;
}

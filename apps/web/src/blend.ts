import type { Graph } from "@yakjev/protocol";
import { nodeColor } from "./graph-model";

export const PALETTE = [
  { id: "grove", hex: "#386253" },
  { id: "clay", hex: "#ab653e" },
  { id: "ink", hex: "#203d35" },
  { id: "plum", hex: "#6e5878" },
  { id: "tide", hex: "#3d5c6e" },
  { id: "gold", hex: "#8a6a32" },
] as const;

const STORAGE_KEY = "yakjev.nodePaint";

export function readPaint(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && /^#[0-9a-fA-F]{6}$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function writePaint(
  current: Record<string, string>,
  id: string,
  hex: string,
): Record<string, string> {
  const next = { ...current, [id]: hex };
  if (typeof localStorage !== "undefined")
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function mixHex(
  parts: readonly { hex: string; weight: number }[],
): string {
  let red = 0;
  let green = 0;
  let blue = 0;
  let weight = 0;
  for (const part of parts) {
    if (part.weight <= 0) continue;
    const value = Number.parseInt(part.hex.slice(1), 16);
    red += ((value >> 16) & 255) * part.weight;
    green += ((value >> 8) & 255) * part.weight;
    blue += (value & 255) * part.weight;
    weight += part.weight;
  }
  if (weight <= 0) return PALETTE[0].hex;
  const channel = (sum: number) =>
    Math.round(sum / weight)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

// Own color keeps a double share, so a node stays itself while a crowd of
// neighbors can still pull it. Three clay links move grove more than one does.
export function displayColor(
  own: string | undefined,
  neighbors: readonly string[],
): string {
  const base = own ?? PALETTE[0].hex;
  if (neighbors.length === 0) return base;
  return mixHex([
    { hex: base, weight: 2 },
    ...neighbors.map((hex) => ({ hex, weight: 1 })),
  ]);
}

export function blendedColors(
  graph: Graph,
  chosen: Readonly<Record<string, string>>,
): { nodes: Map<string, string>; edges: Map<string, string> } {
  const base = new Map(
    graph.nodes.map((node) => [
      node.id,
      chosen[node.id] ?? nodeColor(node.status),
    ]),
  );
  const neighbors = new Map<string, string[]>();
  const touch = (source: string, target: string) => {
    const other = base.get(target);
    const self = base.get(source);
    if (other) neighbors.set(source, [...(neighbors.get(source) ?? []), other]);
    if (self) neighbors.set(target, [...(neighbors.get(target) ?? []), self]);
  };
  for (const edge of graph.edges) touch(edge.source, edge.target);
  for (const suggestion of graph.suggestions)
    if (suggestion.status === "pending")
      touch(suggestion.source, suggestion.target);

  const nodes = new Map<string, string>();
  for (const node of graph.nodes)
    nodes.set(
      node.id,
      displayColor(
        chosen[node.id] ?? base.get(node.id),
        neighbors.get(node.id) ?? [],
      ),
    );

  const edges = new Map<string, string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.source);
    const to = nodes.get(edge.target);
    if (!from || !to) continue;
    if (!chosen[edge.source] && !chosen[edge.target]) continue;
    const mixed = mixHex([
      { hex: from, weight: 1 },
      { hex: to, weight: 1 },
    ]);
    const relation = graph.taxonomy.relations.find(
      (item) => item.id === edge.relation,
    );
    edges.set(
      edge.id,
      relation?.blocking
        ? mixHex([
            { hex: mixed, weight: 1 },
            { hex: "#ab653e", weight: 1 },
          ])
        : mixed,
    );
  }
  return { nodes, edges };
}

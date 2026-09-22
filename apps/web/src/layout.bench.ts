import { expect, test } from "bun:test";
import {
  initialTaxonomy,
  type Edge,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import { overlaps, placeGraph, rememberLayout, shifted } from "./layout";

const provenance = {
  actor: { id: "synthetic", channel: "browser" as const },
  at: "2026-09-22T00:00:00Z",
  revision: 1,
};
const node = (id: string, title = id): Node => ({
  id,
  title,
  description: "",
  project: "",
  status: "idea",
  sources: [],
  position: null,
  created: provenance,
  updated: provenance,
});
const edge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  relation: "requires",
  rationale: "Unverified assertion",
  state: "asserted",
  assertion: {
    relation: "requires",
    rationale: "Unverified assertion",
    provenance,
  },
  correction: null,
  updated: provenance,
});
const snapshot = (
  nodes: readonly Node[],
  edges: readonly Edge[] = [],
): Graph => ({
  revision: 1,
  nodes,
  edges,
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
});

const COUNT = 200;
const nodes = Array.from({ length: COUNT }, (_, i) => node(`n${i}`));
const chain = Array.from({ length: COUNT - 1 }, (_, i) =>
  edge(`e${i}`, `n${i}`, `n${i + 1}`),
);

test("placeGraph stays under 250ms at 200 nodes and newcomers leave it untouched", () => {
  const started = performance.now();
  const placed = placeGraph(snapshot(nodes, chain));
  const elapsed = performance.now() - started;
  console.log(`placeGraph at ${COUNT} nodes: ${elapsed.toFixed(1)}ms`);
  expect(placed.size).toBe(COUNT);
  expect(elapsed).toBeLessThan(250);

  const grown = rememberLayout(
    placed,
    snapshot([...nodes, node("n200")], chain),
  );
  expect(grown.size).toBe(COUNT + 1);
  for (const { id } of nodes) expect(grown.get(id)).toEqual(placed.get(id));
});

test("settling 200 long-titled nodes and 20 live arrivals stays fast and clear", () => {
  const titled = nodes.map((item, i) =>
    node(item.id, `Write the acceptance tests for intention ${i}`),
  );
  const titles = (graph: Graph) =>
    new Map(graph.nodes.map((item) => [item.id, item.title]));
  let graph = snapshot(titled, chain);
  const started = performance.now();
  let layout = rememberLayout(new Map(), graph);
  const first = performance.now() - started;
  expect(overlaps(layout, titles(graph))).toEqual([]);
  let slowest = 0;
  let moved = 0;
  for (let i = 0; i < 20; i++) {
    const id = `new${i}`;
    graph = snapshot(
      [...graph.nodes, node(id, `Train for the spring marathon ${i}`)],
      [...graph.edges, edge(`x${i}`, id, `n${(i * 37) % COUNT}`)],
    );
    const at = performance.now();
    const next = rememberLayout(layout, graph);
    slowest = Math.max(slowest, performance.now() - at);
    moved += shifted(layout, next).length;
    layout = next;
  }
  console.log(
    `first layout at ${COUNT} nodes: ${first.toFixed(1)}ms; slowest arrival: ${slowest.toFixed(1)}ms; neighbours moved over 20 arrivals: ${moved}`,
  );
  expect(overlaps(layout, titles(graph))).toEqual([]);
  expect(first).toBeLessThan(400);
  expect(slowest).toBeLessThan(50);
});

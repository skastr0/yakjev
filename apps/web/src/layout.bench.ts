import { expect, test } from "bun:test";
import {
  initialTaxonomy,
  type Edge,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import { placeGraph, rememberLayout } from "./layout";

const provenance = {
  actor: { id: "synthetic", channel: "browser" as const },
  at: "2026-09-22T00:00:00Z",
  revision: 1,
};
const node = (id: string): Node => ({
  id,
  title: id,
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

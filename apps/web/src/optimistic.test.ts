import { describe, expect, test } from "bun:test";
import { initialTaxonomy, type Graph } from "@yakjev/protocol";
import { applyOptimistic } from "./optimistic";

const provenance = {
  actor: { id: "owner", channel: "browser" as const },
  at: "2026-09-22T00:00:00Z",
  revision: 3,
};
const node = (id: string, title = id) => ({
  id,
  title,
  description: "",
  project: "",
  status: "idea" as const,
  sources: [],
  position: null,
  created: provenance,
  updated: provenance,
});
const graph: Graph = {
  revision: 3,
  nodes: [node("a"), node("b")],
  edges: [
    {
      id: "a-b",
      source: "a",
      target: "b",
      relation: "requires",
      rationale: "claimed",
      state: "asserted",
      assertion: { relation: "requires", rationale: "claimed", provenance },
      correction: null,
      updated: provenance,
    },
  ],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
};
const input = (id: string) => ({
  id,
  title: id,
  description: "",
  project: "",
  status: "idea" as const,
  sources: [],
});

describe("applyOptimistic", () => {
  test("a capture shows its node and Jev edges at once", () => {
    const next = applyOptimistic(graph, {
      type: "capture",
      capture: { id: "c", text: "c", sources: [], nodeIds: ["c"] },
      nodes: [input("c")],
      edges: [
        {
          id: "c-a",
          source: "c",
          target: "a",
          relation: "related_to",
          rationale: "Connected by Jev.",
          origin: { model: "jev", promptVersion: "p", confidence: 0.8 },
        },
      ],
      autoConnect: false,
    });
    expect(next.nodes.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(next.edges.at(-1)).toMatchObject({
      id: "c-a",
      state: "asserted",
      origin: { model: "jev" },
    });
  });

  test("an edit already in the snapshot applies as a no-op", () => {
    const capture = {
      type: "capture" as const,
      capture: { id: "c", text: "a", sources: [], nodeIds: ["a"] },
      nodes: [input("a")],
      edges: [],
    };
    expect(applyOptimistic(graph, capture)).toBe(graph);
    const put = applyOptimistic(graph, {
      type: "edge.put",
      edge: {
        id: "other-id",
        source: "a",
        target: "b",
        relation: "related_to",
        rationale: "dup",
      },
    });
    expect(put).toBe(graph);
  });

  test("removals, reframes, and node edits show immediately", () => {
    expect(
      applyOptimistic(graph, { type: "node.remove", ids: ["a"] }).edges,
    ).toEqual([]);
    expect(
      applyOptimistic(graph, { type: "edge.remove", id: "a-b" }).edges,
    ).toEqual([]);
    const reframed = applyOptimistic(graph, {
      type: "edge.reframe",
      id: "a-b",
      relation: "benefits_from",
      rationale: "optional",
      state: "asserted",
    });
    expect(reframed.edges[0]).toMatchObject({
      relation: "benefits_from",
      correction: { relation: "benefits_from" },
    });
    const renamed = applyOptimistic(graph, {
      type: "node.put",
      node: { ...input("a"), title: "Renamed" },
    });
    expect(renamed.nodes[0]).toMatchObject({ id: "a", title: "Renamed" });
    expect(renamed.nodes[0]!.created).toEqual(provenance);
  });

  test("server-decided commands wait for the server", () => {
    expect(applyOptimistic(graph, { type: "undo", revision: 3 })).toBe(graph);
  });
});

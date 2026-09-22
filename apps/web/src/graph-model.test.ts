import { describe, expect, test } from "bun:test";
import { MultiDirectedGraph } from "graphology";
import {
  initialTaxonomy,
  type Edge,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import {
  initialPosition,
  layoutBounds,
  safeSourceHref,
  searchNodes,
  syncGraph,
} from "./graph-model";

const provenance = {
  actor: { id: "synthetic", channel: "browser" as const },
  at: "2026-09-22T00:00:00Z",
  revision: 1,
};
const node = (id: string, overrides: Partial<Node> = {}): Node => ({
  id,
  title: id,
  description: "",
  project: "",
  status: "idea",
  sources: [],
  position: null,
  created: provenance,
  updated: provenance,
  ...overrides,
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

describe("render projection", () => {
  test("fit uses actual layout coordinates, not the empty fallback extent", () => {
    expect(
      layoutBounds([
        { x: -2, y: 3 },
        { x: 9, y: 17 },
        { x: 1, y: -4 },
      ]),
    ).toEqual({ x: [-2, 9], y: [-4, 17] });
    expect(
      layoutBounds([
        { x: 1002, y: -900 },
        { x: 1008, y: -800 },
      ]),
    ).toEqual({ x: [1002, 1008], y: [-900, -800] });
    expect(layoutBounds([])).toEqual({ x: [-400, 400], y: [-400, 400] });
    const single = layoutBounds([{ x: 1000, y: -500 }]);
    expect(single).toEqual({ x: [800, 1200], y: [-700, -300] });
  });
  test("an unrelated live addition never moves saved or unsaved existing nodes", () => {
    const graph = new MultiDirectedGraph();
    const a = node("a", { position: { x: -31, y: 97, pinned: true } });
    const b = node("b");
    syncGraph(graph, snapshot([a, b]));
    graph.mergeNodeAttributes("b", { x: 102, y: -48 });
    syncGraph(graph, snapshot([node("new"), b, a]));
    expect([
      graph.getNodeAttribute("a", "x"),
      graph.getNodeAttribute("a", "y"),
      graph.getNodeAttribute("a", "fixed"),
    ]).toEqual([-31, 97, true]);
    expect([
      graph.getNodeAttribute("b", "x"),
      graph.getNodeAttribute("b", "y"),
    ]).toEqual([102, -48]);
    expect(initialPosition("new")).toEqual({
      x: graph.getNodeAttribute("new", "x"),
      y: graph.getNodeAttribute("new", "y"),
    });
  });
  test("cycles and self-loops retain their directed endpoints; a correction changes labels, not node positions", () => {
    const graph = new MultiDirectedGraph();
    const nodes = [node("a"), node("b")];
    const original = edge("ab", "a", "b");
    syncGraph(
      graph,
      snapshot(nodes, [original, edge("ba", "b", "a"), edge("self", "a", "a")]),
    );
    const before = graph.getNodeAttributes("a");
    const corrected = {
      ...original,
      relation: "benefits_from",
      correction: {
        relation: "benefits_from",
        rationale: "An alternative exists",
        state: "asserted" as const,
        provenance,
      },
    };
    syncGraph(
      graph,
      snapshot(nodes, [
        corrected,
        edge("ba", "b", "a"),
        edge("self", "a", "a"),
      ]),
    );
    expect(graph.extremities("ab")).toEqual(["a", "b"]);
    expect(graph.extremities("ba")).toEqual(["b", "a"]);
    expect(graph.extremities("self")).toEqual(["a", "a"]);
    expect(graph.getEdgeAttribute("ab", "label")).toBe(
      "Corrected · Would benefit from",
    );
    expect(graph.getNodeAttributes("a")).toEqual(before);
    expect(original.assertion.relation).toBe("requires");
  });
  test("pending suggestions are visibly labelled and disappear on rejection without touching assertions", () => {
    const graph = new MultiDirectedGraph();
    const data = snapshot([node("a"), node("b")], [edge("ab", "a", "b")]);
    const suggestion = {
      id: "s",
      source: "b",
      target: "a",
      relation: "related_to",
      rationale: "Shared context",
      confidence: 1,
      evidence: [],
      model: "synthetic",
      promptVersion: "1",
      taxonomyVersion: 1,
      basedOnRevision: 1,
      status: "pending" as const,
      provenance,
      decision: null,
    };
    syncGraph(graph, { ...data, suggestions: [suggestion] });
    expect(graph.getEdgeAttribute("suggestion:s", "label")).toBe(
      "Suggestion · Related to",
    );
    expect(graph.getEdgeAttribute("suggestion:s", "suggestion")).toBe(true);
    syncGraph(graph, {
      ...data,
      suggestions: [{ ...suggestion, status: "rejected" }],
    });
    expect(graph.hasEdge("suggestion:s")).toBe(false);
    expect(graph.hasEdge("ab")).toBe(true);
  });
  test("search spans description, project and canonical references without merging nodes", () => {
    const nodes = [
      node("a", {
        title: "Skill setup",
        description: "Across machines",
        project: "Prism",
      }),
      node("b", {
        title: "Skill setup",
        sources: [
          { uri: "https://example.com/session", label: "Jev experiment" },
        ],
      }),
    ];
    expect(searchNodes(nodes, "PRISM machines").map((item) => item.id)).toEqual(
      ["a"],
    );
    expect(searchNodes(nodes, "jev").map((item) => item.id)).toEqual(["b"]);
    expect(searchNodes(nodes, "skill")).toHaveLength(2);
    expect(searchNodes(nodes, "missing")).toHaveLength(0);
  });
  test("canonical source rendering never turns an executable URI into a link", () => {
    expect(safeSourceHref("javascript:alert(1)")).toBeUndefined();
    expect(safeSourceHref("data:text/html,hello")).toBeUndefined();
    expect(safeSourceHref("quasar:session-1")).toBeUndefined();
    expect(safeSourceHref("https://example.com/a?x=1")).toBe(
      "https://example.com/a?x=1",
    );
  });
});

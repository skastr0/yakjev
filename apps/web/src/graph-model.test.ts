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
  visibleGraph,
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
    expect(graph.getNodeAttribute("new", "x")).toBeGreaterThan(-231);
    expect(graph.getNodeAttribute("new", "x")).toBeLessThan(169);
    expect(graph.getNodeAttribute("new", "y")).toBeGreaterThan(-103);
    expect(graph.getNodeAttribute("new", "y")).toBeLessThan(297);
  });
  test("an external node appears in a small saved layout's scale instead of offscreen", () => {
    const saved = [
      { x: 1002, y: -903 },
      { x: 1018, y: -879 },
    ];
    const position = initialPosition("external-live", saved);
    expect(position.x).toBeGreaterThan(998);
    expect(position.x).toBeLessThan(1022);
    expect(position.y).toBeGreaterThan(-903);
    expect(position.y).toBeLessThan(-879);
    expect(initialPosition("external-live", [...saved].reverse())).toEqual(
      position,
    );
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
  test("a supplied display color survives a second projection", () => {
    const graph = new MultiDirectedGraph();
    const data = snapshot(
      [node("a"), node("b", { status: "active" })],
      [edge("ab", "a", "b")],
    );
    const colors = {
      nodes: new Map([
        ["a", "#ed4968"],
        ["b", "#8672fd"],
      ]),
      edges: new Map([["ab", "#bb5ede"]]),
    };
    syncGraph(graph, data, undefined, colors);
    syncGraph(graph, data, undefined, colors);
    expect(graph.getNodeAttribute("a", "color")).toBe("#ed4968");
    expect(graph.getNodeAttribute("b", "color")).toBe("#8672fd");
    expect(graph.getEdgeAttribute("ab", "color")).toBe("#bb5ede");
  });
  test("a derived layout replaces saved positions without pinning them", () => {
    const graph = new MultiDirectedGraph();
    const saved = node("a", { position: { x: 40, y: 40, pinned: true } });
    syncGraph(graph, snapshot([saved]), new Map([["a", { x: -12, y: 7 }]]));
    expect(graph.getNodeAttribute("a", "x")).toBe(-12);
    expect(graph.getNodeAttribute("a", "y")).toBe(7);
    expect(graph.getNodeAttribute("a", "fixed")).toBe(false);
  });
  test("archived nodes leave the visible graph until asked for", () => {
    const data = snapshot([node("live"), node("old", { status: "archived" })]);
    expect(visibleGraph(data, false).nodes.map((item) => item.id)).toEqual([
      "live",
    ]);
    expect(visibleGraph(data, true).nodes).toHaveLength(2);
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

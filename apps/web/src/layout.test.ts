import { describe, expect, test } from "bun:test";
import {
  initialTaxonomy,
  type Edge,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import {
  placeGraph,
  rememberLayout,
  labelContains,
  type Point,
} from "./layout";

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
const edge = (
  id: string,
  source: string,
  target: string,
  relation = "requires",
): Edge => ({
  id,
  source,
  target,
  relation,
  rationale: "Unverified assertion",
  state: "asserted",
  assertion: { relation, rationale: "Unverified assertion", provenance },
  correction: null,
  updated: provenance,
});
type Suggestion = Graph["suggestions"][number];
const suggestion = (
  id: string,
  source: string,
  target: string,
  status: Suggestion["status"] = "pending",
): Suggestion => ({
  id,
  source,
  target,
  relation: "related_to",
  rationale: "Machine suggestion",
  confidence: 0.5,
  evidence: [],
  model: "synthetic",
  promptVersion: "1",
  taxonomyVersion: 1,
  basedOnRevision: 1,
  status,
  provenance,
  decision: null,
});
const snapshot = (
  nodes: readonly Node[],
  edges: readonly Edge[] = [],
  suggestions: readonly Suggestion[] = [],
): Graph => ({
  revision: 1,
  nodes,
  edges,
  captures: [],
  suggestions,
  evaluations: [],
  taxonomy: initialTaxonomy,
});
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const between = (placed: Map<string, Point>, a: string, b: string) =>
  distance(placed.get(a)!, placed.get(b)!);

describe("placeGraph", () => {
  test("is deterministic: the same graph produces deeply equal maps", () => {
    const graph = snapshot(
      [node("c"), node("a"), node("b")],
      [edge("ab", "a", "b"), edge("bc", "b", "c", "related_to")],
      [suggestion("s", "a", "c")],
    );
    expect(placeGraph(graph)).toEqual(placeGraph(graph));
  });
  test("empty and single-node graphs", () => {
    expect(placeGraph(snapshot([])).size).toBe(0);
    const single = placeGraph(snapshot([node("only")])).get("only")!;
    expect(single.x).toBeCloseTo(0);
    expect(single.y).toBeCloseTo(0);
  });
  test("a requires pair ends closer than a related_to pair", () => {
    const requires = placeGraph(
      snapshot([node("a"), node("b")], [edge("ab", "a", "b", "requires")]),
    );
    const related = placeGraph(
      snapshot([node("a"), node("b")], [edge("ab", "a", "b", "related_to")]),
    );
    expect(between(requires, "a", "b")).toBeLessThan(
      between(related, "a", "b"),
    );
  });
  test("in a requires chain a-b-c, distance(a,c) exceeds distance(a,b)", () => {
    const placed = placeGraph(
      snapshot(
        [node("a"), node("b"), node("c")],
        [edge("ab", "a", "b"), edge("bc", "b", "c")],
      ),
    );
    expect(between(placed, "a", "c")).toBeGreaterThan(
      between(placed, "a", "b"),
    );
  });
  test("coordinates are always finite", () => {
    const graph = snapshot(
      [node("a"), node("b"), node("c"), node("d")],
      [
        edge("ab", "a", "b"),
        edge("bc", "b", "c"),
        edge("cd", "c", "d", "benefits_from"),
        edge("loop", "d", "d"),
      ],
      [suggestion("s", "a", "d")],
    );
    for (const point of placeGraph(graph).values()) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
  test("stored node positions do not change the result", () => {
    const stored = [
      node("a", { position: { x: 900, y: -400, pinned: true } }),
      node("b", { position: { x: -55, y: 12, pinned: false } }),
    ];
    const fresh = [node("a"), node("b")];
    const edges = [edge("ab", "a", "b")];
    expect(placeGraph(snapshot(stored, edges))).toEqual(
      placeGraph(snapshot(fresh, edges)),
    );
  });
  test("a pending suggestion does not shorten a real assertion", () => {
    const edges = [edge("ab", "a", "b")];
    const plain = placeGraph(snapshot([node("a"), node("b")], edges));
    const hinted = placeGraph(
      snapshot([node("a"), node("b")], edges, [suggestion("s", "a", "b")]),
    );
    expect(between(hinted, "a", "b")).toBeCloseTo(between(plain, "a", "b"));
  });
  test("a pending suggestion lands farther than a related_to assertion", () => {
    const hinted = placeGraph(
      snapshot([node("a"), node("b")], [], [suggestion("s", "a", "b")]),
    );
    const related = placeGraph(
      snapshot([node("a"), node("b")], [edge("ab", "a", "b", "related_to")]),
    );
    expect(between(hinted, "a", "b")).toBeGreaterThan(
      between(related, "a", "b"),
    );
  });
  test("adding a node keeps every node that was already placed", () => {
    const first = placeGraph(
      snapshot([node("a"), node("b")], [edge("ab", "a", "b")]),
    );
    const next = rememberLayout(
      first,
      snapshot(
        [node("a"), node("b"), node("c")],
        [edge("ab", "a", "b"), edge("bc", "b", "c")],
      ),
    );
    expect(next.get("a")).toEqual(first.get("a"));
    expect(next.get("b")).toEqual(first.get("b"));
    expect(between(next, "c", "b")).toBeGreaterThan(40);
    expect(between(next, "c", "a")).toBeGreaterThan(40);
  });
  test("several newcomers in one snapshot stay near existing nodes without moving them", () => {
    const first = placeGraph(
      snapshot([node("a"), node("b")], [edge("ab", "a", "b")]),
    );
    const next = rememberLayout(
      first,
      snapshot(
        [node("a"), node("b"), node("c"), node("d"), node("e")],
        [edge("ab", "a", "b"), edge("ac", "a", "c"), edge("cd", "c", "d")],
      ),
    );
    expect(next.get("a")).toEqual(first.get("a"));
    expect(next.get("b")).toEqual(first.get("b"));
    for (const id of ["c", "d", "e"]) {
      const near = Math.min(between(next, id, "a"), between(next, id, "b"));
      expect(near).toBeLessThanOrEqual(220);
    }
  });
  test("a newcomer stays off an existing node's label", () => {
    const title = "Go to the gym three times a week";
    const first = placeGraph(snapshot([node("gym", { title })]));
    const next = rememberLayout(
      first,
      snapshot(
        [
          node("gym", { title }),
          node("train", { title: "Train for the spring marathon" }),
        ],
        [edge("gt", "gym", "train")],
      ),
    );
    const gym = next.get("gym")!;
    const train = next.get("train")!;
    expect(labelContains({ ...gym, text: title }, train)).toBe(false);
    expect(Math.hypot(train.x - gym.x, train.y - gym.y)).toBeLessThanOrEqual(
      220,
    );
  });
});

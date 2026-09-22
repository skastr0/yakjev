import { describe, expect, test } from "bun:test";
import { initialTaxonomy, type Graph, type Node } from "@yakjev/protocol";
import { PALETTE, blendedColors, displayColor, mixHex } from "./blend";

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

const red = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);

describe("displayColor", () => {
  test("a node with no neighbors keeps its own color", () => {
    expect(displayColor("#386253", [])).toBe("#386253");
  });

  test("three clay neighbors pull grove further than one", () => {
    const clay = "#ab653e";
    const one = displayColor("#386253", [clay]);
    const three = displayColor("#386253", [clay, clay, clay]);
    expect(red(one)).toBeGreaterThan(red("#386253"));
    expect(red(three)).toBeGreaterThan(red(one));
  });

  test("mix is deterministic", () => {
    const parts = [
      { hex: "#386253", weight: 2 },
      { hex: "#ab653e", weight: 1 },
    ];
    expect(mixHex(parts)).toBe(mixHex(parts));
  });
});

describe("blendedColors", () => {
  test("an unpainted edge keeps no override", () => {
    const graph = {
      revision: 1,
      nodes: [node("a"), node("b")],
      edges: [
        {
          id: "ab",
          source: "a",
          target: "b",
          relation: "related_to",
          rationale: "shared",
          state: "asserted" as const,
          assertion: {
            relation: "related_to",
            rationale: "shared",
            provenance,
          },
          correction: null,
          updated: provenance,
        },
      ],
      captures: [],
      suggestions: [],
      evaluations: [],
      taxonomy: initialTaxonomy,
    } satisfies Graph;
    expect(blendedColors(graph, {}).edges.has("ab")).toBe(false);
    const painted = blendedColors(graph, { a: PALETTE[1].hex });
    expect(painted.edges.get("ab")).toMatch(/^#[0-9a-f]{6}$/);
    expect(red(painted.nodes.get("b")!)).toBeGreaterThan(red("#386253"));
  });
});

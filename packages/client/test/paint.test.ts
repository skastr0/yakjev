import { describe, expect, test } from "bun:test";
import {
  initialTaxonomy,
  PAINT_BATCH_MAX,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import {
  legacyPaintCommand,
  paintNode,
  updateNode,
} from "../src/graph-commands";
import { applyOptimistic } from "../src/optimistic";
import { blendedColors, PALETTE } from "../src/blend";

const provenance = {
  actor: { id: "owner", channel: "browser" as const },
  at: "2026-09-23T00:00:00Z",
  revision: 1,
};
const node = (id: string, color?: string | null): Node => ({
  id,
  title: id,
  description: "",
  project: "",
  status: "idea",
  sources: [],
  position: null,
  created: provenance,
  updated: provenance,
  ...(color !== undefined ? { color } : {}),
});
const graph = (...nodes: Node[]): Graph => ({
  revision: 1,
  nodes,
  edges: [],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
});

describe("server-owned node color", () => {
  test("paint commands contain no stale content fields", () => {
    expect(paintNode("a", "#ABCDEF")).toEqual({
      type: "node.paint",
      colors: [{ id: "a", color: "#abcdef" }],
    });
    expect(paintNode("a", null).colors[0]?.color).toBeNull();
    expect(() => paintNode("a", "red")).toThrow("six-digit hex");
  });

  test("optimistic paint changes only color and leaves the source snapshot intact", () => {
    const before = graph(node("a"), node("b", PALETTE[1].hex));
    const after = applyOptimistic(before, paintNode("a", PALETTE[0].hex));
    expect(after.nodes[0]).toEqual({
      ...before.nodes[0]!,
      color: PALETTE[0].hex,
    });
    expect(after.nodes[0]!.updated).toBe(before.nodes[0]!.updated);
    expect(after.nodes[1]).toBe(before.nodes[1]);
    expect(before.nodes[0]!.color).toBeUndefined();
    expect(blendedColors(after).nodes.get("a")).toBe(PALETTE[0].hex);
  });

  test("explicit automatic color restores status fallback", () => {
    const before = graph({ ...node("a", PALETTE[0].hex), status: "active" });
    const after = applyOptimistic(before, paintNode("a", null));
    expect(after.nodes[0]!.color).toBeNull();
    expect(blendedColors(after).nodes.get("a")).toBe("#e35b00");
  });

  test("ordinary node edits preserve the current paint in optimistic state", () => {
    const before = graph(node("a", PALETTE[0].hex));
    const command = updateNode(before.nodes[0]!, { title: "Renamed" })!;
    const after = applyOptimistic(before, command);
    expect(after.nodes[0]!.title).toBe("Renamed");
    expect(after.nodes[0]!.color).toBe(PALETTE[0].hex);
  });

  test("legacy import only includes existing unset colors, in bounded batches", () => {
    const before = graph(
      node("unset"),
      node("painted", "#112233"),
      node("automatic", null),
    );
    const local = {
      unset: "#AABBCC",
      painted: "#445566",
      automatic: "#778899",
      removed: "#123456",
    };
    expect(legacyPaintCommand(before, local)).toEqual({
      type: "node.paint",
      colors: [{ id: "unset", color: "#aabbcc" }],
      onlyIfUnset: true,
    });
    const many = graph(
      ...Array.from({ length: PAINT_BATCH_MAX + 3 }, (_, i) => node(`n${i}`)),
    );
    const records = Object.fromEntries(
      many.nodes.map((item) => [item.id, "#123456"]),
    );
    expect(legacyPaintCommand(many, records)?.colors).toHaveLength(
      PAINT_BATCH_MAX,
    );
    expect(legacyPaintCommand(before, {})).toBeNull();
  });

  test("a remote choice appearing after import preparation wins optimistically", () => {
    const command = legacyPaintCommand(graph(node("a"), node("b")), {
      a: "#123456",
      b: "#abcdef",
    })!;
    const current = graph(node("a", "#fedcba"), node("b", null));
    const after = applyOptimistic(current, command);
    expect(after.nodes).toEqual(current.nodes);
  });

  test("legal object-prototype names neither invent paint nor crash rendering", () => {
    const before = graph(node("toString"), node("constructor"));
    expect(legacyPaintCommand(before, {})).toBeNull();
    expect([...blendedColors(before).nodes.values()]).toEqual([
      "#2c84ff",
      "#2c84ff",
    ]);
    const own = JSON.parse(
      '{"toString":"#123456","constructor":"#abcdef"}',
    ) as Record<string, string>;
    expect(legacyPaintCommand(before, own)?.colors).toHaveLength(2);
    expect(legacyPaintCommand(before, { toString: "not-a-color" })).toBeNull();
  });

  test("atomic captures show their color in the optimistic graph", () => {
    const input = node("new", PALETTE[0].hex);
    const {
      created: _created,
      updated: _updated,
      position: _position,
      ...fields
    } = input;
    const after = applyOptimistic(graph(), {
      type: "capture",
      capture: { id: "capture", text: "new", sources: [], nodeIds: ["new"] },
      nodes: [fields],
      edges: [],
      autoConnect: false,
    });
    expect(blendedColors(after).nodes.get("new")).toBe(PALETTE[0].hex);
  });
});

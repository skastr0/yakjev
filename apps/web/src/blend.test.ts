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

// The canvas the palette has to read against (style.css :root background).
const CANVAS = "#f5f2e9";

function linear(channel: number) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function oklab(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = linear((value >> 16) & 255);
  const g = linear((value >> 8) & 255);
  const b = linear(value & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

const chroma = (hex: string) => Math.hypot(oklab(hex).a, oklab(hex).b);

function distance(a: string, b: string) {
  const x = oklab(a);
  const y = oklab(b);
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b) * 100;
}

function luminance(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * linear((value >> 16) & 255) +
    0.7152 * linear((value >> 8) & 255) +
    0.0722 * linear(value & 255)
  );
}

function contrast(a: string, b: string) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("displayColor", () => {
  test("a node with no neighbors keeps its own color", () => {
    expect(displayColor(PALETTE[0].hex, [])).toBe(PALETTE[0].hex);
  });

  test("an undefined own color falls back to the first swatch", () => {
    expect(displayColor(undefined, [])).toBe(PALETTE[0].hex);
  });

  // The property that makes the feature worth having: neighbors tint a node,
  // they never take it over. A flat own weight of 2 would fail this, because
  // own share becomes 2/(N+2) and a twelve-neighbor node drops to 14% itself.
  test("a node keeps at least half its own color at any degree", () => {
    const own = PALETTE[0].hex;
    const neighbor = PALETTE[1].hex;
    const two = displayColor(own, [neighbor, neighbor]);
    expect(displayColor(own, Array(3).fill(neighbor))).toBe(two);
    expect(displayColor(own, Array(12).fill(neighbor))).toBe(two);
    expect(displayColor(own, Array(40).fill(neighbor))).toBe(two);
  });

  test("more neighbors never move a node further than the floor allows", () => {
    const own = PALETTE[0].hex;
    const neighbor = PALETTE[1].hex;
    const one = displayColor(own, [neighbor]);
    const many = displayColor(own, Array(20).fill(neighbor));
    // One neighbor is a light tint; a crowd pulls the node further.
    expect(distance(one, own)).toBeLessThan(distance(many, own));
    // The floor is half way, so past two neighbors the node sits equidistant
    // from its own color and the neighbor's. Only 8-bit rounding separates the
    // two sides, so this is a near-equality, not a direction.
    expect(
      Math.abs(distance(many, own) - distance(many, neighbor)),
    ).toBeLessThan(0.15);
  });

  test("a blend keeps most of the chroma of the colors going into it", () => {
    const own = PALETTE[8].hex;
    const neighbors = [
      PALETTE[0].hex,
      PALETTE[2].hex,
      PALETTE[4].hex,
      PALETTE[6].hex,
      PALETTE[9].hex,
      PALETTE[11].hex,
    ];
    const mixed = displayColor(own, neighbors);
    const floor = Math.min(...[own, ...neighbors].map(chroma)) * 0.6;
    expect(chroma(mixed)).toBeGreaterThan(floor);
  });
});

describe("mixHex", () => {
  test("is deterministic", () => {
    const parts = [
      { hex: PALETTE[0].hex, weight: 2 },
      { hex: PALETTE[1].hex, weight: 1 },
    ];
    expect(mixHex(parts)).toBe(mixHex(parts));
  });

  test("ignores non-positive weights and falls back when nothing is left", () => {
    expect(mixHex([{ hex: PALETTE[3].hex, weight: 0 }])).toBe(PALETTE[0].hex);
  });

  test("returns a hex for every pair in the palette, in gamut", () => {
    for (const a of PALETTE)
      for (const b of PALETTE) {
        const mixed = mixHex([
          { hex: a.hex, weight: 1 },
          { hex: b.hex, weight: 1 },
        ]);
        expect(mixed).toMatch(/^#[0-9a-f]{6}$/);
      }
  });

  // Averaging gamma-encoded channels loses brightness; OKLab does not.
  test("holds lightness instead of darkening the way sRGB averaging does", () => {
    const a = PALETTE[0].hex;
    const b = PALETTE[4].hex;
    const mixed = mixHex([
      { hex: a, weight: 1 },
      { hex: b, weight: 1 },
    ]);
    const parents = [oklab(a).L, oklab(b).L];
    expect(oklab(mixed).L).toBeGreaterThan(Math.min(...parents) - 0.02);
  });
});

describe("PALETTE", () => {
  test("every swatch is vivid enough to read as alive", () => {
    for (const swatch of PALETTE)
      expect(chroma(swatch.hex)).toBeGreaterThan(0.1);
  });

  test("every swatch clears 3:1 against the canvas", () => {
    for (const swatch of PALETTE)
      expect(contrast(swatch.hex, CANVAS)).toBeGreaterThan(3);
  });

  test("no two swatches are close enough to confuse", () => {
    const gaps = PALETTE.flatMap((a, i) =>
      PALETTE.slice(i + 1).map((b) => distance(a.hex, b.hex)),
    );
    expect(Math.min(...gaps)).toBeGreaterThan(7);
  });

  test("swatch ids are unique", () => {
    expect(new Set(PALETTE.map((swatch) => swatch.id)).size).toBe(
      PALETTE.length,
    );
  });
});

describe("blendedColors", () => {
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

  test("an unpainted edge keeps no override", () => {
    expect(blendedColors(graph, {}).edges.has("ab")).toBe(false);
  });

  test("an edge touching a painted node picks up the mix", () => {
    const painted = blendedColors(graph, { a: PALETTE[1].hex });
    expect(painted.edges.get("ab")).toMatch(/^#[0-9a-f]{6}$/);
    expect(painted.nodes.get("b")).not.toBe(
      blendedColors(graph, {}).nodes.get("b"),
    );
  });

  test("an unpainted node wears its status color", () => {
    expect(blendedColors(graph, {}).nodes.get("a")).toBe("#2c84ff");
  });
});

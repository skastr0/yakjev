import type { Graph } from "@yakjev/protocol";
import { nodeColor } from "./graph-model";

// Twelve hues around the OKLCH wheel, chosen so the closest pair still sits
// 8.2 apart in OKLab and every swatch clears 3.2:1 against the canvas.
// Chroma runs 0.10 to 0.20; a categorical palette wants the range.
export const PALETTE = [
  { id: "red", hex: "#ed4968" },
  { id: "orange", hex: "#e35b00" },
  { id: "amber", hex: "#b27c00" },
  { id: "olive", hex: "#7e8f00" },
  { id: "green", hex: "#159b05" },
  { id: "jade", hex: "#009969" },
  { id: "teal", hex: "#00959c" },
  { id: "sky", hex: "#008ecc" },
  { id: "blue", hex: "#2c84ff" },
  { id: "violet", hex: "#8672fd" },
  { id: "purple", hex: "#bb5ede" },
  { id: "magenta", hex: "#dd51ad" },
] as const;

// Blocking relations keep their own accent rather than borrowing a palette
// slot, so repainting the palette never silently restyles the graph.
const BLOCKING_TINT = "#e5484d";

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

// Mixing happens in OKLCH. Two things matter here.
//
// First, lightness and chroma average as scalars but hue averages as a circular
// mean of unit vectors. Averaging the raw a/b components instead lets two hues
// pulling opposite ways cancel each other's chroma, so a blue node ringed by
// orange neighbours came out #9c7f9e, a muted mauve. Averaging the angle and
// the radius separately keeps it vivid: the same node lands on a real hue at
// full chroma.
//
// Second, sRGB averaging is not an option. Gamma-encoded channels darken as
// they mix: a bright red averaged with a bright green lands at L 0.55, below
// either parent.
export function mixHex(
  parts: readonly { hex: string; weight: number }[],
): string {
  let lightness = 0;
  let chroma = 0;
  let x = 0;
  let y = 0;
  let weight = 0;
  let heaviestHue: number | null = null;
  let heaviestWeight = 0;
  for (const part of parts) {
    if (part.weight <= 0) continue;
    const lab = hexToOklab(part.hex);
    if (!lab) continue;
    const radius = Math.hypot(lab.a, lab.b);
    lightness += lab.L * part.weight;
    chroma += radius * part.weight;
    weight += part.weight;
    if (radius > 1e-6) {
      x += (lab.a / radius) * part.weight;
      y += (lab.b / radius) * part.weight;
    }
    if (part.weight > heaviestWeight) {
      heaviestWeight = part.weight;
      heaviestHue = Math.atan2(lab.b, lab.a);
    }
  }
  if (weight <= 0) return PALETTE[0].hex;
  // Exactly opposed hues leave no mean direction to take; the heaviest color
  // decides, which for displayColor is the node's own hue.
  const hue = Math.hypot(x, y) > 1e-6 ? Math.atan2(y, x) : (heaviestHue ?? 0);
  const meanChroma = chroma / weight;
  return oklabToHex({
    L: lightness / weight,
    a: meanChroma * Math.cos(hue),
    b: meanChroma * Math.sin(hue),
  });
}

type Lab = { L: number; a: number; b: number };

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(channel: number): number {
  const c =
    channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return c * 255;
}

function hexToOklab(hex: string): Lab | null {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return null;
  const r = srgbToLinear((value >> 16) & 255);
  const g = srgbToLinear((value >> 8) & 255);
  const b = srgbToLinear(value & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinearRgb({ L, a, b }: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  const slack = 1 / 512;
  return (
    r >= -slack &&
    r <= 1 + slack &&
    g >= -slack &&
    g <= 1 + slack &&
    b >= -slack &&
    b <= 1 + slack
  );
}

// A weighted average of two vivid colors can land outside sRGB. Pull chroma
// back along the same hue until it fits, instead of clipping channels, which
// would shift the hue and flatten the result.
function oklabToHex(lab: Lab): string {
  const chroma = Math.hypot(lab.a, lab.b);
  let fit = lab;
  if (chroma > 0 && !inGamut(oklabToLinearRgb(lab))) {
    const hue = Math.atan2(lab.b, lab.a);
    let lo = 0;
    let hi = chroma;
    for (let step = 0; step < 28; step += 1) {
      const mid = (lo + hi) / 2;
      const candidate = {
        L: lab.L,
        a: mid * Math.cos(hue),
        b: mid * Math.sin(hue),
      };
      if (inGamut(oklabToLinearRgb(candidate))) lo = mid;
      else hi = mid;
    }
    fit = { L: lab.L, a: lo * Math.cos(hue), b: lo * Math.sin(hue) };
  }
  const channel = (value: number) =>
    Math.round(Math.min(255, Math.max(0, linearToSrgb(value))))
      .toString(16)
      .padStart(2, "0");
  const [r, g, b] = oklabToLinearRgb(fit);
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// A node keeps at least half its own color however many neighbors pull at it.
// A flat double share would not: own weight 2 against N neighbors is 2/(N+2),
// which is already 40% at three links and 14% at twelve, so a busy node lost
// its color entirely. Scaling the share to the degree holds the floor at 50%.
export function displayColor(
  own: string | undefined,
  neighbors: readonly string[],
): string {
  const base = own ?? PALETTE[0].hex;
  if (neighbors.length === 0) return base;
  return mixHex([
    { hex: base, weight: Math.max(2, neighbors.length) },
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
  const paintEdge = (
    id: string,
    source: string,
    target: string,
    blocking: boolean,
  ) => {
    const from = nodes.get(source);
    const to = nodes.get(target);
    if (!from || !to) return;
    const mixed = mixHex([
      { hex: from, weight: 1 },
      { hex: to, weight: 1 },
    ]);
    edges.set(
      id,
      blocking
        ? mixHex([
            { hex: mixed, weight: 1 },
            { hex: BLOCKING_TINT, weight: 1 },
          ])
        : mixed,
    );
  };
  for (const edge of graph.edges) {
    const relation = graph.taxonomy.relations.find(
      (item) => item.id === edge.relation,
    );
    paintEdge(edge.id, edge.source, edge.target, relation?.blocking === true);
  }
  for (const suggestion of graph.suggestions)
    if (suggestion.status === "pending")
      paintEdge(
        `suggestion:${suggestion.id}`,
        suggestion.source,
        suggestion.target,
        false,
      );
  return { nodes, edges };
}

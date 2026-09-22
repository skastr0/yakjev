import { Context, Effect, Layer } from "effect";
import type { Graph, Node } from "../../protocol/src/graph.ts";

// Ranking only: which nodes are worth asking Jev about, best first. How many
// Jev judges is the token-budget packer's decision (discovery.ts), not this.
export interface RankedCandidate {
  readonly nodeId: string;
  readonly score: number;
  readonly lexicalScore: number;
  readonly semanticScore: number | null;
  readonly sharedTokens: readonly string[];
  readonly via: "explicit" | "graph" | "lexical" | "semantic" | "coverage";
}

export interface RankInput {
  readonly graph: Graph;
  // A draft has no id; text is what the focus says.
  readonly focus: { readonly id: string | null; readonly text: string };
  // Always first. Among themselves, Jaccard then id, as discover() does.
  readonly explicit: ReadonlySet<string>;
  // true: return the explicit nodes only.
  readonly only: boolean;
}

// Every eligible node (not archived, not the focus), best first, no cap.
// Never fails: a semantic outage degrades to lexical order.
export interface RetrievalService {
  readonly rank: (
    input: RankInput,
  ) => Effect.Effect<readonly RankedCandidate[]>;
}

export class Retrieval extends Context.Service<Retrieval, RetrievalService>()(
  "yakjev/Retrieval",
) {}

const words = (value: string) =>
  new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
const nodeText = (node: Node) => `${node.title} ${node.description}`;
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Bands sit further apart than Jaccard (0..1), so a sort by score alone matches
// discover(): every explicit node, neighbors among them first, then other
// neighbors, then word overlap, then id.
const scoreOf = (
  lexicalScore: number,
  isExplicit: boolean,
  isNeighbour: boolean,
) => (isExplicit ? 16 : 0) + (isNeighbour ? 4 : 0) + lexicalScore;

/** Explicit, then graph neighbours, then word-overlap (Jaccard), then id. */
export function lexicalRank(input: RankInput): RankedCandidate[] {
  const { graph, focus, explicit, only } = input;
  const eligible = graph.nodes.filter(
    (node) => node.status !== "archived" && node.id !== focus.id,
  );
  const queryWords = words(focus.text);
  const neighbours = new Set<string>();
  if (focus.id !== null) {
    for (const edge of graph.edges) {
      if (edge.source === focus.id) neighbours.add(edge.target);
      if (edge.target === focus.id) neighbours.add(edge.source);
    }
  }
  const ranked = eligible.flatMap((node): RankedCandidate[] => {
    if (only && !explicit.has(node.id)) return [];
    const nodeWords = words(nodeText(node));
    const sharedTokens = [...queryWords]
      .filter((word) => nodeWords.has(word))
      .sort(compareId);
    const union = queryWords.size + nodeWords.size - sharedTokens.length;
    const lexicalScore = union === 0 ? 0 : sharedTokens.length / union;
    const via: RankedCandidate["via"] = explicit.has(node.id)
      ? "explicit"
      : neighbours.has(node.id)
        ? "graph"
        : sharedTokens.length
          ? "lexical"
          : "coverage";
    return [
      {
        nodeId: node.id,
        lexicalScore,
        semanticScore: null,
        sharedTokens,
        via,
        score: scoreOf(
          lexicalScore,
          explicit.has(node.id),
          neighbours.has(node.id),
        ),
      },
    ];
  });
  ranked.sort((a, b) => b.score - a.score || compareId(a.nodeId, b.nodeId));
  return ranked;
}

export const lexicalRetrieval: RetrievalService = {
  rank: (input) => Effect.succeed(lexicalRank(input)),
};

// Lexical until an embedding provider is configured. A semantic outage must
// degrade to this ranker and must not fail the effect.
export const RetrievalLive: Layer.Layer<Retrieval> =
  Layer.succeed(Retrieval)(lexicalRetrieval);

import { createHash } from "node:crypto";
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

// Bands sit further apart than Jaccard (0..1) plus a cosine (0..1), so a sort
// by score alone keeps discover()'s order: explicit, then neighbors, then the
// fused lexical + semantic score, then id.
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

// Below this cosine a zero-overlap node stays coverage and the packer can drop it.
const SEMANTIC_FLOOR = 0.4;
// First rank waits this long, then returns lexical order. The embedding
// requests keep running. A cold 1,000-node graph is about 11 sequential
// batches, so that first call does not finish inside this budget.
export const EMBED_BUDGET_MS = 250;
// One embeddings request at a time, this many texts. Not parallel.
export const EMBED_BATCH = 96;
// Quasar's Synthetic profile: nomic via the OpenAI-compatible route, with the
// query and document prefixes that model expects. SYNTHETIC_API_KEY is the
// bearer token. SYNTHETIC_OPENAI_BASE_URL overrides the host.
const EMBED_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5";
const EMBED_DIMENSIONS = 768;
const QUERY_PREFIX = "search_query: ";
const DOCUMENT_PREFIX = "search_document: ";
const SYNTHETIC_EMBEDDINGS_BASE = "https://api.synthetic.new/openai/v1";
// One input's token cap is 8191. Characters stay under that for ordinary text.
const EMBED_CHARS = 8000;

export interface EmbeddingClient {
  readonly embed: (
    texts: readonly string[],
  ) => Promise<readonly (readonly number[])[]>;
}

const contentKey = (value: string) =>
  createHash("sha256").update(value.normalize("NFKC")).digest("hex");

const cosine = (left: readonly number[], right: readonly number[]) => {
  const length = Math.min(left.length, right.length);
  if (length === 0) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
};

interface CachedText {
  readonly hash: string;
  readonly text: string;
}

function hybridRanker(client: EmbeddingClient, budgetMs: number) {
  const cache = new Map<string, readonly number[]>();
  const inflight = new Map<string, Promise<void>>();

  const warm = (items: readonly CachedText[]): Promise<void> => {
    const fresh = [
      ...new Map(
        items
          .filter((item) => item.text.length > 0 && !cache.has(item.hash))
          .filter((item) => !inflight.has(item.hash))
          .map((item) => [item.hash, item] as const),
      ).values(),
    ];
    if (fresh.length > 0) {
      const job = (async () => {
        try {
          for (let start = 0; start < fresh.length; start += EMBED_BATCH) {
            const chunk = fresh.slice(start, start + EMBED_BATCH);
            const vectors = await client.embed(chunk.map((item) => item.text));
            if (vectors.length !== chunk.length) throw new Error("shape");
            for (let index = 0; index < chunk.length; index += 1) {
              const vector = vectors[index];
              const item = chunk[index];
              if (!vector || vector.length === 0 || !item)
                throw new Error("shape");
              cache.set(item.hash, vector);
            }
          }
        } catch {
          // The caller ranks lexically. Uncached hashes are retried next time.
        } finally {
          for (const item of fresh) inflight.delete(item.hash);
        }
      })();
      for (const item of fresh) inflight.set(item.hash, job);
    }
    return Promise.all(
      items.map((item) => inflight.get(item.hash) ?? Promise.resolve()),
    ).then(() => undefined);
  };

  const fuse = (
    lexical: RankedCandidate[],
    focusHash: string,
    hashes: ReadonlyMap<string, string>,
  ): RankedCandidate[] => {
    const focusVector = cache.get(focusHash);
    if (!focusVector) return lexical;
    const fused = lexical.map((candidate) => {
      const vector = cache.get(hashes.get(candidate.nodeId) ?? "");
      const semanticScore = vector ? cosine(focusVector, vector) : null;
      if (semanticScore === null) return candidate;
      const via =
        candidate.via === "coverage" && semanticScore >= SEMANTIC_FLOOR
          ? "semantic"
          : candidate.via;
      return {
        ...candidate,
        via,
        semanticScore,
        score: candidate.score + Math.max(0, semanticScore),
      };
    });
    fused.sort((a, b) => b.score - a.score || compareId(a.nodeId, b.nodeId));
    return fused;
  };

  const rank = async (input: RankInput): Promise<RankedCandidate[]> => {
    const lexical = lexicalRank(input);
    const focusBody = input.focus.text.normalize("NFKC").slice(0, EMBED_CHARS);
    if (focusBody.trim() === "") return lexical;
    const focusText = `${QUERY_PREFIX}${focusBody}`;
    const byId = new Map(input.graph.nodes.map((node) => [node.id, node]));
    const hashes = new Map<string, string>();
    const needed: CachedText[] = [
      { hash: contentKey(focusText), text: focusText },
    ];
    for (const candidate of lexical) {
      const node = byId.get(candidate.nodeId);
      if (!node) continue;
      const body = nodeText(node).normalize("NFKC").slice(0, EMBED_CHARS);
      const text = `${DOCUMENT_PREFIX}${body}`;
      const hash = contentKey(text);
      hashes.set(node.id, hash);
      if (body.trim() !== "") needed.push({ hash, text });
    }
    const missing = needed.filter((item) => !cache.has(item.hash));
    // Cold start embeds every missing text in sequential EMBED_BATCH requests.
    // 1,000 nodes is about 11 calls, which will not finish inside the budget,
    // so this rank returns lexical order while the rest of the warm continues.
    // A partial cache is not fused: one semantic score makes the packer drop
    // every remaining coverage node, including a paraphrase still in flight.
    if (missing.length > 0) {
      const pending = warm(missing);
      const ready = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), budgetMs);
        pending.then(
          () => finish(true),
          () => finish(false),
        );
      });
      if (!ready || missing.some((item) => !cache.has(item.hash)))
        return lexical;
    }
    return fuse(lexical, needed[0]!.hash, hashes);
  };

  return rank;
}

/** Lexical rank, fused with cached embeddings when they are ready in time. */
export function hybridRetrieval(
  client: EmbeddingClient,
  options?: { readonly budgetMs?: number },
): RetrievalService {
  const rank = hybridRanker(client, options?.budgetMs ?? EMBED_BUDGET_MS);
  return {
    rank: (input) =>
      Effect.promise(async () => {
        try {
          return await rank(input);
        } catch {
          return lexicalRank(input);
        }
      }),
  };
}

function syntheticEmbeddingsUrl(): string {
  const base =
    process.env.SYNTHETIC_OPENAI_BASE_URL?.trim() || SYNTHETIC_EMBEDDINGS_BASE;
  return `${base.replace(/\/$/, "")}/embeddings`;
}

function syntheticEmbeddings(apiKey: string): EmbeddingClient {
  return {
    embed: async (texts) => {
      const response = await fetch(syntheticEmbeddingsUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input: [...texts],
          dimensions: EMBED_DIMENSIONS,
        }),
      });
      if (!response.ok) throw new Error(`embeddings ${response.status}`);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("data" in body))
        throw new Error("embeddings shape");
      const data = body.data;
      if (!Array.isArray(data) || data.length !== texts.length)
        throw new Error("embeddings shape");
      const ordered: (readonly number[])[] = new Array(texts.length);
      for (const row of data) {
        if (!row || typeof row !== "object")
          throw new Error("embeddings shape");
        const index = "index" in row ? row.index : undefined;
        const embedding = "embedding" in row ? row.embedding : undefined;
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= texts.length ||
          !Array.isArray(embedding) ||
          embedding.some((value) => typeof value !== "number")
        )
          throw new Error("embeddings shape");
        ordered[index] = embedding;
      }
      if (ordered.some((vector) => !vector))
        throw new Error("embeddings shape");
      return ordered;
    },
  };
}

let liveKey = "";
let liveHybrid: RetrievalService | null = null;

// Hybrid when SYNTHETIC_API_KEY is set; otherwise lexical. The key stays in
// this process. A missing key, a slow response, or any error ranks lexically.
export const RetrievalLive: Layer.Layer<Retrieval> = Layer.succeed(Retrieval)({
  rank: (input) => {
    const key = process.env.SYNTHETIC_API_KEY?.trim() ?? "";
    if (!key) return lexicalRetrieval.rank(input);
    if (key !== liveKey || !liveHybrid) {
      liveKey = key;
      liveHybrid = hybridRetrieval(syntheticEmbeddings(key));
    }
    return liveHybrid.rank(input);
  },
});

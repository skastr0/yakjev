import { initialTaxonomy, type Graph } from "@yakjev/protocol";
import { Effect } from "effect";
import {
  Discovery,
  DiscoveryLive,
  shortlist,
  type DiscoveryResult,
} from "../src/discovery.ts";
import {
  hybridRetrieval,
  lexicalRetrieval,
  Retrieval,
  RetrievalLive,
  type EmbeddingClient,
  type RetrievalService,
} from "../src/retrieval.ts";

// Provider-free by default; --live-smoke and --jev-rerank opt into real providers.
// The distractors deliberately share words with each query while the intended
// node is a paraphrase. This catches a lexical shortlist that hides a valid
// connection before Jev has a chance to judge it.
const cases = [
  {
    query: "Arrange a routine teeth checkup",
    id: "dental_exam",
    title: "Schedule an oral health examination",
    trap: "Arrange a routine code checkup",
  },
  {
    query: "Turn writing notes into a book chapter",
    id: "manuscript_sections",
    title: "Convert research annotations into manuscript sections",
    trap: "Turn writing notes into archive boxes",
  },
  {
    query: "Map dependencies for the service rollout",
    id: "release_prerequisites",
    title: "Chart deployment prerequisites",
    trap: "Map dependencies for the garden service schedule",
  },
] as const;

const provenance = {
  actor: { id: "synthetic", channel: "system" as const },
  at: "2026-01-01T00:00:00.000Z",
  revision: 0,
};
const makeNode = (id: string, title: string): Graph["nodes"][number] => ({
  id,
  title,
  description: "",
  project: "synthetic-retrieval",
  status: "idea",
  sources: [],
  position: null,
  created: provenance,
  updated: provenance,
});

const nodes: Graph["nodes"][number][] = cases.map(({ id, title }) =>
  makeNode(id, title),
);
for (let index = 0; index < 997; index++) {
  const group = cases[index % cases.length]!;
  nodes.push(makeNode(`trap_${index}`, `${group.trap} ${index}`));
}
const graph: Graph = {
  revision: 0,
  nodes,
  edges: [],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
};

const evaluate = async (name: string, retrieval: RetrievalService) => {
  const results = await Promise.all(
    cases.map(async ({ query, id }) => {
      const started = performance.now();
      const result = await Effect.runPromise(
        shortlist(graph, { query }, retrieval),
      );
      const ranked = result.candidates.map((candidate) => candidate.nodeId);
      return {
        retrieval: name,
        query,
        expected: id,
        found: ranked.includes(id),
        rank: ranked.indexOf(id) + 1 || null,
        considered: result.coverage.considered,
        eligible: result.coverage.eligible,
        strategy: result.coverage.strategy,
        estimatedTokens: result.coverage.estimatedTokens,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      };
    }),
  );
  const recall =
    results.filter((result) => result.found).length / results.length;
  console.table(results);
  console.log(
    `${name} large-graph candidate recall: ${recall.toFixed(3)} (${nodes.length} nodes)`,
  );
  return recall;
};
await evaluate("lexical", lexicalRetrieval);
// Deterministic semantic fixture exercises the full rank-and-pack path at
// 1,000 nodes without a provider credential. The cosine margin mirrors a live
// Synthetic check (paraphrase .677, word trap .671), so lexical overlap cannot
// bury a slightly better semantic match below hundreds of traps.
const scriptedEmbeddings: EmbeddingClient = {
  embed: async (texts) =>
    texts.map((value) => {
      const query = cases.findIndex((item) => value.includes(item.query));
      const target = cases.findIndex((item) => value.includes(item.title));
      const trap = cases.findIndex((item) => value.includes(item.trap));
      const index = query >= 0 ? query : target >= 0 ? target : trap;
      if (index < 0) return [0, 0, 0, 1];
      const similarity = query >= 0 ? 1 : target >= 0 ? 0.677 : 0.671;
      return [0, 1, 2, 3].map((_, dimension) =>
        dimension === index
          ? similarity
          : dimension === 3
            ? Math.sqrt(1 - similarity ** 2)
            : 0,
      );
    }),
};
const scriptedRecall = await evaluate(
  "scripted-hybrid",
  hybridRetrieval(scriptedEmbeddings, { budgetMs: 5_000 }),
);
const live = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* Retrieval;
  }).pipe(Effect.provide(RetrievalLive)),
);
const liveSmoke = process.argv.includes("--live-smoke");
const jevRerank = process.argv.includes("--jev-rerank");
const liveRecall = liveSmoke || jevRerank ? null : await evaluate("live", live);
if (jevRerank) {
  if (
    !process.env.SYNTHETIC_API_KEY?.trim() ||
    !process.env.TYPESAFE_API_KEY?.trim()
  )
    throw new Error(
      "--jev-rerank requires SYNTHETIC_API_KEY and TYPESAFE_API_KEY",
    );
  const discovery = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Discovery;
    }).pipe(Effect.provide(DiscoveryLive)),
  );
  const caseId = process.argv
    .find((value) => value.startsWith("--case="))
    ?.slice(7);
  const liveCases = caseId ? cases.filter((item) => item.id === caseId) : cases;
  if (liveCases.length === 0) throw new Error(`unknown case: ${caseId}`);
  const results = [];
  for (const { query, id } of liveCases) {
    const rankInput = {
      graph,
      focus: { id: null, text: query },
      explicit: new Set<string>(),
      only: false,
    };
    const warmDeadline = Date.now() + 180_000;
    let ranked = await Effect.runPromise(live.rank(rankInput));
    while (
      ranked.some((candidate) => candidate.semanticScore === null) &&
      Date.now() < warmDeadline
    ) {
      await Bun.sleep(500);
      ranked = await Effect.runPromise(live.rank(rankInput));
    }
    const warmed = ranked.every(
      (candidate) => candidate.semanticScore !== null,
    );
    if (!warmed) throw new Error(`embedding warm timed out for ${id}`);
    const started = performance.now();
    const result = await Effect.runPromise(
      discovery.shortlist(graph, { query }),
    );
    const ids = result.candidates.map((candidate) => candidate.nodeId);
    const calls = result.coarse;
    results.push({
      id,
      found: ids.includes(id),
      packedRank: ids.indexOf(id) + 1 || null,
      considered: ids.length,
      rerankCalls: calls.length,
      rerankFailures: calls.filter((call) => call.status !== "succeeded")
        .length,
      rerankInputTokens: calls.reduce(
        (sum, call) => sum + (call.inputTokens ?? 0),
        0,
      ),
      rerankOutputTokens: calls.reduce(
        (sum, call) => sum + (call.outputTokens ?? 0),
        0,
      ),
      rerankMs: Math.round(performance.now() - started),
    });
    console.table([results.at(-1)]);
  }
  const recall =
    results.filter((result) => result.found).length / results.length;
  console.log(`Jev-reranked warmed live recall: ${recall.toFixed(3)}`);
  if (recall < 1) process.exitCode = 1;
}
if (liveSmoke) {
  if (!process.env.SYNTHETIC_API_KEY?.trim())
    throw new Error("--live-smoke requires SYNTHETIC_API_KEY");
  const first = cases[0]!;
  const smallGraph: Graph = {
    ...graph,
    nodes: [makeNode(first.id, first.title), makeNode("word_trap", first.trap)],
  };
  const deadline = Date.now() + 30_000;
  let ranked: DiscoveryResult;
  do {
    ranked = await Effect.runPromise(
      shortlist(smallGraph, { query: first.query }, live),
    );
    if (
      ranked.candidates.every((candidate) => candidate.semanticScore !== null)
    )
      break;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  const target = ranked.candidates.find(
    (candidate) => candidate.nodeId === first.id,
  );
  console.log(
    `Synthetic live smoke: ${target?.semanticScore !== null && target !== undefined ? "semantic" : "lexical fallback"}; target rank ${ranked.candidates.findIndex((candidate) => candidate.nodeId === first.id) + 1}`,
  );
  console.table(
    ranked.candidates.map(({ nodeId, lexicalScore, semanticScore, score }) => ({
      nodeId,
      lexicalScore,
      semanticScore,
      score,
    })),
  );
  if (target?.semanticScore === null || target === undefined)
    process.exitCode = 1;
}
const floorArg = process.argv.find((value) =>
  value.startsWith("--min-recall="),
);
if (floorArg) {
  const floor = Number(floorArg.slice("--min-recall=".length));
  if (!Number.isFinite(floor) || floor < 0 || floor > 1)
    throw new Error("--min-recall must be between 0 and 1");
  if (scriptedRecall < floor) process.exitCode = 1;
}
const liveFloorArg = process.argv.find((value) =>
  value.startsWith("--live-min-recall="),
);
if (liveFloorArg) {
  if (liveRecall === null)
    throw new Error("--live-min-recall cannot be combined with --live-smoke");
  const floor = Number(liveFloorArg.slice("--live-min-recall=".length));
  if (!Number.isFinite(floor) || floor < 0 || floor > 1)
    throw new Error("--live-min-recall must be between 0 and 1");
  if (liveRecall < floor) process.exitCode = 1;
}

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { discover } from "../src/discovery.ts";
import {
  EMBED_BATCH,
  hybridRetrieval,
  lexicalRank,
  lexicalRetrieval,
  Retrieval,
  RetrievalLive,
  type EmbeddingClient,
} from "../src/retrieval.ts";
import { edge, graph, node } from "./discovery.fixture.ts";

const textOf = (item: ReturnType<typeof node>) =>
  `${item.title} ${item.description}`;

describe("lexical retrieval", () => {
  test("matches discover()'s top 24 and recalls every one of them", async () => {
    const focus = node(
      "focus",
      "Bake sourdough bread",
      "Feed the starter and shape the loaf",
    );
    const relevant = [
      node("yeast", "Buy flour and yeast", "Starter food for the loaf"),
      node("starter", "Feed the sourdough starter", "Keep the culture alive"),
    ];
    const fillers = Array.from({ length: 28 }, (_, index) =>
      node(
        `fill-${index.toString().padStart(2, "0")}`,
        `Unrelated note ${index}`,
        "Nothing about bread",
      ),
    );
    const snapshot = graph(
      [focus, ...relevant, ...fillers],
      [edge("focus", "starter")],
    );
    const discovered = discover(snapshot, {
      query: "",
      focusNodeId: "focus",
    }).candidates.map((candidate) => candidate.nodeId);
    const ranked = lexicalRank({
      graph: snapshot,
      focus: { id: "focus", text: textOf(focus) },
      explicit: new Set(),
      only: false,
    });
    // discover() judges the best-first prefix the budget packer keeps.
    const top = ranked
      .slice(0, discovered.length)
      .map((candidate) => candidate.nodeId);
    const recalled = discovered.filter((id) => top.includes(id)).length;
    expect(top).toEqual(discovered);
    expect(recalled / discovered.length).toBe(1);
    expect(ranked.length).toBe(snapshot.nodes.length - 1);
    expect(ranked[0]?.nodeId).toBe("starter");
    expect(ranked.find((candidate) => candidate.nodeId === "yeast")?.via).toBe(
      "lexical",
    );
  });

  test("only returns the explicit set, and archived nodes stay out", () => {
    const focus = node("focus", "Deploy the server", "");
    const archived = {
      ...node("old", "Archived deploy note", ""),
      status: "archived" as const,
    };
    const snapshot = graph([
      focus,
      node("docs", "Write deployment docs", ""),
      archived,
    ]);
    const ranked = lexicalRank({
      graph: snapshot,
      focus: { id: "focus", text: textOf(focus) },
      explicit: new Set(["docs", "old", "missing"]),
      only: true,
    });
    expect(ranked.map((candidate) => candidate.nodeId)).toEqual(["docs"]);
    expect(ranked[0]?.via).toBe("explicit");
  });

  test("score order is explicit, then neighbors, then overlap", () => {
    const focus = node("focus", "Bake sourdough bread", "Feed the starter");
    const snapshot = graph(
      [
        focus,
        node("named", "Completely different words", ""),
        node("near", "Keep the culture alive", ""),
        node(
          "words",
          "Bake sourdough bread tomorrow",
          "Feed the starter again",
        ),
      ],
      [edge("focus", "near")],
    );
    const ranked = lexicalRank({
      graph: snapshot,
      focus: { id: "focus", text: textOf(focus) },
      explicit: new Set(["named"]),
      only: false,
    });
    expect(ranked.map((candidate) => candidate.nodeId)).toEqual([
      "named",
      "near",
      "words",
    ]);
    expect(ranked.map((candidate) => candidate.score)).toEqual(
      [...ranked]
        .sort((a, b) => b.score - a.score)
        .map((candidate) => candidate.score),
    );
  });

  test("the live layer is lexical and does not fail", async () => {
    const previous = process.env.SYNTHETIC_API_KEY;
    delete process.env.SYNTHETIC_API_KEY;
    try {
      const focus = node("focus", "Run a 5k", "Build endurance");
      const snapshot = graph([
        focus,
        node("shoes", "Buy running shoes", "Shoes for the 5k"),
      ]);
      const ranked = await Effect.runPromise(
        Effect.gen(function* () {
          const retrieval = yield* Retrieval;
          return yield* retrieval.rank({
            graph: snapshot,
            focus: { id: null, text: "running shoes" },
            explicit: new Set(),
            only: false,
          });
        }).pipe(Effect.provide(RetrievalLive)),
      );
      expect(ranked.map((candidate) => candidate.nodeId)).toEqual([
        "shoes",
        "focus",
      ]);
      expect(ranked[0]?.semanticScore).toBeNull();
      expect(
        Effect.runSync(
          lexicalRetrieval.rank({
            graph: snapshot,
            focus: { id: "missing", text: "" },
            explicit: new Set(),
            only: false,
          }),
        ).map((candidate) => candidate.nodeId),
      ).toEqual(["focus", "shoes"]);
    } finally {
      if (previous === undefined) delete process.env.SYNTHETIC_API_KEY;
      else process.env.SYNTHETIC_API_KEY = previous;
    }
  });
});

const vectors = new Map<string, readonly number[]>([
  ["Arrange a routine teeth checkup ", [1, 0]],
  ["Schedule an oral health examination ", [1, 0]],
  ["Arrange a routine code checkup ", [0, 1]],
  ["Quarterly tax filing ", [0, 1]],
]);

const scripted = (calls: string[][]): EmbeddingClient => ({
  embed: async (texts) => {
    calls.push([...texts]);
    return texts.map((text) => vectors.get(text) ?? [0, 0]);
  },
});

describe("hybrid retrieval", () => {
  const focus = node("focus", "Arrange a routine teeth checkup", "");
  const snapshot = () =>
    graph([
      focus,
      node("paraphrase", "Schedule an oral health examination", ""),
      node("trap", "Arrange a routine code checkup", ""),
      node("unrelated", "Quarterly tax filing", ""),
    ]);
  const input = () => ({
    graph: snapshot(),
    focus: { id: "focus" as const, text: textOf(focus) },
    explicit: new Set<string>(),
    only: false,
  });

  test("a zero-overlap paraphrase is semantic and outranks a word trap", async () => {
    const calls: string[][] = [];
    const ranked = await Effect.runPromise(
      hybridRetrieval(scripted(calls)).rank(input()),
    );
    expect(calls).toHaveLength(1);
    expect(ranked.map((candidate) => candidate.nodeId)).toEqual([
      "paraphrase",
      "trap",
      "unrelated",
    ]);
    expect(
      ranked.find((candidate) => candidate.nodeId === "paraphrase"),
    ).toMatchObject({ via: "semantic", lexicalScore: 0, semanticScore: 1 });
    expect(ranked.find((candidate) => candidate.nodeId === "trap")?.via).toBe(
      "lexical",
    );
    expect(
      ranked.find((candidate) => candidate.nodeId === "unrelated")?.via,
    ).toBe("coverage");
    expect(
      ranked.find((candidate) => candidate.nodeId === "unrelated")
        ?.semanticScore,
    ).toBe(0);
  });

  test("embeds only new or changed node text", async () => {
    const calls: string[][] = [];
    const retrieval = hybridRetrieval(scripted(calls));
    await Effect.runPromise(retrieval.rank(input()));
    await Effect.runPromise(retrieval.rank(input()));
    expect(calls).toHaveLength(1);
    const edited = graph([
      focus,
      node("paraphrase", "Schedule an oral health examination", "booked"),
      node("trap", "Arrange a routine code checkup", ""),
      node("unrelated", "Quarterly tax filing", ""),
    ]);
    await Effect.runPromise(retrieval.rank({ ...input(), graph: edited }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["Schedule an oral health examination booked"]);
  });

  test("a slow embedder returns lexical order and warms the next call", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished: Promise<readonly (readonly number[])[]> = Promise.resolve([]);
    const client: EmbeddingClient = {
      embed: (texts) => {
        finished = gate.then(() => texts.map(() => [1, 0] as const));
        return finished;
      },
    };
    const retrieval = hybridRetrieval(client, { budgetMs: 20 });
    const first = await Effect.runPromise(retrieval.rank(input()));
    expect(first.every((candidate) => candidate.semanticScore === null)).toBe(
      true,
    );
    expect(
      first.find((candidate) => candidate.nodeId === "paraphrase")?.via,
    ).toBe("coverage");
    release();
    await finished;
    const second = await Effect.runPromise(retrieval.rank(input()));
    expect(
      second.find((candidate) => candidate.nodeId === "paraphrase")?.via,
    ).toBe("semantic");
  });

  test("a cold multi-batch warm stays lexical until every batch finishes", async () => {
    const releases: Array<() => void> = [];
    const calls: number[] = [];
    const client: EmbeddingClient = {
      embed: (texts) =>
        new Promise((resolve) => {
          calls.push(texts.length);
          releases.push(() => resolve(texts.map(() => [1, 0] as const)));
        }),
    };
    const focus = node("focus", "Arrange a routine teeth checkup", "");
    const snapshot = graph([
      focus,
      ...Array.from({ length: EMBED_BATCH }, (_, index) =>
        node(`n-${index}`, `Note ${index}`, "unrelated"),
      ),
    ]);
    const rankInput = {
      graph: snapshot,
      focus: { id: "focus" as const, text: textOf(focus) },
      explicit: new Set<string>(),
      only: false,
    };
    const retrieval = hybridRetrieval(client, { budgetMs: 20 });
    const first = await Effect.runPromise(retrieval.rank(rankInput));
    expect(first.every((candidate) => candidate.semanticScore === null)).toBe(
      true,
    );
    expect(calls).toEqual([EMBED_BATCH]);

    releases[0]?.();
    for (let attempt = 0; calls.length < 2 && attempt < 20; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([EMBED_BATCH, 1]);

    const partial = await Effect.runPromise(retrieval.rank(rankInput));
    expect(partial.every((candidate) => candidate.semanticScore === null)).toBe(
      true,
    );

    releases[1]?.();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    const warmed = await Effect.runPromise(retrieval.rank(rankInput));
    expect(warmed.every((candidate) => candidate.semanticScore === 1)).toBe(
      true,
    );
    expect(warmed.every((candidate) => candidate.via === "semantic")).toBe(
      true,
    );
  });

  test("an embedding error stays lexical and does not fail", async () => {
    const client: EmbeddingClient = {
      embed: async () => {
        throw new Error("down");
      },
    };
    const ranked = await Effect.runPromise(
      hybridRetrieval(client, { budgetMs: 50 }).rank(input()),
    );
    expect(ranked.every((candidate) => candidate.semanticScore === null)).toBe(
      true,
    );
    expect(
      ranked.find((candidate) => candidate.nodeId === "paraphrase")?.via,
    ).toBe("coverage");
  });
});

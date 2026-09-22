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
    return texts.map(
      (text) =>
        vectors.get(text.replace(/^search_(?:query|document): /, "")) ?? [0, 0],
    );
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
      ranked.find((candidate) => candidate.nodeId === "unrelated"),
    ).toMatchObject({ via: "semantic", semanticScore: 0 });
  });

  test("a slightly higher cosine outranks a high-overlap word trap", async () => {
    const along = (value: number): readonly number[] => [
      value,
      Math.sqrt(1 - value * value),
    ];
    const bodies = new Map<string, readonly number[]>([
      ["Arrange a routine teeth checkup ", [1, 0]],
      ["Schedule an oral health examination ", along(0.67718)],
      ["Arrange a routine code checkup ", along(0.67092)],
    ]);
    const client: EmbeddingClient = {
      embed: async (texts) =>
        texts.map(
          (text) =>
            bodies.get(text.replace(/^search_(?:query|document): /, "")) ?? [
              0, 1,
            ],
        ),
    };
    const ranked = await Effect.runPromise(
      hybridRetrieval(client).rank({
        graph: graph([
          focus,
          node("paraphrase", "Schedule an oral health examination", ""),
          node("trap", "Arrange a routine code checkup", ""),
        ]),
        focus: { id: "focus", text: textOf(focus) },
        explicit: new Set(),
        only: false,
      }),
    );
    expect(ranked.map((candidate) => candidate.nodeId)).toEqual([
      "paraphrase",
      "trap",
    ]);
    expect(ranked[0]?.semanticScore).toBeCloseTo(0.67718, 4);
    expect(ranked[1]?.semanticScore).toBeCloseTo(0.67092, 4);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  test("via semantic is the semantic top 24 or a cosine above the field", async () => {
    const along = (value: number): readonly number[] => [
      value,
      Math.sqrt(1 - value * value),
    ];
    const client: EmbeddingClient = {
      embed: async (texts) =>
        texts.map((text) => {
          const match = text.match(/Item (\d+)/);
          if (!match) return [1, 0] as const;
          return along(Number(match[1]) < 24 ? 0.9 : 0.55);
        }),
    };
    const focus = node("focus", "Qqq focus phrase", "");
    const ranked = await Effect.runPromise(
      hybridRetrieval(client).rank({
        graph: graph([
          focus,
          ...Array.from({ length: 30 }, (_, index) =>
            node(
              `item-${index.toString().padStart(2, "0")}`,
              `Item ${index}`,
              "",
            ),
          ),
        ]),
        focus: { id: "focus", text: textOf(focus) },
        explicit: new Set(),
        only: false,
      }),
    );
    expect(
      ranked.find((candidate) => candidate.nodeId === "item-00")?.via,
    ).toBe("semantic");
    expect(
      ranked.find((candidate) => candidate.nodeId === "item-23")?.via,
    ).toBe("semantic");
    expect(
      ranked.find((candidate) => candidate.nodeId === "item-24")?.via,
    ).toBe("coverage");
    expect(
      ranked.find((candidate) => candidate.nodeId === "item-24")?.semanticScore,
    ).toBeGreaterThan(0.4);
  });

  test("explicit and neighbor bands stay above semantic", async () => {
    const client: EmbeddingClient = {
      embed: async (texts) =>
        texts.map((text) =>
          text.includes("Schedule an oral") || text.startsWith("search_query:")
            ? ([1, 0] as const)
            : ([0, 1] as const),
        ),
    };
    const named = node("named", "Completely different words", "");
    const near = node("near", "Keep the culture alive", "");
    const ranked = await Effect.runPromise(
      hybridRetrieval(client).rank({
        graph: graph(
          [
            focus,
            named,
            near,
            node("paraphrase", "Schedule an oral health examination", ""),
          ],
          [edge("focus", "near")],
        ),
        focus: { id: "focus", text: textOf(focus) },
        explicit: new Set(["named"]),
        only: false,
      }),
    );
    expect(ranked.map((candidate) => candidate.nodeId)).toEqual([
      "named",
      "near",
      "paraphrase",
    ]);
    expect(ranked[0]?.via).toBe("explicit");
    expect(ranked[1]?.via).toBe("graph");
    expect(ranked[2]?.via).toBe("semantic");
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
    expect(calls[1]).toEqual([
      "search_document: Schedule an oral health examination booked",
    ]);
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

describe("RetrievalLive Synthetic adapter", () => {
  test("posts the nomic payload with the Synthetic key and no network", async () => {
    const previousKey = process.env.SYNTHETIC_API_KEY;
    const previousBase = process.env.SYNTHETIC_OPENAI_BASE_URL;
    const previousFetch = globalThis.fetch;
    const key = "synthetic-test-key";
    process.env.SYNTHETIC_API_KEY = key;
    delete process.env.SYNTHETIC_OPENAI_BASE_URL;
    let requested: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requested = { url: String(url), init: init ?? {} };
      const payload = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: payload.input.map((_, index) => ({
            index,
            embedding: [1, 0],
          })),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const focus = node("focus", "Arrange a routine teeth checkup", "");
    const snapshot = graph([
      focus,
      node("paraphrase", "Schedule an oral health examination", ""),
    ]);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const retrieval = yield* Retrieval;
          return yield* retrieval.rank({
            graph: snapshot,
            focus: { id: "focus", text: textOf(focus) },
            explicit: new Set(),
            only: false,
          });
        }).pipe(Effect.provide(RetrievalLive)),
      );
      expect(requested?.url).toBe(
        "https://api.synthetic.new/openai/v1/embeddings",
      );
      const headers = new Headers(requested?.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${key}`);
      const body = JSON.parse(String(requested?.init.body)) as {
        model: string;
        dimensions: number;
        input: string[];
      };
      expect(body.model).toBe("hf:nomic-ai/nomic-embed-text-v1.5");
      expect(body.dimensions).toBe(768);
      expect(body.input).toEqual([
        "search_query: Arrange a routine teeth checkup ",
        "search_document: Schedule an oral health examination ",
      ]);
      expect(JSON.stringify(body)).not.toContain(key);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.SYNTHETIC_API_KEY;
      else process.env.SYNTHETIC_API_KEY = previousKey;
      if (previousBase === undefined)
        delete process.env.SYNTHETIC_OPENAI_BASE_URL;
      else process.env.SYNTHETIC_OPENAI_BASE_URL = previousBase;
    }
  });

  test("a hung embeddings request aborts and a 401 is not retried", async () => {
    const previousKey = process.env.SYNTHETIC_API_KEY;
    const previousTimeout = process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS;
    const previousFetch = globalThis.fetch;
    process.env.SYNTHETIC_API_KEY = "synthetic-timeout-key";
    process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS = "40";
    let aborts = 0;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          aborts += 1;
          reject(
            Object.assign(new Error("timed out"), { name: "TimeoutError" }),
          );
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      })) as typeof fetch;
    const focus = node("focus", "Arrange a routine teeth checkup", "");
    const rankInput = {
      graph: graph([
        focus,
        node("paraphrase", "Schedule an oral health examination", ""),
      ]),
      focus: { id: "focus" as const, text: textOf(focus) },
      explicit: new Set<string>(),
      only: false,
    };
    try {
      const ranked = await Effect.runPromise(
        Effect.gen(function* () {
          const retrieval = yield* Retrieval;
          return yield* retrieval.rank(rankInput);
        }).pipe(Effect.provide(RetrievalLive)),
      );
      expect(
        ranked.every((candidate) => candidate.semanticScore === null),
      ).toBe(true);
      for (let attempt = 0; aborts < 2 && attempt < 40; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(aborts).toBe(2);

      let denied = 0;
      process.env.SYNTHETIC_API_KEY = "synthetic-denied-key";
      globalThis.fetch = (async () => {
        denied += 1;
        return new Response("no", { status: 401 });
      }) as unknown as typeof fetch;
      await Effect.runPromise(
        Effect.gen(function* () {
          const retrieval = yield* Retrieval;
          return yield* retrieval.rank(rankInput);
        }).pipe(Effect.provide(RetrievalLive)),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(denied).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.SYNTHETIC_API_KEY;
      else process.env.SYNTHETIC_API_KEY = previousKey;
      if (previousTimeout === undefined)
        delete process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS;
      else process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS = previousTimeout;
    }
  });
});

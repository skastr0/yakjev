import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { discover } from "../src/discovery.ts";
import {
  lexicalRank,
  lexicalRetrieval,
  Retrieval,
  RetrievalLive,
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
  });
});

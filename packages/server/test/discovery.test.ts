import { describe, expect, test } from "bun:test";
import { ConfigProvider, Deferred, Effect, Fiber } from "effect";
import { AiError } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import { TypeSafeClient, TypeSafeSchema } from "@effect/ai-typesafe";
import {
  Discovery,
  DiscoveryLive,
  discover,
  TARGET_INPUT_TOKENS,
  evaluationIsCurrent,
  isProtectedPair,
  makeDiscovery,
} from "../src/discovery.ts";
import {
  edge,
  graph,
  node,
  provenance,
  synonymGraph,
  tangle,
} from "./discovery.fixture.ts";

type Request = typeof TypeSafeSchema.SystemOneRequest.Encoded;
type Response = typeof TypeSafeSchema.SystemOneResponse.Type;

const controlled = (
  systemOne: TypeSafeClient.Service["systemOne"],
): TypeSafeClient.Service => ({
  client: HttpClient.make(() =>
    Effect.die("Unexpected HTTP in controlled test"),
  ),
  systemOne,
  listModels: () => Effect.succeed({ models: [] }),
});

function response(
  request: Request,
  choices: Record<string, string | number> = {},
): Response {
  const answers: Record<string, typeof TypeSafeSchema.Answer.Type> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === "score") {
      const score = Number(choices[key] ?? 2);
      answers[key] = {
        type: "score",
        score,
        probabilities: Object.fromEntries(
          question.criteria.map((_, i) => [String(i), i === score ? 1 : 0]),
        ),
        confidence: 1,
      };
    } else if (question.type === "choice") {
      const choice = String(
        choices[key] ??
          (key.startsWith("match")
            ? "match"
            : key.startsWith("same")
              ? "different"
              : "focus_to_candidate_1"),
      );
      answers[key] = {
        type: "choice",
        choice,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((label) => [
            label,
            label === choice ? 1 : 0,
          ]),
        ),
        confidence: 1,
      };
    }
  }
  return {
    model: "controlled-test-model",
    answers,
    usage: { input_tokens: 123, output_tokens: 17 },
  };
}

const evaluate = (
  g = tangle,
  choices: Record<string, string | number> = {},
  request = { query: "", focusNodeId: "use-jev" },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* makeDiscovery(
        controlled((input) => Effect.succeed(response(input, choices))),
      );
      return yield* service.evaluate(g, request);
    }),
  );

describe("discovery candidates", () => {
  test("full coverage includes synonyms with zero overlap, independently of lexical trap rank", () => {
    const result = discover(synonymGraph, { query: "multi machine skills" });
    expect(result.coverage).toMatchObject({
      eligible: 2,
      considered: 2,
      limit: 2,
      truncated: false,
      strategy: "full",
    });
    expect(result.coverage.estimatedTokens).toBeGreaterThan(0);
    expect(result.candidates.map((candidate) => candidate.nodeId)).toEqual([
      "word-trap",
      "synonym",
    ]);
    expect(result.candidates[1]?.lexicalScore).toBe(0);
    expect(result.candidates[1]?.sharedTokens).toEqual([]);
  });

  test("small graphs are judged whole; larger ones keep evidence and explicit ids", () => {
    const nodes = Array.from({ length: 25 }, (_, i) =>
      node(
        `n${i.toString().padStart(2, "0")}`,
        i < 23 ? "matching query" : "different",
      ),
    );
    // 24 eligible: every node is judged, even without shared words.
    const small = discover(graph(nodes.slice(0, 24)), { query: "matching" });
    expect(small.coverage).toMatchObject({
      truncated: false,
      strategy: "full",
    });
    expect(small.candidates).toHaveLength(24);
    const result = discover(graph(nodes), {
      query: "matching",
      includeNodeIds: ["n24"],
    });
    expect(result.candidates[0]?.nodeId).toBe("n24");
    // Lexical-only ranking keeps overlap-free nodes: they are the only way a
    // paraphrase reaches Jev. Explicit ids still lead.
    expect(result.candidates.map((c) => c.nodeId)).toContain("n23");
    expect(() =>
      discover(graph(nodes), {
        query: "matching",
        includeNodeIds: Array.from({ length: 97 }, (_, i) => `x${i}`),
      }),
    ).toThrow("Invalid discovery request");
    expect(() =>
      discover(graph(nodes), {
        query: "matching",
        includeNodeIds: ["missing"],
      }),
    ).toThrow("unavailable");
    expect(() => discover(graph(nodes), { query: "" })).toThrow(
      "Search query is required",
    );
    expect(() =>
      discover(graph(nodes), { query: "", focusNodeId: "missing" }),
    ).toThrow("Focus node does not exist");
    const withCycle = graph(nodes, [edge("n00", "n24"), edge("n24", "n00")]);
    expect(
      discover(withCycle, { query: "", focusNodeId: "n00" }).candidates[0]
        ?.nodeId,
    ).toBe("n24");
  });
});

describe("native Effect TypeSafe workflow with controlled provider responses", () => {
  test("one batch captures typed results, asymmetric direction, and optional preparation without changing graph", async () => {
    const g = graph([
      node("task", "Run the deployment"),
      node("training", "Deployment training"),
    ]);
    const before = JSON.stringify(g);
    let calls = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* makeDiscovery(
          controlled((input) => {
            calls++;
            expect(Object.keys(input.questions)).toEqual([
              "relatedness_0",
              "match_0",
              "relation_0",
              "same_0",
            ]);
            expect(JSON.stringify(input.state)).not.toContain('"position"');
            expect(JSON.stringify(input.state)).not.toContain('"updated"');
            expect(JSON.stringify(input.state)).not.toContain('"created"');
            return Effect.succeed(
              response(input, { relation_0: "candidate_to_focus_1" }),
            );
          }),
        );
        return yield* service.evaluate(g, { query: "", focusNodeId: "task" });
      }),
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("succeeded");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      source: "training",
      target: "task",
      relation: "benefits_from",
      confidence: 1,
    });
    expect(result.suggestions[0]?.rationale).toStartWith("Code summary:");
    expect(result.resolvedModel).toBe("controlled-test-model");
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 17 });
    expect(result.rawResponse).not.toBeNull();
    expect(JSON.stringify(result.input)).toContain('"audit"');
    expect(JSON.stringify(result.input)).toContain('"updated"');
    expect(JSON.stringify(g)).toBe(before);
  });

  test("no-match yields no suggestions; semantic reranking beats misleading shared tokens", async () => {
    const noMatch = await evaluate(
      graph([node("use-jev", "Use Jev"), node("cat", "Feed cat")]),
      { relation_0: "no_match", match_0: "no_match", relatedness_0: 0 },
    );
    expect(noMatch.suggestions).toEqual([]);
    expect(noMatch.judgments[0]?.match).toBe(false);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* makeDiscovery(
          controlled((input) =>
            Effect.succeed(
              response(input, {
                match_0: "no_match",
                relatedness_0: 0,
                match_1: "match",
                relatedness_1: 2,
              }),
            ),
          ),
        );
        return yield* service.evaluate(synonymGraph, {
          query: "multi machine skills",
        });
      }),
    );
    expect(
      result.judgments.map((j) => [j.nodeId, j.match, j.relatedness]),
    ).toEqual([
      ["synonym", true, 1],
      ["word-trap", false, 0],
    ]);
    expect(result.suggestions).toEqual([]);
  });

  test("taxonomy edits change exact criteria/hash without rewriting a prior result", async () => {
    const first = await evaluate();
    const original = JSON.stringify(first);
    const changed = {
      ...tangle,
      revision: 2,
      taxonomy: {
        version: 2,
        relations: tangle.taxonomy.relations.map((r) =>
          r.id === "requires"
            ? {
                ...r,
                definition: "Only a legal prerequisite counts as required.",
              }
            : r,
        ),
      },
    };
    const second = await evaluate(changed);
    expect(second.inputHash).not.toBe(first.inputHash);
    expect(JSON.stringify(second.input)).toContain(
      "Only a legal prerequisite counts as required.",
    );
    expect(second.taxonomyVersion).toBe(2);
    expect(JSON.stringify(first)).toBe(original);
  });

  test("corrections and rejected reverse pairs suppress later model suggestions, including high confidence", async () => {
    const g = graph([node("use-jev", "Use Jev"), node("skill", "Jev skill")]);
    const corrected = {
      ...edge("use-jev", "skill", "benefits_from"),
      correction: {
        relation: "benefits_from",
        rationale: "Direct API use already works",
        state: "asserted" as const,
        provenance,
      },
    };
    const result = await evaluate(
      { ...g, edges: [corrected] },
      { relation_0: "candidate_to_focus_0" },
    );
    expect(result.suggestions).toEqual([]);
    expect(result.judgments[0]).toMatchObject({
      suppressed: true,
      confidence: 1,
      relation: "requires",
    });
    const rejected = await evaluate(g, { relation_0: "candidate_to_focus_0" });
    const suggestion = rejected.suggestions[0]!;
    const withRejection = {
      ...g,
      suggestions: [
        {
          ...suggestion,
          status: "rejected" as const,
          provenance,
          decision: provenance,
        },
      ],
    };
    expect(isProtectedPair(withRejection, "use-jev", "skill")).toBe(true);
    expect(
      (await evaluate(withRejection, { relation_0: "focus_to_candidate_0" }))
        .suggestions,
    ).toEqual([]);
  });

  test("delayed response retains original basis and is stale after correction or taxonomy edit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const service = yield* makeDiscovery(
          controlled((input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return response(input);
            }),
          ),
        );
        const fiber = yield* service
          .evaluate(tangle, { query: "", focusNodeId: "use-jev" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const newer = { ...tangle, revision: 2 };
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        expect(result.basedOnRevision).toBe(1);
        expect(evaluationIsCurrent(result, newer)).toBe(false);
        expect(
          evaluationIsCurrent(result, {
            ...tangle,
            taxonomy: { ...tangle.taxonomy, version: 2 },
          }),
        ).toBe(false);
        expect(evaluationIsCurrent(result, tangle)).toBe(true);
      }),
    );
  });

  test("identical inputs produce stable IDs for persistence idempotency", async () => {
    const first = await evaluate();
    const second = await evaluate();
    expect(second.id).toBe(first.id);
    expect(second.suggestions.map((s) => s.id)).toEqual(
      first.suggestions.map((s) => s.id),
    );
    expect(first.suggestions[0]?.evaluationId).toBe(first.id);
    expect(first.suggestions[0]?.inputHash).toBe(first.inputHash);
    expect(first.suggestions[0]?.evidence).toContain(
      "Context supplied: existing assertion use-jev-jev-skill (requires).",
    );
  });

  test("oversized evidence fails before a provider call rather than truncating context", async () => {
    let calls = 0;
    const oversized = {
      ...tangle,
      captures: Array.from({ length: 20 }, (_, i) => ({
        id: `capture-${i}`,
        text: "a".repeat(8000),
        sources: [],
        nodeIds: ["use-jev"],
        provenance,
      })),
    };
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* makeDiscovery(
          controlled((input) => {
            calls++;
            return Effect.succeed(response(input));
          }),
        );
        return yield* service
          .evaluate(oversized, { query: "", focusNodeId: "use-jev" })
          .pipe(Effect.flip);
      }),
    );
    expect(failure.message).toContain("128 KB");
    expect(calls).toBe(0);
  });

  test("production layer without a configured key returns unavailable, never a fabricated judgment", async () => {
    const result = await Effect.runPromise(
      Discovery.use((service) =>
        service.evaluate(tangle, { query: "", focusNodeId: "use-jev" }),
      ).pipe(
        Effect.provide(DiscoveryLive),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    );
    expect(result.status).toBe("unavailable");
    expect(result.failure?.code).toBe("NotConfigured");
    expect(result.judgments).toEqual([]);
    expect(result.suggestions).toEqual([]);
    expect(result.rawResponse).toBeNull();
  });

  test("provider failures, timeout, missing credential and malformed probabilities fail closed without secrets", async () => {
    const secretMarker = "secret-must-never-be-persisted";
    const error = AiError.make({
      module: "test",
      method: "systemOne",
      reason: new AiError.InvalidOutputError({ description: secretMarker }),
    });
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const failed = yield* makeDiscovery(
          controlled(() => Effect.fail(error)),
        );
        const timeout = yield* makeDiscovery(
          controlled(() => Effect.never),
          5,
        );
        const absent = yield* makeDiscovery(null);
        const malformed = yield* makeDiscovery(
          controlled((input) => {
            const valid = response(input);
            return Effect.succeed({
              ...valid,
              answers: {
                ...valid.answers,
                match_0: {
                  type: "choice" as const,
                  choice: "match",
                  probabilities: { match: 0.4, no_match: 0.4 },
                  confidence: 1,
                },
              },
            });
          }),
        );
        return yield* Effect.forEach(
          [failed, timeout, absent, malformed],
          (service) =>
            service.evaluate(tangle, { query: "", focusNodeId: "use-jev" }),
        );
      }),
    );
    expect(outcomes.map((r) => r.status)).toEqual([
      "failed",
      "failed",
      "unavailable",
      "failed",
    ]);
    expect(outcomes[1]?.failure?.code).toBe("Timeout");
    for (const outcome of outcomes) {
      expect(outcome.suggestions).toEqual([]);
      expect(outcome.judgments).toEqual([]);
      expect(outcome.inputHash).toHaveLength(64);
      expect(JSON.stringify(outcome)).not.toContain(secretMarker);
    }
  });

  test("provider concurrency is bounded to four requests", async () => {
    let active = 0;
    let peak = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* makeDiscovery(
          controlled((input) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active++;
                peak = Math.max(peak, active);
              }),
              () => Effect.sleep(5).pipe(Effect.as(response(input))),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            ),
          ),
        );
        yield* Effect.forEach(
          [1, 2, 3, 4, 5],
          () => service.evaluate(tangle, { query: "", focusNodeId: "use-jev" }),
          { concurrency: 5 },
        );
      }),
    );
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });
});

describe("token-budget packing", () => {
  test("a large graph is packed to the soft target, best first, explicit kept", () => {
    const nodes = Array.from({ length: 300 }, (_, i) =>
      node(
        `m${i.toString().padStart(3, "0")}`,
        `Deploy release candidate ${i}`,
        "Ship the build to production after the checks pass.",
      ),
    );
    const g = graph([node("focus", "Deploy the release"), ...nodes]);
    const packed = discover(g, {
      query: "",
      focusNodeId: "focus",
      includeNodeIds: ["m299"],
    });
    expect(packed.candidates[0]?.nodeId).toBe("m299");
    expect(packed.candidates.length).toBeGreaterThan(8);
    expect(packed.candidates.length).toBeLessThan(300);
    expect(packed.coverage).toMatchObject({
      eligible: 300,
      truncated: true,
      strategy: "budget",
    });
    expect(packed.coverage.estimatedTokens).toBeLessThanOrEqual(
      TARGET_INPUT_TOKENS,
    );
    // Only-requests judge what they name, however large the graph.
    const only = discover(g, {
      query: "",
      focusNodeId: "focus",
      includeNodeIds: ["m001", "m002"],
      only: true,
    });
    expect(only.candidates.map((c) => c.nodeId)).toEqual(["m001", "m002"]);
  });
});

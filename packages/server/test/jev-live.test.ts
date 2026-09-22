import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";
import { TypeSafeClient, TypeSafeSchema } from "@effect/ai-typesafe";
import { createApp } from "../src/app";
import {
  Discovery,
  MAX_CONNECTIONS,
  makeDiscovery,
  ownerCorrections,
} from "../src/discovery";

type Request = typeof TypeSafeSchema.SystemOneRequest.Encoded;
type Response = typeof TypeSafeSchema.SystemOneResponse.Type;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Answers by candidate title so tests read like the owner's world model.
type Verdict = {
  related?: number;
  match?: boolean;
  relation?: string;
  same?: boolean;
};
const judge =
  (verdicts: Record<string, Verdict>, seen: Request[] = []) =>
  (request: Request): Response => {
    seen.push(request);
    const state = request.state as {
      candidates: Array<{ title: string }>;
    };
    const answers: Record<string, typeof TypeSafeSchema.Answer.Type> = {};
    const choice = (key: string, value: string) => {
      const question = request.questions[key]!;
      if (question.type !== "choice") throw new Error(key);
      answers[key] = {
        type: "choice",
        choice: value,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((label) => [
            label,
            label === value ? 1 : 0,
          ]),
        ),
        confidence: 0.9,
      };
    };
    for (const [index, candidate] of state.candidates.entries()) {
      const verdict = verdicts[candidate.title] ?? {};
      const score = verdict.related ?? 0;
      if (request.questions[`coarse_${index}`]) {
        // A coarse rerank batch asks one relatedness question per candidate.
        answers[`coarse_${index}`] = {
          type: "score",
          score,
          probabilities: {
            "0": 0,
            "1": 0,
            "2": 0,
            [String(Math.round(score))]: 1,
          },
          confidence: 1,
        };
        continue;
      }
      answers[`relatedness_${index}`] = {
        type: "score",
        score,
        probabilities: {
          "0": 0,
          "1": 0,
          "2": 0,
          [String(Math.round(score))]: 1,
        },
        confidence: 1,
      };
      choice(`match_${index}`, verdict.match ? "match" : "no_match");
      if (request.questions[`relation_${index}`])
        choice(`relation_${index}`, verdict.relation ?? "no_match");
      if (request.questions[`same_${index}`])
        choice(`same_${index}`, verdict.same ? "same" : "different");
    }
    return { model: "controlled-jev", answers, usage: undefined };
  };

const controlled = (answer: (request: Request) => Response) =>
  Layer.effect(
    Discovery,
    makeDiscovery({
      client: HttpClient.make(() => Effect.die("Unexpected HTTP")),
      systemOne: (request) =>
        Effect.succeed(answer(request as unknown as Request)),
      listModels: () => Effect.succeed({ models: [] }),
    } as TypeSafeClient.Service),
  );

async function fixture(layer: Layer.Layer<Discovery, unknown>) {
  const dir = await mkdtemp(`${tmpdir()}/yakjev-jev-live-`);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const options = {
    origin: "https://yakjev.test",
    databasePath: `${dir}/graph.sqlite`,
    webRoot: `${dir}/web`,
    ownerToken: "synthetic-owner-token-jev-live-tests",
  };
  const app = createApp(options, layer);
  cleanups.push(() => app.close());
  const call = async (path: string, body?: unknown) => {
    const response = await app.fetch(
      new Request(`${options.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${options.ownerToken}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  let request = 0;
  const graph = async () => (await call("/api/graph")).body;
  const command = async (command: unknown) => {
    const current = await graph();
    const result = await call("/api/commands", {
      requestId: `test-${++request}`,
      expectedRevision: current.revision,
      command,
    });
    expect(result.status).toBe(200);
    return result.body;
  };
  const capture = (id: string, title: string, autoConnect?: boolean) =>
    command({
      type: "capture",
      capture: { id: `capture-${id}`, text: title, sources: [], nodeIds: [id] },
      nodes: [
        {
          id,
          title,
          description: "",
          project: "",
          status: "idea",
          sources: [],
        },
      ],
      edges: [],
      ...(autoConnect === undefined ? {} : { autoConnect }),
    });
  // Background connection is asynchronous: wait for the graph to settle.
  const settle = async (predicate: (graph: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const current = await graph();
      if (predicate(current)) return current;
      await Bun.sleep(10);
    }
    throw new Error("graph never settled");
  };
  return { call, graph, command, capture, settle };
}

test("typing preview judges a draft without writing anything", async () => {
  const { call, capture, graph } = await fixture(
    controlled(
      judge({
        "Ship the deploy pipeline": {
          related: 2,
          match: true,
          relation: "focus_to_candidate_0",
        },
        "Bake sourdough": { related: 0 },
        "Deploy pipeline shipping": { related: 2, match: true, same: true },
      }),
    ),
  );
  await capture("pipeline", "Ship the deploy pipeline", false);
  await capture("bread", "Bake sourdough", false);
  await capture("echo", "Deploy pipeline shipping", false);
  const before = await graph();
  const preview = await call("/api/jev/preview", {
    draft: { title: "Get CI green before deploying" },
  });
  expect(preview.status).toBe(200);
  expect(preview.body.status).toBe("succeeded");
  expect(preview.body.basedOnRevision).toBe(before.revision);
  const byId = Object.fromEntries(
    preview.body.judgments.map((j: any) => [j.nodeId, j]),
  );
  expect(byId.pipeline).toMatchObject({
    connect: true,
    relation: "requires",
    direction: "focus_to_candidate",
  });
  expect(byId.bread).toMatchObject({ connect: false, relation: null });
  // Same intention restated connects even without a named relation.
  expect(byId.echo).toMatchObject({
    connect: true,
    same: true,
    relation: "related_to",
  });
  expect((await graph()).revision).toBe(before.revision);
  // Empty drafts cost nothing.
  const empty = await call("/api/jev/preview", { draft: { title: "  " } });
  expect(empty.body.judgments).toEqual([]);
});

test("a capture is connected by Jev in the background, as Jev", async () => {
  const { capture, settle } = await fixture(
    controlled(
      judge({
        "Write the launch post": {
          related: 2,
          match: true,
          relation: "candidate_to_focus_1",
        },
        "Bake sourdough": {
          related: 0,
          match: true,
          relation: "focus_to_candidate_3",
        },
      }),
    ),
  );
  await capture("post", "Write the launch post", false);
  await capture("bread", "Bake sourdough", false);
  await capture("launch", "Launch the product");
  const graph = await settle((g) => g.edges.length > 0);
  expect(graph.edges).toHaveLength(1);
  const [edge] = graph.edges;
  // candidate_to_focus: the post benefits from the launch.
  expect(edge).toMatchObject({
    source: "post",
    target: "launch",
    relation: "benefits_from",
    state: "asserted",
    origin: { model: "controlled-jev", confidence: 0.9 },
  });
  expect(edge.assertion.provenance.actor).toEqual({
    id: "jev",
    channel: "system",
  });
  // Recorded as accepted, never left pending.
  expect(graph.suggestions.every((s: any) => s.status === "accepted")).toBe(
    true,
  );
});

test("autoConnect:false keeps the capture exactly as sent", async () => {
  let calls = 0;
  const { capture, graph } = await fixture(
    controlled((request) => {
      calls++;
      return judge({})(request);
    }),
  );
  await capture("a", "One", false);
  await capture("b", "Two", false);
  await Bun.sleep(50);
  expect(calls).toBe(0);
  expect((await graph()).edges).toEqual([]);
});

test("removing Jev's edge teaches Jev and it never reconnects the pair", async () => {
  const seen: Request[] = [];
  const { capture, command, settle, call } = await fixture(
    controlled(
      judge(
        {
          "Plan the offsite": {
            related: 2,
            match: true,
            relation: "focus_to_candidate_0",
          },
          "Book the venue": {
            related: 2,
            match: true,
            relation: "candidate_to_focus_0",
          },
        },
        seen,
      ),
    ),
  );
  await capture("plan", "Plan the offsite", false);
  await capture("venue", "Book the venue");
  const connected = await settle((g) => g.edges.length === 1);
  const edge = connected.edges[0];
  await command({ type: "edge.remove", id: edge.id });
  const after = await (await call("/api/graph")).body;
  expect(ownerCorrections(after)).toEqual([
    {
      source: after.nodes.find((n: any) => n.id === edge.source).title,
      target: after.nodes.find((n: any) => n.id === edge.target).title,
      jevSaid: "requires",
      ownerSaid: "not connected: the owner removed this connection",
    },
  ]);
  const preview = await call("/api/jev/preview", { focusNodeId: "venue" });
  expect(preview.body.judgments[0]).toMatchObject({
    nodeId: "plan",
    suppressed: true,
    connect: false,
  });
  // The correction reached Jev as precedent.
  expect(JSON.stringify(seen.at(-1)!.state)).toContain(
    "the owner removed this connection",
  );
});

test("reframing Jev's edge is recorded as an owner correction", async () => {
  const { capture, command, settle } = await fixture(
    controlled(
      judge({
        "Learn Rust": {
          related: 2,
          match: true,
          relation: "candidate_to_focus_0",
        },
      }),
    ),
  );
  await capture("rust", "Learn Rust", false);
  await capture("cli", "Rewrite the CLI in Rust");
  const connected = await settle((g) => g.edges.length === 1);
  await command({
    type: "edge.reframe",
    id: connected.edges[0].id,
    relation: "benefits_from",
    rationale: "Nice to have, not required.",
    state: "asserted",
  });
  const graph = await settle((g) => g.edges[0].correction !== null);
  expect(ownerCorrections(graph)).toMatchObject([
    { jevSaid: "requires", ownerSaid: "benefits_from" },
  ]);
});

test("Jev connects at most MAX_CONNECTIONS, strongest first", async () => {
  const verdicts: Record<string, Verdict> = {};
  for (let i = 0; i < 7; i++)
    verdicts[`Related ${i}`] = {
      related: i < 2 ? 1 : 2,
      match: true,
      relation: "focus_to_candidate_3",
    };
  const { capture, settle } = await fixture(controlled(judge(verdicts)));
  for (let i = 0; i < 7; i++) await capture(`r${i}`, `Related ${i}`, false);
  await capture("hub", "Hub");
  const graph = await settle((g) => g.edges.length > 0);
  expect(graph.edges).toHaveLength(MAX_CONNECTIONS);
  // relatedness 0.5 loses to 1.0.
  expect(graph.edges.map((e: any) => e.target).sort()).toEqual([
    "r2",
    "r3",
    "r4",
    "r5",
  ]);
});

test("no provider key: preview says unavailable and captures stay unconnected", async () => {
  const { call, capture, graph } = await fixture(
    Layer.effect(Discovery, makeDiscovery(null)),
  );
  await capture("a", "One", false);
  await capture("b", "Two");
  const preview = await call("/api/jev/preview", { draft: { title: "Three" } });
  expect(preview.body).toMatchObject({ status: "unavailable", judgments: [] });
  await Bun.sleep(50);
  const current = await graph();
  expect(current.edges).toEqual([]);
  // No failed evaluations clutter the journal.
  expect(current.evaluations).toEqual([]);
});

test("a restated intention is linked as related and marked the same", async () => {
  const { capture, settle } = await fixture(
    controlled(
      judge({
        "Deploy yakjev to Railway": {
          related: 2,
          match: true,
          same: true,
          relation: "candidate_to_focus_2",
        },
      }),
    ),
  );
  await capture("deploy", "Deploy yakjev to Railway", false);
  await capture("ship", "Ship yakjev to production");
  const graph = await settle((g) => g.edges.length === 1);
  expect(graph.edges[0]).toMatchObject({
    source: "ship",
    target: "deploy",
    relation: "related_to",
    origin: { same: true },
  });
});

test("editing an intention's words reconnects it; status changes do not", async () => {
  let calls = 0;
  const judged = judge({
    "Hire a designer": {
      related: 2,
      match: true,
      relation: "focus_to_candidate_3",
    },
  });
  const { capture, command, settle } = await fixture(
    controlled((request) => {
      calls++;
      return judged(request);
    }),
  );
  await capture("designer", "Hire a designer", false);
  await capture("site", "Website", false);
  const node = {
    id: "site",
    title: "Website",
    description: "",
    project: "",
    status: "active",
    sources: [],
  };
  await command({ type: "node.put", node });
  await Bun.sleep(30);
  expect(calls).toBe(0);
  await command({
    type: "node.put",
    node: { ...node, title: "Redesign the website" },
  });
  const graph = await settle((g) => g.edges.length === 1);
  expect(calls).toBe(1);
  expect(graph.edges[0]).toMatchObject({ source: "site", target: "designer" });
});

test("rounded provider probabilities do not fail a whole batch", async () => {
  // Jev rounds: an 11-label distribution can sum to 0.9996.
  const rounded = (request: Request): Response => {
    const response = judge({
      "Book flights": {
        related: 2,
        match: true,
        relation: "candidate_to_focus_0",
      },
    })(request);
    const answers = { ...response.answers };
    for (const [key, answer] of Object.entries(answers))
      if (answer.type === "choice" && key.startsWith("relation"))
        answers[key] = {
          ...answer,
          probabilities: Object.fromEntries(
            Object.entries(answer.probabilities).map(([label, value]) => [
              label,
              value === 1 ? 0.9 : 0.0099,
            ]),
          ),
        };
    return { ...response, answers };
  };
  const { call, capture } = await fixture(controlled(rounded));
  await capture("flights", "Book flights", false);
  const preview = await call("/api/jev/preview", {
    draft: { title: "Plan the Lisbon trip" },
  });
  expect(preview.body.status).toBe("succeeded");
  expect(preview.body.judgments[0]).toMatchObject({
    nodeId: "flights",
    connect: true,
  });
});

test("when nothing clears the bar, the strongest clear match still connects", async () => {
  const { call, capture } = await fixture(
    controlled(
      judge({
        // 0.625 relatedness: under CONNECT_RELATEDNESS, over TOP_RELATEDNESS.
        "Raise the garden beds": {
          related: 1.25,
          match: true,
          relation: "focus_to_candidate_0",
        },
        "Buy compost": { related: 1.22, match: true },
        "Paint the fence": {
          related: 1.0,
          match: true,
          relation: "focus_to_candidate_3",
        },
      }),
    ),
  );
  await capture("beds", "Raise the garden beds", false);
  await capture("compost", "Buy compost", false);
  await capture("fence", "Paint the fence", false);
  const preview = await call("/api/jev/preview", {
    draft: {
      title: "Double-dig the new bed",
      description: "A long description.",
    },
  });
  const connected = preview.body.judgments.filter((j: any) => j.connect);
  expect(connected).toHaveLength(1);
  expect(connected[0]).toMatchObject({ nodeId: "beds", relation: "requires" });
});

test("every provider call lands in the Jev call log with purpose and tokens", async () => {
  const { call, capture, settle } = await fixture(
    controlled((request) => ({
      ...judge({
        "Book flights": {
          related: 2,
          match: true,
          relation: "focus_to_candidate_1",
        },
      })(request),
      usage: { input_tokens: 1200, output_tokens: 80 },
    })),
  );
  await capture("flights", "Book flights", false);
  await call("/api/jev/preview", {
    draft: { title: "Plan the trip" },
    purpose: "typing",
  });
  await capture("trip", "Plan the trip");
  await settle((g) => g.edges.length === 1);
  await call("/api/jev/preview", { focusNodeId: "flights", purpose: "drag" });
  const log = (await call("/api/jev/calls")).body;
  expect(log.calls.map((c: any) => c.purpose)).toEqual([
    "drag",
    "auto-connect",
    "typing",
  ]);
  expect(log.calls[0]).toMatchObject({
    status: "succeeded",
    candidates: 1,
    inputTokens: 1200,
    outputTokens: 80,
    model: "controlled-jev",
    costUsd: null,
  });
  expect(log.totals).toMatchObject({
    calls: 3,
    failed: 0,
    inputTokens: 3600,
    outputTokens: 240,
    costUsd: null,
  });
  expect(log.pricing).toBeNull();
});

test("an only-preview judges just the nodes it names", async () => {
  const seen: Request[] = [];
  const { call, capture } = await fixture(controlled(judge({}, seen)));
  for (const [id, title] of [
    ["a", "Alpha"],
    ["b", "Beta"],
    ["c", "Gamma"],
    ["d", "Delta"],
  ] as const)
    await capture(id, title, false);
  await call("/api/jev/preview", {
    focusNodeId: "a",
    includeNodeIds: ["c"],
    only: true,
    purpose: "drag",
  });
  const state = seen.at(-1)!.state as { candidates: Array<{ id: string }> };
  expect(state.candidates.map((node) => node.id)).toEqual(["c"]);
  const log = (await call("/api/jev/calls")).body;
  expect(log.calls[0]).toMatchObject({ purpose: "drag", candidates: 1 });
});

test("workspace context is journaled and reaches every Jev call", async () => {
  const seen: Request[] = [];
  const { call, capture, command, graph, settle } = await fixture(
    controlled(
      judge(
        {
          "Book flights": {
            related: 2,
            match: true,
            relation: "focus_to_candidate_1",
          },
        },
        seen,
      ),
    ),
  );
  await capture("flights", "Book flights", false);
  await command({
    type: "jev.context.set",
    text: "  I live in Lisbon; trips mean work travel.  ",
  });
  expect((await graph()).jevContext).toMatchObject({
    text: "I live in Lisbon; trips mean work travel.",
    updated: { revision: 2 },
  });
  await call("/api/jev/preview", { draft: { title: "Plan the trip" } });
  await capture("trip", "Plan the trip");
  await settle((g) => g.edges.length === 1);
  const contexts = seen.map(
    (request) =>
      (request.state as { workspaceContext: unknown }).workspaceContext,
  );
  expect(contexts).toEqual([
    "I live in Lisbon; trips mean work travel.",
    "I live in Lisbon; trips mean work travel.",
  ]);
  await command({ type: "jev.context.set", text: "   " });
  expect((await graph()).jevContext).toBeNull();
  const current = await graph();
  await command({ type: "undo", revision: current.revision });
  expect((await graph()).jevContext?.text).toBe(
    "I live in Lisbon; trips mean work travel.",
  );
});

test("on a large graph, a coarse Jev pass lifts a buried paraphrase into the judged bag", async () => {
  const { call, capture } = await fixture(
    controlled(
      judge({
        "Book a dentist appointment": {
          related: 2,
          match: true,
          relation: "focus_to_candidate_3",
        },
      }),
    ),
  );
  // 60 word-overlap traps rank above the target, which shares no words.
  for (let i = 0; i < 60; i++)
    await capture(
      `trap${i.toString().padStart(2, "0")}`,
      `Schedule a checkup of the car ${i}`,
      false,
    );
  await capture("dentist", "Book a dentist appointment", false);
  const preview = await call("/api/jev/preview", {
    draft: { title: "Schedule a dental checkup" },
  });
  expect(preview.body.status).toBe("succeeded");
  expect(
    preview.body.judgments.find((j: any) => j.nodeId === "dentist"),
  ).toMatchObject({ connect: true });
  const log = (await call("/api/jev/calls")).body;
  const purposes = log.calls.map((c: any) => c.purpose);
  expect(purposes).toContain("rerank");
  expect(purposes[0]).toBe("preview");
});

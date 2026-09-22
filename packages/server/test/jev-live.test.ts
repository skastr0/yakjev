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
  related?: 0 | 1 | 2;
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
      answers[`relatedness_${index}`] = {
        type: "score",
        score,
        probabilities: { "0": 0, "1": 0, "2": 0, [String(score)]: 1 },
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

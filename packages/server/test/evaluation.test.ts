import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { createApp } from "../src/app";
import { Discovery, makeDiscovery } from "../src/discovery";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  discoveryLayer = Layer.effect(Discovery, makeDiscovery(null)),
) {
  const dir = await mkdtemp(`${tmpdir()}/yakjev-evaluation-`);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const options = {
    origin: "https://yakjev.test",
    databasePath: `${dir}/graph.sqlite`,
    webRoot: `${dir}/web`,
    ownerToken: "synthetic-owner-token-evaluation-tests",
  };
  const open = () => {
    const app = createApp(options, discoveryLayer);
    cleanups.push(() => app.close());
    const request = (path: string, body?: unknown) =>
      app.fetch(
        new Request(`${options.origin}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${options.ownerToken}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    return { app, request };
  };
  return { ...open(), open, options };
}

test("real evaluation routes preserve unavailable result, small summary, durable replay and no assertions", async () => {
  const { app, request, open, options } = await fixture();
  const input = {
    requestId: "evaluate-once",
    expectedRevision: 0,
    query: "Useful preparation",
  };
  const response = await request("/api/evaluations", input);
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first).toMatchObject({
    receipt: { revision: 1, type: "evaluation.record" },
    replayed: false,
  });
  const graph = await (await request("/api/graph")).json();
  expect(graph.evaluations).toHaveLength(1);
  expect(graph.evaluations[0]).toMatchObject({
    id: first.evaluationId,
    status: "unavailable",
  });
  expect(graph.evaluations[0].result).toBeUndefined();
  expect(graph.edges).toHaveLength(0);
  const full = await (
    await request(`/api/evaluations/${encodeURIComponent(first.evaluationId)}`)
  ).json();
  expect(full.result).toMatchObject({
    status: "unavailable",
    failure: { code: "NotConfigured" },
    request: input,
  });
  const db = new Database(options.databasePath);
  expect(
    db
      .query(
        "SELECT json_extract(before_graph, '$.revision') AS revision, json_array_length(json_extract(before_graph, '$.evaluations')) AS count FROM graph_history",
      )
      .get(),
  ).toEqual({ revision: 0, count: 0 });
  db.close();
  await app.close();
  const reopened = open();
  const replay = await reopened.request("/api/evaluations", input);
  expect(await replay.json()).toEqual({ ...first, replayed: true });
  expect(
    (
      await reopened.request("/api/evaluations", {
        ...input,
        query: "Changed request",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await reopened.request("/api/evaluations", {
        ...input,
        requestId: "stale",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await reopened.request(
        "/api/discovery?query=example&includeNodeIds=missing",
      )
    ).status,
  ).toBe(400);
  expect(
    await (await reopened.request("/api/discovery?query=example")).json(),
  ).toMatchObject({
    candidates: [],
    coverage: { considered: 0, truncated: false },
  });
});

test("concurrent duplicate evaluation invokes provider once; raw audit is never copied into graph or undo images", async () => {
  let calls = 0;
  const discovery = Layer.effect(
    Discovery,
    Effect.gen(function* () {
      const base = yield* makeDiscovery(null);
      return Discovery.of({
        shortlist: base.shortlist,
        evaluate: (graph, request) =>
          Effect.gen(function* () {
            calls++;
            yield* Effect.sleep("10 millis");
            const result = yield* base.evaluate(graph, request);
            return {
              ...result,
              status: "succeeded" as const,
              failure: null,
              rawResponse: { payload: "audit-marker".repeat(4000) },
            };
          }),
      });
    }),
  );
  const { request, options } = await fixture(discovery);
  const input = {
    requestId: "duplicate",
    expectedRevision: 0,
    query: "Example",
  };
  const results = await Promise.all([
    request("/api/evaluations", input),
    request("/api/evaluations", input),
  ]);
  expect(results.map((response) => response.status)).toEqual([200, 200]);
  const bodies = await Promise.all(results.map((response) => response.json()));
  expect(bodies.map((body) => body.replayed).sort()).toEqual([false, true]);
  expect(calls).toBe(1);
  for (let revision = 1; revision < 5; revision++) {
    expect(
      (
        await request("/api/commands", {
          requestId: `layout-${revision}`,
          expectedRevision: revision,
          command: { type: "layout.set", positions: [] },
        })
      ).status,
    ).toBe(200);
  }
  const graph = await (await request("/api/graph")).text();
  expect(graph.length).toBeLessThan(5000);
  expect(graph).not.toContain("audit-marker");
  const db = new Database(options.databasePath);
  const before = db.query("SELECT before_graph FROM graph_history").all();
  expect(JSON.stringify(before)).not.toContain("audit-marker");
  db.close();
  const audit = await (
    await request(`/api/evaluations/${bodies[0].evaluationId}`)
  ).text();
  expect(audit).toContain("audit-marker");
});

test("graph edit while provider is evaluating rejects stale result atomically", async () => {
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discovery = Layer.effect(
    Discovery,
    Effect.gen(function* () {
      const base = yield* makeDiscovery(null);
      return Discovery.of({
        shortlist: base.shortlist,
        evaluate: (graph, request) =>
          Effect.gen(function* () {
            yield* Effect.sync(started);
            yield* Effect.promise(() => releasePromise);
            return yield* base.evaluate(graph, request);
          }),
      });
    }),
  );
  const { request } = await fixture(discovery);
  const evaluating = request("/api/evaluations", {
    requestId: "delayed",
    expectedRevision: 0,
    query: "Example",
  });
  await startedPromise;
  expect(
    (
      await request("/api/commands", {
        requestId: "intervening",
        expectedRevision: 0,
        command: {
          type: "node.put",
          node: {
            id: "new",
            title: "Edit during call",
            description: "",
            project: "test",
            status: "idea",
            sources: [],
          },
        },
      })
    ).status,
  ).toBe(200);
  release();
  expect((await evaluating).status).toBe(409);
  const graph = await (await request("/api/graph")).json();
  expect(graph.revision).toBe(1);
  expect(graph.evaluations).toHaveLength(0);
  expect(graph.suggestions).toHaveLength(0);
});

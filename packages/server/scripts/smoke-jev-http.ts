import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Graph } from "@yakjev/protocol";
import { createApp } from "../src/app.ts";
import { tangle } from "../test/discovery.fixture.ts";

// Opt-in integration receipt. HTTP writes affect only a disposable synthetic database.
const unavailable = process.argv.includes("--unavailable");
if (unavailable === Boolean(process.env.TYPESAFE_API_KEY)) {
  console.error(
    unavailable
      ? "Unset TYPESAFE_API_KEY for the unavailable-provider check."
      : "Configure TYPESAFE_API_KEY for the real-provider check, or pass --unavailable without it.",
  );
  process.exit(1);
}

const dir = await mkdtemp(`${tmpdir()}/yakjev-jev-http-`);
const origin = "http://yakjev-synthetic.test";
const ownerToken = "synthetic-http-smoke-owner-token-not-a-secret";
const options = {
  origin,
  ownerToken,
  databasePath: `${dir}/graph.sqlite`,
  webRoot: `${dir}/web`,
};
let app = createApp(options);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => app.fetch(request),
});
const request = (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: new URL(origin).host,
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

try {
  await app.ready();
  const capture = await request("/api/commands", {
    requestId: "synthetic-capture",
    expectedRevision: 0,
    command: {
      type: "capture",
      capture: {
        id: "synthetic-capture",
        text: "Unverified synthetic tangle for an HTTP integration check.",
        sources: [],
        nodeIds: tangle.nodes.map((node) => node.id),
      },
      nodes: tangle.nodes.map(
        ({ position: _, created: __, updated: ___, ...node }) => node,
      ),
      edges: tangle.edges.map(
        ({
          state: _,
          assertion: __,
          correction: ___,
          updated: ____,
          ...edge
        }) => edge,
      ),
    },
  });
  assert.equal(capture.status, 200, await capture.text());
  const proximity = await request("/api/discovery?focusNodeId=use-jev");
  assert.equal(proximity.status, 200);
  const discovered = await proximity.json();
  assert.equal(discovered.coverage.considered, 4);
  const payload = {
    requestId: "synthetic-evaluation",
    expectedRevision: 1,
    query: "",
    focusNodeId: "use-jev",
  };
  const evaluated = await request("/api/evaluations", payload);
  assert.equal(evaluated.status, 200);
  const result = await evaluated.json();
  assert.equal(result.replayed, false);
  const blobResponse = await request(
    `/api/evaluations/${encodeURIComponent(result.evaluationId)}`,
  );
  assert.equal(blobResponse.status, 200);
  const blob = await blobResponse.json();
  assert.equal(blob.result.status, unavailable ? "unavailable" : "succeeded");
  assert.equal(blob.inputHash, blob.result.inputHash);
  assert.deepEqual(blob.result.request, payload);
  const graphResponse = await request("/api/graph");
  const graph: Graph = await graphResponse.json();
  assert.equal(graph.evaluations.length, 1);
  assert.equal(
    graph.edges.length,
    tangle.edges.length,
    "Evaluation must never auto-apply an edge",
  );
  assert.equal(
    "result" in graph.evaluations[0]!,
    false,
    "Graph must contain summary, not raw evaluation blob",
  );
  if (unavailable) {
    assert.deepEqual(blob.result.suggestions, []);
    assert.deepEqual(blob.result.judgments, []);
  }
  const replayResponse = await request("/api/evaluations", payload);
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.evaluationId, result.evaluationId);
  assert.equal(
    (await (await request("/api/graph")).json()).revision,
    graph.revision,
  );
  const changedRequest = await request("/api/evaluations", {
    ...payload,
    query: "different request",
  });
  assert.equal(changedRequest.status, 409);
  const invalidReference = await request(
    "/api/discovery?query=skills&includeNodeIds=missing",
  );
  assert.equal(invalidReference.status, 400);
  await app.close();
  app = createApp(options);
  await app.ready();
  const afterRestart = await request("/api/evaluations", payload);
  assert.equal(afterRestart.status, 200);
  assert.equal((await afterRestart.json()).replayed, true);
  const recovered = await request(
    `/api/evaluations/${encodeURIComponent(result.evaluationId)}`,
  );
  assert.deepEqual(await recovered.json(), blob);
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        transport: "HTTP over ephemeral loopback TCP",
        provider: unavailable ? "unavailable by design" : "real TypeSafe API",
        checks: [
          "capture persisted",
          "lexical discovery",
          "evaluation recorded",
          "encoded-id blob lookup",
          "summary-only graph",
          "no auto-accepted edge",
          "request replay",
          "altered-request conflict",
          "invalid candidate rejection",
          "replay and exact blob recovery after restart",
        ],
        evaluation: blob,
      },
      null,
      2,
    ),
  );
} finally {
  await server.stop(true);
  await app.close();
  await rm(dir, { recursive: true, force: true });
}

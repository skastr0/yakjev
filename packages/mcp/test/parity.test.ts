import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { BunServices } from "@effect/platform-bun";
import { Auth } from "@yakjev/server/auth";
import { Store, storeLayer } from "@yakjev/server/store";
import { mcpLayer, provideActor } from "../src/index.ts";

const origin = "https://yakjev.example.ts.net";
const token = "owner-token-at-least-32-characters-long";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const harness = async () => {
  const dir = await mkdtemp(`${tmpdir()}/yakjev-mcp-`);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const app = HttpRouter.toWebHandler(
    mcpLayer({ origin }).pipe(
      Layer.provide(storeLayer(`${dir}/graph.sqlite`)),
      Layer.provide(
        Auth.layer({ origin, ownerToken: token, ownerId: "owner" }),
      ),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(BunServices.layer),
    ),
    { disableLogger: true },
  );
  cleanups.push(() => app.dispose());
  const actor = await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return yield* auth.bearer({ authorization: `Bearer ${token}` });
    }).pipe(
      Effect.provide(
        Auth.layer({ origin, ownerToken: token, ownerId: "owner" }),
      ),
    ),
  );
  const mcp = (body: unknown, headers: Record<string, string> = {}) =>
    app.handler(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      provideActor(actor),
    );
  const httpCommand = (body: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.execute(actor, body);
      }).pipe(Effect.provide(storeLayer(`${dir}/graph.sqlite`)), Effect.result),
    );
  return { dir, mcp, httpCommand, actor };
};

test("MCP capture and HTTP command share one SQLite revision", async () => {
  const { mcp, httpCommand } = await harness();
  const initialized = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "parity", version: "0" },
    },
  });
  expect(initialized.status).toBe(200);
  const session = initialized.headers.get("mcp-session-id");
  expect(session).toBeTruthy();
  const capture = {
    requestId: "req-mcp",
    expectedRevision: 0,
    command: {
      type: "capture",
      capture: {
        id: "cap-1",
        text: "Claimed chain, not a verified dependency.",
        sources: [],
        nodeIds: ["n1"],
      },
      nodes: [
        {
          id: "n1",
          title: "Jev skill",
          description: "claim",
          project: "yakjev",
          status: "idea",
          sources: [],
        },
      ],
      edges: [],
    },
  };
  const called = await mcp(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "graph_command", arguments: capture },
    },
    { "mcp-session-id": session!, "mcp-protocol-version": "2025-06-18" },
  );
  const body = await called.json();
  expect(body.result?.isError).toBe(false);
  const stale = await httpCommand({
    ...capture,
    requestId: "req-http",
    expectedRevision: 0,
  });
  expect(stale._tag).toBe("Failure");
  if (stale._tag === "Failure") {
    const error = stale.failure;
    expect("code" in error ? error.code : "").toBe("Conflict");
  }

  const replay = await mcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "graph_command", arguments: capture },
    },
    { "mcp-session-id": session!, "mcp-protocol-version": "2025-06-18" },
  );
  const replayBody = await replay.json();
  expect(JSON.parse(replayBody.result.content[0].text).replayed).toBe(true);

  const claimed = await mcp(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "graph_command",
        arguments: {
          ...capture,
          requestId: "req-actor",
          actor: { id: "other", channel: "browser" },
        },
      },
    },
    { "mcp-session-id": session!, "mcp-protocol-version": "2025-06-18" },
  );
  const claimedBody = await claimed.json();
  expect(claimedBody.error.code).toBe(-32602);

  const unknownRelation = await httpCommand({
    requestId: "req-bad-rel",
    expectedRevision: 1,
    command: {
      type: "edge.put",
      edge: {
        id: "e1",
        source: "n1",
        target: "missing",
        relation: "not-a-relation",
        rationale: "no",
      },
    },
  });
  expect(unknownRelation._tag).toBe("Failure");
});

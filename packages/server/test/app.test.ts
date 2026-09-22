import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { Layer } from "effect";
import { createApp } from "../src/app";
import { Discovery, makeDiscovery } from "../src/discovery";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dir = await mkdtemp(`${tmpdir()}/yakjev-`);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(`${dir}/web/assets`, { recursive: true });
  await writeFile(`${dir}/web/index.html`, "<h1>yakjev</h1>");
  await writeFile(`${dir}/secret.txt`, "private fixture");
  const options = {
    databasePath: `${dir}/graph.sqlite`,
    webRoot: `${dir}/web`,
    origin: "https://yakjev.example.com",
    ownerToken: "synthetic-owner-test-token-with-40-characters",
  };
  const app = createApp(options, Layer.effect(Discovery, makeDiscovery(null)));
  cleanups.push(() => app.close());
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${options.origin}${path}`, init));
  return { app, options, request };
}

test("SQLite health and static entrypoint work, including after reopening the store", async () => {
  const { app, options, request } = await fixture();
  expect(await (await request("/healthz")).json()).toEqual({
    service: "yakjev",
    status: "ok",
    stage: "graph",
    storage: "sqlite",
  });
  expect(await (await request("/")).text()).toBe("<h1>yakjev</h1>");
  await app.close();
  const reopened = createApp(options);
  cleanups.push(() => reopened.close());
  expect((await reopened.ready()).storage).toBe("sqlite");
});

test("hashed public assets negotiate prebuilt gzip and cache without caching private data", async () => {
  const { request, options } = await fixture();
  const path = "/assets/index-A1b2C3d4.js";
  const source =
    'console.log("A synthetic graph asset, not private graph data");\n'.repeat(
      50,
    );
  await writeFile(`${options.webRoot}${path}`, source);
  await writeFile(`${options.webRoot}${path}.gz`, gzipSync(source));
  for (const [encoding, compressed] of [
    ["gzip", true],
    ["br, GZip ; q=0.5", true],
    ["gzip;q=0, br", false],
    ["gzip;q=0.000, *;q=1", false],
    ["identity", false],
    ["", false],
  ] as const) {
    const response = await request(path, {
      headers: { "accept-encoding": encoding },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe(
      compressed ? "gzip" : null,
    );
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
    expect(
      new TextDecoder().decode(compressed ? Bun.gunzipSync(bytes) : bytes),
    ).toBe(source);
    const head = await request(path, {
      method: "HEAD",
      headers: { "accept-encoding": encoding },
    });
    expect(Object.fromEntries(head.headers)).toEqual(
      Object.fromEntries(response.headers),
    );
    expect(await head.text()).toBe("");
  }
  await writeFile(`${options.webRoot}/assets/unversioned.js`, source);
  const fallback = await request("/assets/unversioned.js", {
    headers: { "accept-encoding": "gzip" },
  });
  expect(fallback.headers.get("cache-control")).toBe("no-store");
  expect(fallback.headers.get("content-encoding")).toBeNull();
  expect(await fallback.text()).toBe(source);
  for (const path of ["/", "/api/graph"]) {
    const response = await request(path, {
      headers: {
        authorization: `Bearer ${options.ownerToken}`,
        "accept-encoding": "gzip",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-encoding")).toBeNull();
  }
  expect((await request(`${path}.gz`)).status).toBe(404);
  expect(
    (await request(path, { headers: { host: "foreign.example" } })).status,
  ).toBe(403);
});

test("static byte ranges still use the original file over TCP", async () => {
  const { app, request, options } = await fixture();
  const path = "/assets/index-A1b2C3d4.js";
  const source = "0123456789abcdefghijklmnopqrstuvwxyz";
  await writeFile(`${options.webRoot}${path}`, source);
  await writeFile(`${options.webRoot}${path}.gz`, gzipSync(source));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  const response = await fetch(new URL(path, server.url), {
    headers: {
      host: new URL(options.origin).host,
      range: "bytes=7-15",
      "accept-encoding": "gzip",
    },
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("content-range")).toBe("bytes 7-15/36");
  expect(response.headers.get("content-length")).toBe("9");
  expect(await response.text()).toBe("789abcdef");
  const head = await request("/", { method: "HEAD" });
  expect(head.headers.get("content-type")).toContain("text/html");
  expect(head.headers.get("content-length")).toBe("15");
  expect(await head.text()).toBe("");
});

test("rejects foreign hosts, cross-origin requests, and all mutations", async () => {
  const { request } = await fixture();
  expect(
    (await request("/", { headers: { host: "attacker.example" } })).status,
  ).toBe(403);
  expect(
    (
      await request("/healthz", {
        headers: { origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  expect((await request("/healthz", { method: "POST" })).status).toBe(405);
  expect(
    (await request("/healthz", { headers: { host: "127.0.0.1:3210" } })).status,
  ).toBe(200);
  expect(
    (await request("/", { headers: { host: "127.0.0.1:3210" } })).status,
  ).toBe(403);
});

test("never serves database, repository or traversal paths", async () => {
  const { request } = await fixture();
  for (const path of [
    "/.env",
    "/graph.sqlite",
    "/package.json",
    "/assets/%2e%2e%2fsecret.txt",
  ]) {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
});

const nodeCommand = (id = "a") => ({
  type: "node.put",
  node: {
    id,
    title: id,
    description: "Synthetic",
    project: "test",
    status: "idea",
    sources: [],
  },
});

test("all data reads and writes reject missing, wrong and spoofed credentials", async () => {
  const { request, options } = await fixture();
  for (const path of [
    "/api/graph",
    "/api/export",
    "/api/history",
    "/api/events",
    "/api/search?q=test",
  ]) {
    expect((await request(path)).status).toBe(401);
    expect(
      (
        await request(path, {
          headers: {
            authorization: "Bearer invalid",
            "x-user-login": "owner",
            "x-actor": "owner",
            "x-forwarded-host": "yakjev.example.com",
          },
        })
      ).status,
    ).toBe(401);
  }
  const command = {
    requestId: "first",
    expectedRevision: 0,
    command: nodeCommand(),
  };
  const response = await request("/api/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.ownerToken}`,
      "x-actor": "forged",
      "x-user-login": "forged",
    },
    body: JSON.stringify(command),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    receipt: { revision: 1, actor: { id: "owner", channel: "browser" } },
    replayed: false,
  });
  const injected = await request("/api/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.ownerToken}`,
    },
    body: JSON.stringify({ ...command, actor: { id: "forged" } }),
  });
  expect(injected.status).toBe(400);
  expect(await injected.text()).not.toMatch(
    /\/home|\/app|SELECT|INSERT|at .*\.ts/,
  );
  const stale = await request("/api/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.ownerToken}`,
    },
    body: JSON.stringify({ ...command, requestId: "stale" }),
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: "Conflict",
    currentRevision: 1,
  });
});

test("secure browser session, exact Origin CSRF guard, cookie tampering and credential rotation", async () => {
  const { request, options } = await fixture();
  const login = (origin?: string) =>
    request("/api/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ token: options.ownerToken }),
    });
  expect((await login()).status).toBe(403);
  expect((await login("https://attacker.test")).status).toBe(403);
  const loggedIn = await login(options.origin);
  expect(loggedIn.status).toBe(200);
  const setCookie = loggedIn.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/^__Host-yakjev_session=/);
  for (const part of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"])
    expect(setCookie).toContain(part);
  expect(setCookie).not.toContain(options.ownerToken);
  const cookie = setCookie.split(";")[0]!;
  expect((await request("/api/graph", { headers: { cookie } })).status).toBe(
    200,
  );
  const body = JSON.stringify({
    requestId: "cookie-write",
    expectedRevision: 0,
    command: nodeCommand(),
  });
  expect(
    (
      await request("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: options.origin,
        },
        body,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/api/graph", {
        headers: {
          cookie: cookie.slice(0, -1) + (cookie.endsWith("x") ? "y" : "x"),
        },
      })
    ).status,
  ).toBe(401);
  const rotated = createApp({
    ...options,
    ownerToken: "different-owner-token-rotation-at-least-32",
  });
  cleanups.push(() => rotated.close());
  expect(
    (
      await rotated.fetch(
        new Request(`${options.origin}/api/graph`, { headers: { cookie } }),
      )
    ).status,
  ).toBe(401);
  const logout = await request("/api/session", {
    method: "DELETE",
    headers: { origin: options.origin, cookie },
  });
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("SSE replays durable receipts, follows live commits and resumes after restart without gaps", async () => {
  const { app, request, options } = await fixture();
  const auth = { authorization: `Bearer ${options.ownerToken}` };
  const send = (revision: number) =>
    request("/api/commands", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: `event-${revision}`,
        expectedRevision: revision,
        command: nodeCommand(`n${revision}`),
      }),
    });
  expect((await send(0)).status).toBe(200);
  expect((await send(1)).status).toBe(200);
  const response = await request("/api/events?after=1", { headers: auth });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("id: 2\n"))
    text += decoder.decode((await reader.read()).value);
  expect(text).not.toContain("id: 1\n");
  expect((await send(2)).status).toBe(200);
  while (!text.includes("id: 3\n"))
    text += decoder.decode((await reader.read()).value);
  expect(text.match(/event: change/g)).toHaveLength(2);
  expect(text).toContain('"revision":3');
  await reader.cancel();
  await app.close();
  const reopened = createApp(options);
  cleanups.push(() => reopened.close());
  const replay = await reopened.fetch(
    new Request(`${options.origin}/api/events?after=0`, {
      headers: { ...auth, "last-event-id": "2" },
    }),
  );
  const replayReader = replay.body!.getReader();
  let replayText = "";
  while (!replayText.includes("id: 3\n"))
    replayText += decoder.decode((await replayReader.read()).value);
  expect(replayText).not.toContain("id: 2\n");
  await replayReader.cancel();
  const ahead = await reopened.fetch(
    new Request(`${options.origin}/api/events?after=4`, { headers: auth }),
  );
  expect(ahead.status).toBe(409);
  expect(await ahead.json()).toMatchObject({
    error: "Conflict",
    currentRevision: 3,
  });
});

test("mounted MCP over TCP authenticates every request and shares HTTP graph and evaluation operations", async () => {
  const { app, options } = await fixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  const request = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", new URL(options.origin).host);
    return fetch(new URL(path, server.url), { ...init, headers });
  };
  let session: string | null = null;
  let sequence = 0;
  const rpc = (
    method: string,
    params: unknown,
    authorization: string | null = `Bearer ${options.ownerToken}`,
    extra: Record<string, string> = {},
  ) =>
    request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization ? { authorization } : {}),
        ...(session
          ? { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }
          : {}),
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  const initialize = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "synthetic-integration", version: "1" },
  };
  expect((await rpc("initialize", initialize, null)).status).toBe(401);
  expect(
    (
      await rpc("initialize", initialize, "Bearer forged", {
        "x-user-login": "owner",
        "x-actor": "owner",
      })
    ).status,
  ).toBe(401);
  const response = await rpc("initialize", initialize);
  expect(response.status).toBe(200);
  session = response.headers.get("mcp-session-id");
  expect(session).not.toBeNull();
  const listed = await (await rpc("tools/list", {})).json();
  expect(
    listed.result.tools.map((tool: { name: string }) => tool.name).sort(),
  ).toEqual([
    "graph_command",
    "graph_discover",
    "graph_evaluate",
    "graph_preview",
    "graph_read",
  ]);
  const command = {
    requestId: "mcp-create",
    expectedRevision: 0,
    command: nodeCommand("agent"),
  };
  const called = await (
    await rpc("tools/call", { name: "graph_command", arguments: command })
  ).json();
  expect(called.result.isError).toBe(false);
  expect(JSON.parse(called.result.content[0].text)).toMatchObject({
    receipt: { revision: 1, actor: { id: "owner", channel: "mcp" } },
  });
  const auth = { authorization: `Bearer ${options.ownerToken}` };
  const graph = await (await request("/api/graph", { headers: auth })).json();
  expect(graph.nodes[0].id).toBe("agent");
  expect(graph.revision).toBe(1);
  const replay = await request("/api/commands", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  expect(await replay.json()).toMatchObject({
    replayed: true,
    receipt: { revision: 1, actor: { channel: "mcp" } },
  });
  expect((await rpc("tools/list", {}, null)).status).toBe(401);
  expect(
    (await rpc("tools/list", {}, `Bearer ${options.ownerToken}wrong`)).status,
  ).toBe(401);
  expect(
    (
      await rpc("tools/list", {}, `Bearer ${options.ownerToken}`, {
        origin: "https://foreign.test",
      })
    ).status,
  ).toBe(403);
  const spoofed = await (
    await rpc("tools/call", {
      name: "graph_command",
      arguments: { ...command, actor: { id: "forged" } },
    })
  ).json();
  expect(spoofed.error.code).toBe(-32602);
  const httpCommand = {
    requestId: "browser-create",
    expectedRevision: 1,
    command: nodeCommand("prerequisite"),
  };
  expect(
    (
      await request("/api/commands", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(httpCommand),
      })
    ).status,
  ).toBe(200);
  const tool = async (name: string, args: unknown, isError = false) => {
    const response = await rpc("tools/call", { name, arguments: args });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.isError).toBe(isError);
    return JSON.parse(body.result.content[0].text);
  };
  expect(await tool("graph_command", httpCommand)).toMatchObject({
    replayed: true,
    receipt: { revision: 2, actor: { channel: "browser" } },
  });
  expect(
    await tool("graph_command", { ...httpCommand, requestId: "stale" }, true),
  ).toMatchObject({ error: "Conflict", currentRevision: 2 });
  await tool("graph_command", {
    requestId: "mcp-connect",
    expectedRevision: 2,
    command: {
      type: "edge.put",
      edge: {
        id: "edge",
        source: "agent",
        target: "prerequisite",
        relation: "requires",
        rationale: "Synthetic prerequisite",
      },
    },
  });
  for (const [args, path] of [
    [{ view: "graph" }, "/api/graph"],
    [{ view: "history", after: 1, limit: 1 }, "/api/history?after=1&limit=1"],
    [{ view: "search", query: "prerequisite" }, "/api/search?q=prerequisite"],
    [
      { view: "neighborhood", id: "agent", blocking: true },
      "/api/neighborhood?id=agent&blocking=true",
    ],
    [
      { view: "neighborhood", id: "agent", direction: "incoming" },
      "/api/neighborhood?id=agent&direction=incoming",
    ],
    [{ view: "export" }, "/api/export"],
  ] as const) {
    expect(await tool("graph_read", args)).toEqual(
      await (await request(path, { headers: auth })).json(),
    );
  }
  expect(
    await tool("graph_discover", { query: "agent", focusNodeId: "agent" }),
  ).toEqual(
    await (
      await request("/api/discovery?query=agent&focusNodeId=agent", {
        headers: auth,
      })
    ).json(),
  );
  const events = await request("/api/events?after=2", { headers: auth });
  const reader = events.body!.getReader();
  let text = "";
  while (!text.includes("id: 3\n"))
    text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('"channel":"mcp"');
  await reader.cancel();
  const evaluationRequest = {
    requestId: "mcp-evaluate",
    expectedRevision: 3,
    query: "agent",
  };
  const evaluated = await (
    await rpc("tools/call", {
      name: "graph_evaluate",
      arguments: evaluationRequest,
    })
  ).json();
  expect(evaluated.result.isError).toBe(false);
  const result = JSON.parse(evaluated.result.content[0].text);
  const blob = await (
    await request(
      `/api/evaluations/${encodeURIComponent(result.evaluationId)}`,
      { headers: auth },
    )
  ).json();
  expect(blob.result.status).toBe("unavailable");
  expect(blob.provenance.actor.channel).toBe("mcp");
  expect(
    await tool("graph_read", { view: "evaluation", id: result.evaluationId }),
  ).toEqual(blob);
  const evaluateHttp = (input: unknown) =>
    request("/api/evaluations", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  expect(await (await evaluateHttp(evaluationRequest)).json()).toEqual({
    ...result,
    replayed: true,
  });
  expect(await tool("graph_evaluate", evaluationRequest)).toEqual({
    ...result,
    replayed: true,
  });
  expect(
    (await evaluateHttp({ ...evaluationRequest, query: "changed" })).status,
  ).toBe(409);
  expect(
    await tool(
      "graph_evaluate",
      { ...evaluationRequest, query: "changed" },
      true,
    ),
  ).toMatchObject({ error: "Conflict" });
  expect(
    (await (await request("/api/history", { headers: auth })).json()).length,
  ).toBe(4);
  const login = await request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: options.origin },
    body: JSON.stringify({ token: options.ownerToken }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect((await rpc("tools/list", {}, null, { cookie })).status).toBe(401);
});

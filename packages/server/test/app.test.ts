import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";

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
    origin: "https://yakjev.example.ts.net",
    ownerToken: "synthetic-owner-test-token-with-40-characters",
  };
  const app = createApp(options);
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

test("never serves database, repository, traversal paths, or a pretend MCP endpoint", async () => {
  const { request } = await fixture();
  for (const path of [
    "/.env",
    "/graph.sqlite",
    "/package.json",
    "/assets/%2e%2e%2fsecret.txt",
    "/mcp",
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
            "tailscale-user-login": "owner",
            "x-actor": "owner",
            "x-forwarded-host": "yakjev.example.ts.net",
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
      "tailscale-user-login": "forged",
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

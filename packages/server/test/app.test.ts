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
    stage: "scaffold",
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

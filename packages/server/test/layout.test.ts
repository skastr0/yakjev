import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Layer } from "effect";
import { createApp } from "../src/app";
import { Discovery, makeDiscovery } from "../src/discovery";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dir = await mkdtemp(`${tmpdir()}/yakjev-layout-`);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const options = {
    origin: "https://yakjev.test",
    databasePath: `${dir}/graph.sqlite`,
    webRoot: `${dir}/web`,
    ownerToken: "synthetic-owner-token-layout-tests",
  };
  const open = () => {
    const app = createApp(
      options,
      Layer.effect(Discovery, makeDiscovery(null)),
    );
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await app.fetch(
        new Request(`${options.origin}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.ownerToken}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: await response.json() };
    };
    return { app, call };
  };
  return { open };
}

const capture = (id: string, revision: number) => ({
  requestId: `capture-${id}`,
  expectedRevision: revision,
  command: {
    type: "capture",
    autoConnect: false,
    capture: { id: `c-${id}`, text: id, sources: [], nodeIds: [id] },
    nodes: [
      {
        id,
        title: id,
        description: "",
        project: "",
        status: "idea",
        sources: [],
      },
    ],
    edges: [],
  },
});

test("positions persist across restarts without touching the revision", async () => {
  const { open } = await fixture();
  const first = open();
  await first.call("/api/commands", "POST", capture("a", 0));
  await first.call("/api/commands", "POST", capture("b", 1));
  const saved = await first.call("/api/layout", "PUT", {
    positions: [
      { id: "a", x: 10.5, y: -4 },
      { id: "b", x: 200, y: 80 },
    ],
  });
  expect(saved).toEqual({ status: 200, body: { saved: 2 } });
  // Moving again overwrites; no journal entry, no revision.
  await first.call("/api/layout", "PUT", {
    positions: [{ id: "a", x: 12, y: -5 }],
  });
  const graph = (await first.call("/api/graph")).body;
  expect(graph.revision).toBe(2);
  expect((await first.call("/api/history?after=0")).body).toHaveLength(2);
  await first.app.close();

  const second = open();
  cleanups.push(() => second.app.close());
  expect((await second.call("/api/layout")).body).toEqual({
    positions: [
      { id: "a", x: 12, y: -5 },
      { id: "b", x: 200, y: 80 },
    ],
  });
  // A removed node's position is no longer returned.
  await second.call("/api/commands", "POST", {
    requestId: "remove-b",
    expectedRevision: 2,
    command: { type: "node.remove", ids: ["b"] },
  });
  expect((await second.call("/api/layout")).body.positions).toEqual([
    { id: "a", x: 12, y: -5 },
  ]);
  expect((await second.call("/api/export")).body.layout.positions).toEqual([
    { id: "a", x: 12, y: -5 },
  ]);
  // Malformed saves are rejected.
  const bad = await second.call("/api/layout", "PUT", {
    positions: [{ id: "a", x: "far", y: 0 }],
  });
  expect(bad.status).toBe(400);
});

import { describe, expect, test } from "bun:test";
import { initialTaxonomy, type Command } from "@yakjev/protocol";
import { ApiFailure, createClient, normalizeServerUrl } from "../src/http";

const graph = {
  revision: 0,
  nodes: [],
  edges: [],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
};
const command: Command = { type: "node.remove", ids: ["a"], removeEdges: true };
const receipt = {
  requestId: "retry-1",
  revision: 1,
  type: command.type,
  actor: { id: "owner", channel: "browser" as const },
  at: "2026-09-22T00:00:00.000Z",
};

describe("client bearer boundary", () => {
  test("accepts a portable fetch response without runtime-specific extensions", async () => {
    const client = createClient({
      baseUrl: "https://yakjev.example",
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
        json: async () => graph,
      }),
    });
    expect(await client.snapshot()).toEqual(graph);
  });

  test("all requests use the configured origin and never follow redirects", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = createClient({
      baseUrl: " https://yakjev.example/ ",
      token: "synthetic-owner-token",
      fetch: async (url, init) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return url.includes("/api/events")
          ? new Response(": connected\n\n", {
              headers: { "Content-Type": "text/event-stream" },
            })
          : Response.json(graph);
      },
    });
    expect(await client.snapshot()).toEqual(graph);
    await client.events({ after: 3 });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://yakjev.example/api/graph",
      "https://yakjev.example/api/events?after=3",
    ]);
    for (const { init } of calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-owner-token",
      );
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
    }
  });

  test("rejects remote plaintext, embedded credentials, and non-origin addresses", () => {
    for (const baseUrl of [
      "http://yakjev.example",
      "http://127.0.0.1.example",
      "ftp://localhost",
      "https://owner:secret@yakjev.example",
      "https://yakjev.example/elsewhere",
      "https://yakjev.example?token=secret",
      "https://yakjev.example#token",
    ])
      expect(() => normalizeServerUrl(baseUrl)).toThrow();
    for (const baseUrl of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ])
      expect(normalizeServerUrl(baseUrl)).toBe(baseUrl);
    expect(() =>
      createClient({ baseUrl: "https://yakjev.example", token: "\n" }),
    ).toThrow();
    expect(() =>
      createClient({ baseUrl: "https://yakjev.example", token: "one\ntwo" }),
    ).toThrow();
  });

  test("cookie clients omit the bearer header", async () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(init?.credentials).toBe("same-origin");
        return Response.json(graph);
      },
    });
    await client.snapshot();
  });
});

test("a lost command response is replayed with the caller's original request identity", async () => {
  const bodies: unknown[] = [];
  const client = createClient({
    baseUrl: "https://yakjev.example",
    randomUUID: () => {
      throw new Error("must preserve caller identity");
    },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) throw new TypeError("connection lost");
      return Response.json({ receipt, replayed: true });
    },
  });
  await expect(client.sendCommand(command, 0, "retry-1")).rejects.toThrow(
    "connection lost",
  );
  expect(bodies).toHaveLength(1);
  expect(await client.sendCommand(command, 0, "retry-1")).toEqual({
    receipt,
    replayed: true,
  });
  expect(bodies).toEqual([
    { command, expectedRevision: 0, requestId: "retry-1" },
    { command, expectedRevision: 0, requestId: "retry-1" },
  ]);
});

test("rejects malformed protocol inputs before sending and malformed snapshots after receiving", async () => {
  let calls = 0;
  const client = createClient({
    baseUrl: "https://yakjev.example",
    fetch: async () => {
      calls++;
      return Response.json({ ...graph, revision: -1 });
    },
  });
  await expect(client.sendCommand(command, -1, "id")).rejects.toThrow();
  await expect(client.sendCommand(command, 0, "not an id")).rejects.toThrow();
  await expect(client.history(-1)).rejects.toThrow();
  await expect(client.events({ after: -1 })).rejects.toThrow();
  await expect(
    client.saveLayout([{ id: "a", x: NaN, y: 0 }]),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(client.snapshot()).rejects.toThrow();
  expect(calls).toBe(1);
});

test("server failures preserve actionable status and revision without automatic retries", async () => {
  let calls = 0;
  const client = createClient({
    baseUrl: "https://yakjev.example",
    fetch: async () => {
      calls++;
      return Response.json(
        { error: "Conflict", message: "Graph changed", currentRevision: 8 },
        { status: 409 },
      );
    },
  });
  try {
    await client.sendCommand(command, 0, "retry-1");
    throw new Error("request should fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({
      status: 409,
      code: "Conflict",
      currentRevision: 8,
      message: "Graph changed",
    });
  }
  expect(calls).toBe(1);
});

test("preview cancellation reaches fetch and unavailable evaluations remain honest", async () => {
  const controller = new AbortController();
  const preview = {
    basedOnRevision: 0,
    taxonomyVersion: 1,
    status: "unavailable" as const,
    model: null,
    promptVersion: "test",
    elapsedMs: 0,
    judgments: [],
  };
  const client = createClient({
    baseUrl: "https://yakjev.example",
    fetch: async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).toEqual({
        draft: { title: "Capture" },
        purpose: "typing",
      });
      return Response.json(preview);
    },
  });
  expect(
    await client.preview(
      { draft: { title: "Capture" }, purpose: "typing" },
      controller.signal,
    ),
  ).toEqual(preview);
});

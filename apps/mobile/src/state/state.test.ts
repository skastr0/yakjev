import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@yakjev/client";
import {
  initialTaxonomy,
  type Command,
  type Graph,
  type Preview,
  type Receipt,
} from "@yakjev/protocol";
import { GraphSession } from "./graph-session";
import { JevPreviewSession } from "./jev-preview-session";
import { SessionController, validateSession } from "./session-storage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean, attempts = 250) {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Expected state did not arrive");
}
const graph = (revision: number): Graph => ({
  revision,
  nodes: [],
  edges: [],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
});
const receipt = (revision: number, requestId = "request-1"): Receipt => ({
  revision,
  requestId,
  type: "jev.context.set",
  actor: { id: "synthetic", channel: "browser" },
  at: "2026-09-22T12:00:00Z",
});
const command: Command = { type: "jev.context.set", text: "Synthetic context" };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const sessions: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function graphHarness() {
  let revision = 1;
  let ids = 0;
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const handlers = new Map<
    string,
    (init: RequestInit) => Promise<Response> | Response
  >();
  const client = createClient({
    baseUrl: "https://synthetic.invalid",
    token: "synthetic-test-token",
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path: `${path}${new URL(url).search}`, init });
      const handler = handlers.get(path);
      if (handler) return handler(init);
      if (path === "/api/graph") return json(graph(revision));
      if (path === "/api/layout")
        return json(init.method === "PUT" ? { saved: 1 } : { positions: [] });
      if (path === "/api/commands") {
        const body = JSON.parse(String(init.body));
        return json({
          receipt: receipt(++revision, body.requestId),
          replayed: false,
        });
      }
      if (path === "/api/events")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              init.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      throw new Error(`Unexpected request ${path}`);
    },
  });
  const session = new GraphSession(client, () => `request-${++ids}`);
  sessions.push(session);
  return {
    session,
    calls,
    handlers,
    streams,
    setRevision: (next: number) => {
      revision = next;
    },
  };
}
async function start(harness: ReturnType<typeof graphHarness>) {
  harness.session.start();
  await until(() => harness.session.getSnapshot().connection === "live");
}

describe("secure session", () => {
  test("uses the shared origin contract and permits HTTP only for development loopback", () => {
    expect(validateSession(" https://yakjev.example/ ", " test ")).toEqual({
      baseUrl: "https://yakjev.example",
      token: "test",
    });
    expect(validateSession("http://localhost:8080", "test", true).baseUrl).toBe(
      "http://localhost:8080",
    );
    for (const endpoint of [
      "http://localhost:8080",
      "http://192.168.1.2",
      "https://user:password@yakjev.example",
      "https://yakjev.example/path",
      "https://yakjev.example/?token=abc",
    ]) {
      expect(() => validateSession(endpoint, "test")).toThrow();
    }
    expect(() => validateSession("http://192.168.1.2", "test", true)).toThrow();
    expect(() =>
      validateSession("https://yakjev.example", "test\r\nheader"),
    ).toThrow();
  });

  test("a delayed credential restore cannot unlock after disconnect", async () => {
    const read = deferred<string | null>();
    const session = new SessionController({
      get: () => read.promise,
      set: async () => {},
      remove: async () => {},
    });
    sessions.push(session);
    const restored = session.restore();
    await session.disconnect();
    read.resolve(
      JSON.stringify({ baseUrl: "https://old.example", token: "old" }),
    );
    await restored;
    expect(session.getSnapshot().session).toBeNull();
  });

  test("disconnect serializes after an in-flight credential write", async () => {
    const saved = deferred<void>();
    let stored: string | null = null;
    const session = new SessionController({
      get: async () => stored,
      set: async (value) => {
        await saved.promise;
        stored = value;
      },
      remove: async () => {
        stored = null;
      },
    });
    sessions.push(session);
    const connected = session.connect("https://yakjev.example", "synthetic");
    const locked = session.disconnect();
    saved.resolve();
    expect(await connected).toBe(false);
    await locked;
    expect(stored).toBeNull();
    expect(session.getSnapshot().session).toBeNull();
  });
});

describe("graph session", () => {
  test("ignores a snapshot from the previous foreground generation", async () => {
    const h = graphHarness();
    const old = deferred<Response>();
    h.handlers.set("/api/graph", () => old.promise);
    h.session.start();
    await until(() => h.calls.some((call) => call.path === "/api/graph"));
    const oldSignal = h.calls.find((call) => call.path === "/api/graph")!.init
      .signal;
    h.session.suspend();
    expect(oldSignal?.aborted).toBe(true);
    h.handlers.delete("/api/graph");
    h.setRevision(4);
    await start(h);
    old.resolve(json(graph(99)));
    await Bun.sleep(5);
    expect(h.session.getSnapshot().graph?.revision).toBe(4);
  });

  test("coalesces refresh bursts and never moves the snapshot backwards", async () => {
    const h = graphHarness();
    await start(h);
    const delayed = deferred<Response>();
    let reads = 0;
    h.handlers.set("/api/graph", () =>
      ++reads === 1 ? delayed.promise : json(graph(8)),
    );
    const work = h.session.refresh();
    for (let index = 0; index < 30; index++) void h.session.refresh();
    delayed.resolve(json(graph(7)));
    await work;
    expect(reads).toBe(2);
    expect(h.session.getSnapshot().graph?.revision).toBe(8);
    h.handlers.set("/api/graph", () => json(graph(2)));
    await h.session.refresh();
    expect(h.session.getSnapshot().graph?.revision).toBe(8);
  });

  test("reconnect resumes events after the latest snapshot revision", async () => {
    const h = graphHarness();
    await start(h);
    h.setRevision(9);
    h.streams[0]!.enqueue(
      new TextEncoder().encode(
        `event: change\ndata: ${JSON.stringify(receipt(9))}\n\n`,
      ),
    );
    await until(() => h.session.getSnapshot().graph?.revision === 9);
    h.session.reconnect();
    await until(
      () =>
        h.calls.filter((call) => call.path.startsWith("/api/events")).length ===
        2,
    );
    expect(
      h.calls
        .filter((call) => call.path.startsWith("/api/events"))
        .map((call) => call.path),
    ).toEqual(["/api/events?after=1", "/api/events?after=9"]);
  });

  test("a failed live snapshot refresh recovers without another server event", async () => {
    const h = graphHarness();
    await start(h);
    let reads = 0;
    h.handlers.set("/api/graph", () => {
      if (++reads === 1) throw new Error("Temporary snapshot failure");
      return json(graph(9));
    });
    h.streams[0]!.enqueue(
      new TextEncoder().encode(
        `event: change\ndata: ${JSON.stringify(receipt(9))}\n\n`,
      ),
    );
    await until(() => h.session.getSnapshot().connection === "reconnecting");
    await until(() => h.session.getSnapshot().graph?.revision === 9, 1600);
    expect(reads).toBe(2);
    await until(() => h.session.getSnapshot().connection === "live");
  });

  test("streams closing immediately keep their increasing reconnect backoff", async () => {
    const h = graphHarness();
    await start(h);
    h.streams[0]!.close();
    await until(() => h.streams.length === 2, 1600);
    h.streams[1]!.close();
    await Bun.sleep(1000);
    expect(h.streams).toHaveLength(2);
    await until(() => h.streams.length === 3, 1600);
  });

  test("explicitly retries an ambiguous write with the identical request and revision", async () => {
    const h = graphHarness();
    await start(h);
    const bodies: string[] = [];
    h.handlers.set("/api/commands", (init) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error("Response lost after commit");
      h.setRevision(2);
      return json({
        receipt: receipt(2, JSON.parse(String(init.body)).requestId),
        replayed: true,
      });
    });
    expect(await h.session.execute(command)).toBe(false);
    expect(h.session.getSnapshot().failedWrite).toBe(true);
    expect(await h.session.execute(command)).toBe(false);
    expect(bodies.length).toBe(1);
    expect(await h.session.retry()).toBe(true);
    expect(bodies[1]).toBe(bodies[0]);
    expect(h.session.getSnapshot().failedWrite).toBe(false);
    expect(h.session.getSnapshot().pending).toBe(0);
  });

  test("conflict refreshes without automatically rebasing or replaying the command", async () => {
    const h = graphHarness();
    await start(h);
    h.handlers.set("/api/commands", () => {
      h.setRevision(8);
      return json(
        { error: "Conflict", message: "changed", currentRevision: 8 },
        409,
      );
    });
    expect(await h.session.execute(command)).toBe(false);
    expect(
      h.calls.filter((call) => call.path === "/api/commands"),
    ).toHaveLength(1);
    expect(h.session.getSnapshot().graph?.revision).toBe(8);
    expect(h.session.getSnapshot().failedWrite).toBe(false);
    expect(await h.session.retry()).toBe(false);
  });

  test("serializes writes and cancels queued drafts after an unconfirmed write", async () => {
    const h = graphHarness();
    await start(h);
    const delayed = deferred<Response>();
    h.handlers.set("/api/commands", () => delayed.promise);
    const first = h.session.execute(command);
    const queued = h.session.execute({
      type: "jev.context.set",
      text: "Second draft",
    });
    expect(h.session.getSnapshot().pending).toBe(2);
    expect(
      h.calls.filter((call) => call.path === "/api/commands"),
    ).toHaveLength(1);
    delayed.reject(new Error("Lost connection"));
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    expect(h.session.getSnapshot().pending).toBe(0);
  });

  test("backgrounding aborts a write, resolves pending drafts and preserves its identity", async () => {
    const h = graphHarness();
    await start(h);
    const delayed = deferred<Response>();
    h.handlers.set("/api/commands", () => delayed.promise);
    const saved = h.session.execute(command);
    const request = h.calls.find((call) => call.path === "/api/commands")!;
    h.session.suspend();
    expect(await saved).toBe(false);
    expect(request.init.signal?.aborted).toBe(true);
    expect(h.session.getSnapshot().pending).toBe(0);
    expect(h.session.getSnapshot().failedWrite).toBe(true);
    delayed.resolve(json({ receipt: receipt(90), replayed: false }));
    await Bun.sleep(5);
    expect(h.session.getSnapshot().lastEdit).toBeNull();
    h.handlers.delete("/api/commands");
    await start(h);
    expect(await h.session.retry()).toBe(true);
    expect(
      h.calls.filter((call) => call.path === "/api/commands")[1]!.init.body,
    ).toBe(request.init.body);
  });

  test("backgrounding after a receipt cannot make a confirmed save ambiguous", async () => {
    const h = graphHarness();
    await start(h);
    const delayed = deferred<Response>();
    h.handlers.set("/api/graph", () => delayed.promise);
    const saved = h.session.execute(command);
    await until(() => h.session.getSnapshot().lastEdit !== null);
    h.session.suspend();
    expect(await saved).toBe(true);
    expect(h.session.getSnapshot().failedWrite).toBe(false);
    delayed.resolve(json(graph(2)));
  });

  test("authentication refusal clears graph, layouts, queued and pending writes", async () => {
    const h = graphHarness();
    await start(h);
    h.handlers.set("/api/commands", () =>
      json({ error: "Unauthorized", message: "Token refused" }, 401),
    );
    const first = h.session.execute(command);
    const second = h.session.execute(command);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(h.session.getSnapshot()).toMatchObject({
      graph: null,
      positions: [],
      pending: 0,
      failedWrite: false,
      connection: "locked",
      lastEdit: null,
    });
  });

  test("chunks layout independently and retries only unsaved positions", async () => {
    const h = graphHarness();
    await start(h);
    const batches: Array<Array<{ id: string; x: number; y: number }>> = [];
    h.handlers.set("/api/layout", (init) => {
      const points = JSON.parse(String(init.body)).positions;
      batches.push(points);
      if (batches.length === 2) throw new Error("Disconnected");
      return json({ saved: points.length });
    });
    expect(
      await h.session.savePositions(
        Array.from({ length: 2001 }, (_, index) => ({
          id: `node-${index}`,
          x: index,
          y: index,
        })),
      ),
    ).toBe(false);
    expect(batches.map((batch) => batch.length)).toEqual([2000, 1]);
    expect(h.session.getSnapshot().layoutPending).toBe(true);
    expect(h.session.getSnapshot().graph?.revision).toBe(1);
    expect(await h.session.retryLayout()).toBe(true);
    expect(batches.map((batch) => batch.length)).toEqual([2000, 1, 1]);
    expect(h.session.getSnapshot().layoutPending).toBe(false);
    expect(
      h.calls.filter((call) => call.path === "/api/commands"),
    ).toHaveLength(0);
  });

  test("an in-flight layout batch cannot discard a newer position", async () => {
    const h = graphHarness();
    await start(h);
    const delayed = deferred<Response>();
    const bodies: string[] = [];
    h.handlers.set("/api/layout", (init) => {
      bodies.push(String(init.body));
      return bodies.length === 1 ? delayed.promise : json({ saved: 1 });
    });
    const first = h.session.savePositions([{ id: "node", x: 1, y: 1 }]);
    const second = h.session.savePositions([{ id: "node", x: 2, y: 2 }]);
    delayed.resolve(json({ saved: 1 }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(JSON.parse(bodies[1]!).positions).toEqual([
      { id: "node", x: 2, y: 2 },
    ]);
    expect(h.session.getSnapshot().positions).toEqual([
      { id: "node", x: 2, y: 2 },
    ]);
  });
});

describe("Jev preview freshness", () => {
  const preview = (revision: number): Preview => ({
    basedOnRevision: revision,
    taxonomyVersion: 1,
    status: "succeeded",
    model: "synthetic",
    promptVersion: "test",
    elapsedMs: 1,
    judgments: [],
  });

  test("aborts changed input and ignores the old answer even if transport ignores abort", async () => {
    const first = deferred<Preview>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const session = new JevPreviewSession(
      {
        preview: async (_, nextSignal) => {
          calls++;
          if (calls === 1) {
            signal = nextSignal;
            return first.promise;
          }
          return preview(2);
        },
      },
      1,
    );
    sessions.push(session);
    session.request({ draft: { title: "Earlier" } }, 1);
    await until(() => calls === 1);
    session.request({ draft: { title: "Current" } }, 2);
    expect(signal?.aborted).toBe(true);
    expect(session.getSnapshot().preview).toBeNull();
    await until(() => session.getSnapshot().preview !== null);
    first.resolve(preview(1));
    await Bun.sleep(5);
    expect(session.getSnapshot().preview?.basedOnRevision).toBe(2);
  });

  test("never exposes a judgment for another graph revision", async () => {
    const session = new JevPreviewSession(
      { preview: async () => preview(8) },
      1,
    );
    sessions.push(session);
    session.request({ draft: { title: "Connect this" } }, 7);
    await until(() => !session.getSnapshot().loading);
    expect(session.getSnapshot().preview).toBeNull();
    expect(session.getSnapshot().error).toContain("graph changed");
  });

  test("debounces rapid typing and reuses only successful same-revision results", async () => {
    let calls = 0;
    const session = new JevPreviewSession(
      {
        preview: async () => {
          calls++;
          return preview(1);
        },
      },
      2,
    );
    sessions.push(session);
    session.request({ draft: { title: "ab" } }, 1);
    session.request({ draft: { title: "abc" } }, 1);
    session.request({ draft: { title: "abcd" } }, 1);
    await until(() => !session.getSnapshot().loading);
    expect(calls).toBe(1);
    session.request({ draft: { title: "abcd" } }, 1);
    expect(session.getSnapshot().loading).toBe(false);
    expect(calls).toBe(1);
    session.cancel();
    expect(session.getSnapshot().preview).toBeNull();
  });
});

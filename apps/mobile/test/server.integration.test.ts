import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiFailure,
  createClient,
  createEventParser,
  decodeReceipt,
  type ServerEvent,
} from "@yakjev/client";
import type { Command } from "@yakjev/protocol";
import {
  acceptanceToken,
  startServer,
  type ServerHandle,
} from "../../../tests/acceptance/harness";
import { GraphSession } from "../src/state/graph-session";
import { JevPreviewSession } from "../src/state/jev-preview-session";

// Exercise the actual mobile state + client against the existing server. The
// acceptance harness supplies disposable SQLite and strips provider credentials.
let server: ServerHandle;
const disposers: (() => void)[] = [];

beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await server?.stop();
});

function client() {
  return createClient({ baseUrl: server.origin, token: acceptanceToken });
}

function intention(id: string, title = id): Command {
  return {
    type: "node.put",
    node: {
      id,
      title,
      description: "Synthetic mobile integration fixture.",
      project: "mobile-test",
      status: "idea",
      sources: [],
    },
  };
}

function session(api = client()) {
  const value = new GraphSession(api, () => crypto.randomUUID());
  disposers.push(value.dispose);
  value.start();
  return value;
}

function waitForState<T>(
  source: {
    getSnapshot: () => T;
    subscribe: (listener: () => void) => () => void;
  },
  predicate: (state: T) => boolean,
  description: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out waiting for ${description}: ${JSON.stringify(source.getSnapshot())}`,
        ),
      );
    }, 5_000);
    const inspect = () => {
      const state = source.getSnapshot();
      if (!predicate(state)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = source.subscribe(inspect);
    inspect();
  });
}

describe("mobile client against the authoritative server", () => {
  test("bearer commands preserve replay, conflict, layout and SSE contracts", async () => {
    const api = client();
    const initial = await api.snapshot();
    expect(initial.revision).toBe(0);
    const command = intention("mobile-wire", "Intenção móvel");
    const first = await api.sendCommand(
      command,
      initial.revision,
      "mobile-wire-request",
    );
    const replay = await api.sendCommand(
      command,
      initial.revision,
      "mobile-wire-request",
    );
    expect(first.replayed).toBe(false);
    expect(first.receipt.actor.channel).toBe("browser");
    expect(replay).toEqual({ receipt: first.receipt, replayed: true });

    const conflict = await api
      .sendCommand(intention("mobile-stale"), 0, "mobile-stale-request")
      .catch((cause: unknown) => cause);
    expect(conflict).toBeInstanceOf(ApiFailure);
    expect(conflict).toMatchObject({
      status: 409,
      code: "Conflict",
      currentRevision: 1,
    });
    expect((await api.snapshot()).nodes.map((node) => node.id)).toEqual([
      "mobile-wire",
    ]);

    const positions = [{ id: "mobile-wire", x: -135.5, y: 240.25 }];
    expect(await api.saveLayout(positions)).toEqual({ saved: 1 });
    expect(await api.layout()).toEqual({ positions });
    expect((await api.snapshot()).revision).toBe(1);
    expect((await api.history()).map((entry) => entry.requestId)).toEqual([
      "mobile-wire-request",
    ]);
    expect((await api.exportGraph()).layout).toEqual({ positions });

    const abort = new AbortController();
    const response = await api.events({
      after: 0,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const received: ServerEvent[] = [];
    const parser = createEventParser((event) => received.push(event));
    const decoder = new TextDecoder();
    const reader = response.body!.getReader();
    try {
      while (!received.length) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error(
            "Server closed before delivering its journal receipt",
          );
        // Native stream boundaries are arbitrary. Decode the real wire bytes
        // one at a time so neither TextDecoder nor framing assumes whole lines.
        for (const byte of chunk.value)
          parser.feed(decoder.decode(new Uint8Array([byte]), { stream: true }));
      }
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ event: "change", id: "1" });
      expect(decodeReceipt(received[0]!.data)).toEqual(first.receipt);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }, 15_000);

  test("two mobile sessions observe each other's writes and resume from the server", async () => {
    const first = session();
    const second = session();
    await Promise.all(
      [first, second].map((value) =>
        waitForState(
          value,
          (state) => state.connection === "live",
          "live mobile session",
        ),
      ),
    );

    expect(
      await first.execute(intention("from-first", "First mobile intention")),
    ).toBe(true);
    await waitForState(
      second,
      (state) => state.graph?.revision === 1,
      "other device's write over SSE",
    );
    expect(second.getSnapshot().graph?.nodes[0]?.title).toBe(
      "First mobile intention",
    );
    expect(
      await second.execute({
        type: "jev.context.set",
        text: "Synthetic shared mobile context.",
      }),
    ).toBe(true);
    await waitForState(
      first,
      (state) =>
        state.graph?.jevContext?.text === "Synthetic shared mobile context.",
      "other device's context over SSE",
    );

    const positions = [{ id: "from-first", x: 45, y: -80 }];
    expect(await first.savePositions(positions)).toBe(true);
    const reopened = session();
    await waitForState(
      reopened,
      (state) => state.connection === "live",
      "reopened mobile session",
    );
    expect(reopened.getSnapshot().positions).toEqual(positions);
    expect(reopened.getSnapshot().graph?.revision).toBe(2);

    first.suspend();
    const suspendedRevision = first.getSnapshot().graph?.revision;
    expect(await second.execute(intention("while-backgrounded"))).toBe(true);
    expect(first.getSnapshot().graph?.revision).toBe(suspendedRevision);
    first.start();
    await waitForState(
      first,
      (state) => state.connection === "live" && state.graph?.revision === 3,
      "foreground catch-up",
    );
    expect(
      first
        .getSnapshot()
        .graph?.nodes.some((node) => node.id === "while-backgrounded"),
    ).toBe(true);
    expect((await client().history()).length).toBe(3);
  }, 20_000);

  test("a lost mutation response retries the committed request without duplication", async () => {
    const sent: string[] = [];
    let loseResponse = true;
    const api = createClient({
      baseUrl: server.origin,
      token: acceptanceToken,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (new URL(url).pathname === "/api/commands") {
          sent.push(String(init?.body));
          if (loseResponse && response.ok) {
            loseResponse = false;
            await response.text();
            throw new TypeError(
              "Synthetic connection loss after server commit",
            );
          }
        }
        return response;
      },
    });
    const mobile = session(api);
    await waitForState(
      mobile,
      (state) => state.connection === "live",
      "mobile session before interrupted save",
    );
    expect(await mobile.execute(intention("lost-response"))).toBe(false);
    expect(mobile.getSnapshot().failedWrite).toBe(true);
    expect((await client().history()).length).toBe(1);
    expect(await mobile.retry()).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(mobile.getSnapshot()).toMatchObject({
      failedWrite: false,
      pending: 0,
    });
    const saved = await client().snapshot();
    expect(saved.revision).toBe(1);
    expect(saved.nodes.map((node) => node.id)).toEqual(["lost-response"]);
    expect((await client().history()).length).toBe(1);
  }, 15_000);

  test("refused credentials lock mobile state and missing Jev credentials stay unavailable", async () => {
    const refused = session(
      createClient({
        baseUrl: server.origin,
        token: "synthetic-wrong-owner-token",
      }),
    );
    await waitForState(
      refused,
      (state) => state.connection === "locked" && state.error !== null,
      "refused owner token",
    );
    expect(refused.getSnapshot().graph).toBeNull();
    expect(await refused.execute(intention("unauthorized"))).toBe(false);
    expect((await client().snapshot()).revision).toBe(0);

    const api = client();
    await api.sendCommand(
      intention("jev-candidate"),
      0,
      "jev-candidate-request",
    );
    const preview = new JevPreviewSession(api, 0);
    disposers.push(preview.dispose);
    preview.request(
      {
        draft: { title: "Synthetic related intention" },
        includeNodeIds: ["jev-candidate"],
        only: true,
        purpose: "typing",
      },
      1,
    );
    const result = await waitForState(
      preview,
      (state) => !state.loading && state.preview !== null,
      "unconfigured Jev preview",
    );
    expect(result.preview).toMatchObject({
      status: "unavailable",
      basedOnRevision: 1,
      judgments: [],
    });
    expect(result.error).toBe("Jev is unavailable.");
    expect((await api.snapshot()).revision).toBe(1);
    expect((await api.history()).length).toBe(1);
  }, 15_000);
});

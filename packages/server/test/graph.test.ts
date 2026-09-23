import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  PAINT_BATCH_MAX,
  type Actor,
  type Command,
  type CommandRequest,
  type SuggestionInput,
} from "@yakjev/protocol";
import { Effect, ManagedRuntime } from "effect";
import { neighborhood } from "../src/domain";
import { Store, storeLayer } from "../src/store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const actor: Actor = { id: "owner", channel: "mcp" };
const node = (id: string, title = id) => ({
  id,
  title,
  description: "Concise context",
  project: "synthetic",
  status: "idea" as const,
  sources: [{ uri: `https://example.test/${id}`, label: "Canonical source" }],
});
const edge = (
  id: string,
  source: string,
  target: string,
  relation = "requires",
) => ({
  id,
  source,
  target,
  relation,
  rationale: `${source} allegedly requires ${target}`,
});
const capture: Command = {
  type: "capture",
  capture: {
    id: "capture",
    text: "A claimed chain, not verified facts",
    nodeIds: ["a", "b", "c"],
    sources: [{ uri: "https://example.test/session", label: "Session" }],
  },
  nodes: [node("a"), node("b"), node("c")],
  edges: [edge("ab", "a", "b"), edge("bc", "b", "c")],
};
const suggestion = (
  id: string,
  source: string,
  target: string,
  basedOnRevision: number,
): SuggestionInput => ({
  id,
  source,
  target,
  basedOnRevision,
  taxonomyVersion: 1,
  relation: "requires",
  rationale: "Synthetic uncertain judgment",
  confidence: 0.8,
  evidence: [],
  model: "fixture",
  promptVersion: "1",
});
async function fixture() {
  const dir = await mkdtemp(`${tmpdir()}/yakjev-graph-`);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = `${dir}/graph.sqlite`;
  const open = async () => {
    const runtime = ManagedRuntime.make(storeLayer(path));
    cleanups.push(() => runtime.dispose());
    const store = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Store;
      }),
    );
    const run = runtime.runPromise;
    const send = async (
      command: Command,
      requestId: string = crypto.randomUUID(),
      expectedRevision?: number,
    ) =>
      run(
        store.execute(actor, {
          requestId,
          expectedRevision:
            expectedRevision ?? (await run(store.read)).revision,
          command,
        }),
      );
    return { runtime, store, run, send };
  };
  return { ...(await open()), open, path };
}

test("legacy stored nodes omit color; capture and node.put canonicalize explicit colors", async () => {
  const { store, run, send, path, runtime, open } = await fixture();
  await send({
    ...capture,
    nodes: [
      node("a"),
      { ...node("b"), color: "#A1B2C3" },
      { ...node("c"), color: null },
    ],
  });
  let graph = await run(store.read);
  expect(graph.nodes[0]).not.toHaveProperty("color");
  expect(graph.nodes[1]?.color).toBe("#a1b2c3");
  expect(graph.nodes[2]?.color).toBeNull();
  const database = new Database(path);
  try {
    const stored = database.query("SELECT graph FROM graph_state").get() as {
      graph: string;
    };
    expect(JSON.parse(stored.graph).nodes[0]).not.toHaveProperty("color");
  } finally {
    database.close();
  }
  await runtime.dispose();
  const reopened = await open();
  expect((await reopened.run(reopened.store.read)).nodes).toEqual(graph.nodes);
  await reopened.send({
    type: "node.put",
    node: node("b", "Edit from an older client"),
  });
  await reopened.send({
    type: "node.put",
    node: node("c", "Keep status color"),
  });
  graph = await reopened.run(reopened.store.read);
  expect(graph.nodes[1]?.color).toBe("#a1b2c3");
  expect(graph.nodes[2]?.color).toBeNull();
  await reopened.send({
    type: "node.put",
    node: { ...node("b"), color: "#ABCDEF" },
  });
  await reopened.send({
    type: "node.put",
    node: { ...node("c"), color: "#123AbC" },
  });
  graph = await reopened.run(reopened.store.read);
  expect(graph.nodes[1]?.color).toBe("#abcdef");
  expect(graph.nodes[2]?.color).toBe("#123abc");
  await reopened.send({
    type: "node.put",
    node: { ...node("b"), color: null },
  });
  expect((await reopened.run(reopened.store.read)).nodes[1]?.color).toBeNull();
});

test("paint persists through export and restart with actor-scoped replay and revision conflicts", async () => {
  const { store, run, send, runtime, open } = await fixture();
  await send(capture);
  const before = await run(store.read);
  const request: CommandRequest = {
    requestId: "paint-lost-response",
    expectedRevision: 1,
    command: { type: "node.paint", colors: [{ id: "a", color: "#AB12EF" }] },
  };
  const first = await run(store.execute(actor, request));
  expect(first.receipt).toMatchObject({
    type: "node.paint",
    revision: 2,
    actor,
  });
  const painted = await run(store.read);
  expect(painted.nodes[0]).toEqual({ ...before.nodes[0]!, color: "#ab12ef" });
  expect(await run(store.execute(actor, request))).toEqual({
    receipt: first.receipt,
    replayed: true,
  });
  await expect(
    send(
      { type: "node.paint", colors: [{ id: "a", color: null }] },
      "stale-paint",
      1,
    ),
  ).rejects.toMatchObject({ code: "Conflict", currentRevision: 2 });
  await expect(
    run(
      store.execute(actor, {
        ...request,
        command: {
          type: "node.paint",
          colors: [{ id: "a", color: "#ffffff" }],
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "Conflict" });
  const exported = await run(store.exportGraph);
  expect(exported.graph).toEqual(painted);
  expect(exported.history[1]?.command).toEqual(request.command);
  expect(await run(store.events(1))).toEqual([first.receipt]);
  await runtime.dispose();
  const reopened = await open();
  expect(await reopened.run(reopened.store.exportGraph)).toEqual(exported);
  expect(await reopened.run(reopened.store.execute(actor, request))).toEqual({
    receipt: first.receipt,
    replayed: true,
  });
  await reopened.run(
    reopened.store.execute(
      { id: "second-client", channel: "browser" },
      {
        requestId: request.requestId,
        expectedRevision: 2,
        command: { type: "node.paint", colors: [{ id: "a", color: null }] },
      },
    ),
  );
  expect((await reopened.run(reopened.store.read)).nodes[0]?.color).toBeNull();
});

test("legacy paint imports skip explicit color, explicit null and deleted or unknown nodes", async () => {
  const { store, run, send } = await fixture();
  await send({
    ...capture,
    nodes: [
      node("a"),
      { ...node("b"), color: "#123456" },
      { ...node("c"), color: null },
      node("deleted"),
    ],
  });
  await send({ type: "node.remove", ids: ["deleted"] });
  const before = await run(store.read);
  const legacy: Command = {
    type: "node.paint",
    onlyIfUnset: true,
    colors: [
      { id: "a", color: "#AA5500" },
      { id: "b", color: "#aa5500" },
      { id: "c", color: "#aa5500" },
      { id: "deleted", color: "#aa5500" },
      { id: "unknown", color: "#aa5500" },
    ],
  };
  await send(legacy);
  let graph = await run(store.read);
  expect(graph.nodes.map(({ id, color }) => ({ id, color }))).toEqual([
    { id: "a", color: "#aa5500" },
    { id: "b", color: "#123456" },
    { id: "c", color: null },
  ]);
  expect(graph.nodes.map(({ updated }) => updated)).toEqual(
    before.nodes.map(({ updated }) => updated),
  );
  await send({ type: "node.paint", colors: [{ id: "a", color: null }] });
  await send(legacy);
  graph = await run(store.read);
  expect(graph.nodes[0]?.color).toBeNull();
  expect(graph.nodes[1]?.color).toBe("#123456");
  expect(graph.nodes[2]?.color).toBeNull();
});

test("paint validation rejects invalid colors, batch sizes, duplicate IDs and missing IDs atomically", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  const before = await run(store.exportGraph);
  for (const command of [
    { type: "node.paint", colors: [] },
    {
      type: "node.paint",
      colors: Array.from({ length: PAINT_BATCH_MAX + 1 }, (_, index) => ({
        id: `n${index}`,
        color: null,
      })),
    },
    ...["red", "#fff", "#12345678", "#GG0000", 42, undefined].map((color) => ({
      type: "node.paint",
      colors: [{ id: "a", color }],
    })),
    {
      type: "node.paint",
      colors: [
        { id: "a", color: null },
        { id: "a", color: "#123456" },
      ],
    },
    {
      type: "node.paint",
      onlyIfUnset: true,
      colors: [
        { id: "missing", color: null },
        { id: "missing", color: "#123456" },
      ],
    },
  ]) {
    await expect(
      run(
        store.execute(actor, {
          requestId: crypto.randomUUID(),
          expectedRevision: 1,
          command,
        }),
      ),
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(await run(store.exportGraph)).toEqual(before);
  }
  await expect(
    send({
      type: "node.paint",
      colors: [
        { id: "a", color: "#123456" },
        { id: "missing", color: null },
      ],
    }),
  ).rejects.toMatchObject({ code: "NotFound" });
  expect(await run(store.exportGraph)).toEqual(before);
  await send({
    type: "node.paint",
    onlyIfUnset: true,
    colors: Array.from({ length: PAINT_BATCH_MAX }, (_, index) => ({
      id: `n${index}`,
      color: null,
    })),
  });
  expect((await run(store.read)).revision).toBe(2);
});

test("paint and its undo preserve content provenance and pending Jev judgments", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "suggestion.record",
    suggestion: suggestion("paint-judgment", "a", "c", 1),
  });
  const before = await run(store.read);
  await send({
    type: "node.paint",
    colors: [
      { id: "a", color: "#abcdef" },
      { id: "b", color: null },
    ],
  });
  const painted = await run(store.read);
  expect(painted.nodes.map(({ updated }) => updated)).toEqual(
    before.nodes.map(({ updated }) => updated),
  );
  expect(painted.edges).toEqual(before.edges);
  expect(painted.suggestions).toEqual(before.suggestions);
  await send({ type: "undo", revision: 3 });
  expect(await run(store.read)).toEqual({
    ...before,
    revision: 4,
    nodes: before.nodes.map((node) =>
      node.id === "a" || node.id === "b" ? { ...node, color: null } : node,
    ),
  });
  await send({ type: "undo", revision: 4 });
  expect(await run(store.read)).toEqual({ ...painted, revision: 5 });
  await expect(send({ type: "undo", revision: 3 })).rejects.toMatchObject({
    code: "Conflict",
  });
  await send({ type: "node.put", node: node("a", "A changed intention") });
  expect((await run(store.read)).suggestions[0]?.status).toBe("superseded");
  await send({ type: "undo", revision: 6 });
  const restored = await run(store.read);
  expect(restored.nodes[0]?.color).toBe("#abcdef");
  expect(restored.nodes.every(({ updated }) => updated.revision === 7)).toBe(
    true,
  );
  expect(restored.edges.every(({ updated }) => updated.revision === 7)).toBe(
    true,
  );
  expect(restored.suggestions[0]?.status).toBe("superseded");
});

test("paint undo durably blocks another client's stale import, including after undo-of-undo", async () => {
  for (const [onlyIfUnset, repeatedUndo] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    const { store, run, send, runtime, open } = await fixture();
    await send(capture);
    const before = await run(store.read);
    await send({
      type: "node.paint",
      colors: [{ id: "a", color: "#aa0000" }],
      onlyIfUnset,
    });
    await send({ type: "undo", revision: 2 });
    expect((await run(store.read)).nodes[0]?.color).toBeNull();
    if (repeatedUndo) {
      await send({ type: "undo", revision: 3 });
      expect((await run(store.read)).nodes[0]?.color).toBe("#aa0000");
      await send({ type: "undo", revision: 4 });
      expect((await run(store.read)).nodes[0]?.color).toBeNull();
    }
    await runtime.dispose();
    const reopened = await open();
    await reopened.run(
      reopened.store.execute(
        { id: "unmigrated-client", channel: "browser" },
        {
          requestId: "stale-local-paint",
          expectedRevision: repeatedUndo ? 5 : 3,
          command: {
            type: "node.paint",
            onlyIfUnset: true,
            colors: [
              { id: "a", color: "#0000bb" },
              { id: "b", color: "#00cc00" },
            ],
          },
        },
      ),
    );
    const migrated = await reopened.run(reopened.store.read);
    expect(migrated.nodes[0]?.color).toBeNull();
    expect(migrated.nodes[1]?.color).toBe("#00cc00");
    expect(migrated.nodes[2]).not.toHaveProperty("color");
    expect(migrated.nodes.map(({ updated }) => updated)).toEqual(
      before.nodes.map(({ updated }) => updated),
    );
  }
});

test("undoing a node.put color change blocks stale imports while retaining semantic freshness", async () => {
  for (const color of ["#aa0000", null]) {
    const { store, run, send } = await fixture();
    await send(capture);
    await send({
      type: "suggestion.record",
      suggestion: suggestion("put-color-judgment", "a", "c", 1),
    });
    await send({
      type: "node.put",
      node: { ...node("a", "Changed intention and color"), color },
    });
    await send({ type: "undo", revision: 3 });
    const restored = await run(store.read);
    expect(restored.nodes[0]?.title).toBe("a");
    expect(restored.nodes.every(({ updated }) => updated.revision === 4)).toBe(
      true,
    );
    expect(restored.edges.every(({ updated }) => updated.revision === 4)).toBe(
      true,
    );
    expect(restored.suggestions[0]?.status).toBe("superseded");
    await run(
      store.execute(
        { id: "unmigrated-client", channel: "browser" },
        {
          requestId: "stale-after-put-undo",
          expectedRevision: 4,
          command: {
            type: "node.paint",
            onlyIfUnset: true,
            colors: [{ id: "a", color: "#0000bb" }],
          },
        },
      ),
    );
    expect((await run(store.read)).nodes[0]?.color).toBeNull();
  }
});

test("paint journal failures roll back color and revision together", async () => {
  const { store, run, send, path } = await fixture();
  await send(capture);
  const before = await run(store.exportGraph);
  const database = new Database(path);
  try {
    database.exec(
      "CREATE TRIGGER reject_paint BEFORE INSERT ON graph_history BEGIN SELECT RAISE(ABORT, 'injected color journal failure'); END",
    );
    await expect(
      send({ type: "node.paint", colors: [{ id: "a", color: "#123456" }] }),
    ).rejects.toMatchObject({ _tag: "StorageError" });
    expect(await run(store.exportGraph)).toEqual(before);
  } finally {
    database.close();
  }
});

test("asymmetric direction, cycles, non-blocking claims and diamonds remain distinct", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  let graph = await run(store.read);
  expect(
    (await run(neighborhood(graph, "c", "outgoing", true))).nodes.map(
      (item) => item.id,
    ),
  ).toEqual(["c"]);
  expect(
    (await run(neighborhood(graph, "c", "incoming", true))).nodes.map(
      (item) => item.id,
    ),
  ).toEqual(["a", "b", "c"]);
  await send({ type: "edge.put", edge: edge("ac", "a", "c") });
  graph = await run(store.read);
  expect(
    (await run(neighborhood(graph, "a", "outgoing", true))).cycleDetected,
  ).toBe(false);
  await send({ type: "edge.put", edge: edge("ca", "c", "a") });
  const cycle = await run(
    neighborhood(await run(store.read), "a", "outgoing", true),
  );
  expect(cycle.cycleDetected).toBe(true);
  expect(cycle.nodes).toHaveLength(3);
  expect(cycle.edges).toHaveLength(4);
  await send({
    type: "edge.reframe",
    id: "ab",
    relation: "benefits_from",
    rationale: "Optional preparation",
    state: "asserted",
  });
  graph = await run(store.read);
  expect(
    (await run(neighborhood(graph, "a", "outgoing", true))).blockingEdges,
  ).not.toContain("ab");
  expect(
    graph.edges.find((item) => item.id === "ab")?.assertion.rationale,
  ).toBe("a allegedly requires b");
});

test("capture rollback and injected SQLite journal failure leave graph and revision unchanged", async () => {
  const { store, run, send, path } = await fixture();
  await expect(
    send({ ...capture, edges: [edge("bad", "a", "missing")] }),
  ).rejects.toMatchObject({ _tag: "DomainError", code: "NotFound" });
  expect((await run(store.read)).revision).toBe(0);
  expect((await run(store.read)).nodes).toHaveLength(0);
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TRIGGER reject_journal BEFORE INSERT ON graph_history BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expect(send(capture)).rejects.toMatchObject({ _tag: "StorageError" });
    expect((await run(store.read)).revision).toBe(0);
    expect(await run(store.history(0, 100))).toEqual([]);
    db.exec("DROP TRIGGER reject_journal");
  } finally {
    db.close();
  }
  await send(capture);
  expect((await run(store.read)).nodes).toHaveLength(3);
});

test("concurrent revisions, actor-scoped durable replay and altered-payload conflicts", async () => {
  const { store, run, send, runtime, open } = await fixture();
  const input: CommandRequest = {
    requestId: "lost-response",
    expectedRevision: 0,
    command: capture,
  };
  const first = await run(store.execute(actor, input));
  const races = await Promise.allSettled([
    send({ type: "node.put", node: node("d") }, "race1", 1),
    send({ type: "node.put", node: node("e") }, "race2", 1),
  ]);
  expect(races.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(
    races.find((item) => item.status === "rejected")?.reason,
  ).toMatchObject({ code: "Conflict", currentRevision: 2 });
  expect(await run(store.execute(actor, input))).toEqual({
    receipt: first.receipt,
    replayed: true,
  });
  await expect(
    run(store.execute(actor, { ...input, expectedRevision: 2 })),
  ).rejects.toMatchObject({ code: "Conflict" });
  await run(
    store.execute(
      { id: "other-owner-fixture", channel: "browser" },
      {
        requestId: "lost-response",
        expectedRevision: 2,
        command: { type: "node.put", node: node("other") },
      },
    ),
  );
  const before = await run(store.exportGraph);
  await runtime.dispose();
  const reopened = await open();
  expect(await reopened.run(reopened.store.exportGraph)).toEqual(before);
  expect(await reopened.run(reopened.store.execute(actor, input))).toEqual({
    receipt: first.receipt,
    replayed: true,
  });
  expect((await reopened.run(reopened.store.read)).revision).toBe(3);
});

test("reframes preserve all history, undo is monotonic, stale undo cannot erase an intervening edit", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "edge.reframe",
    id: "ab",
    relation: "benefits_from",
    rationale: "First correction",
    state: "asserted",
  });
  await send({
    type: "edge.reframe",
    id: "ab",
    relation: "related_to",
    rationale: "Second correction",
    state: "disputed",
  });
  await expect(send({ type: "undo", revision: 2 })).rejects.toMatchObject({
    code: "Conflict",
  });
  await send({ type: "undo", revision: 3 });
  expect((await run(store.read)).edges[0]?.rationale).toBe("First correction");
  await send({ type: "undo", revision: 4 });
  expect((await run(store.read)).edges[0]?.rationale).toBe("Second correction");
  const history = await run(store.history(0, 100));
  expect(history.map((entry) => entry.revision)).toEqual([1, 2, 3, 4, 5]);
  expect(history[1]?.command).toMatchObject({ rationale: "First correction" });
  expect(history[2]?.command).toMatchObject({ rationale: "Second correction" });
  await expect(
    send({ type: "edge.put", edge: edge("new-id", "a", "b") }),
  ).rejects.toMatchObject({ code: "Conflict" });
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("reinstate", "b", "a", 5),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
});

test("suggestions are separate; relevant freshness, atomic acceptance, rejection suppression and batch recording", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "suggestion.record",
    suggestion: suggestion("s1", "a", "c", 1),
  });
  expect((await run(store.read)).edges).toHaveLength(2);
  await send({ type: "node.put", node: node("unrelated") });
  expect((await run(store.read)).suggestions[0]?.status).toBe("pending");
  await send({
    type: "suggestion.decide",
    id: "s1",
    decision: "accept",
    rationale: "Explicit acceptance",
  });
  let graph = await run(store.read);
  expect(graph.revision).toBe(4);
  expect(graph.edges.find((item) => item.id === "s1")).toMatchObject({
    suggestionId: "s1",
    updated: { revision: 4 },
  });
  expect(graph.suggestions[0]).toMatchObject({
    status: "accepted",
    decision: { revision: 4 },
  });
  await expect(
    send({
      type: "suggestion.decide",
      id: "s1",
      decision: "accept",
      rationale: "again",
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  await send({
    type: "suggestion.record",
    suggestion: suggestion("s2", "c", "b", 4),
  });
  await send({ type: "node.put", node: node("b", "Changed endpoint") });
  expect((await run(store.read)).suggestions[1]?.status).toBe("superseded");
  await expect(
    send({
      type: "suggestion.decide",
      id: "s2",
      decision: "accept",
      rationale: "stale",
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  await send({
    type: "evaluation.record",
    evaluation: {
      id: "eval",
      inputHash: "fixture-hash",
      basedOnRevision: 6,
      taxonomyVersion: 1,
      result: { status: "succeeded" },
    },
    suggestions: [
      {
        ...suggestion("s3", "unrelated", "a", 6),
        evaluationId: "eval",
        inputHash: "fixture-hash",
      },
      {
        ...suggestion("s4", "unrelated", "b", 6),
        evaluationId: "eval",
        inputHash: "fixture-hash",
      },
    ],
  });
  await send({
    type: "suggestion.decide",
    id: "s3",
    decision: "reject",
    rationale: "Not useful",
  });
  await send({
    type: "suggestion.decide",
    id: "s4",
    decision: "accept",
    rationale: "Useful",
  });
  graph = await run(store.read);
  expect(graph.evaluations).toHaveLength(1);
  expect(graph.suggestions.find((item) => item.id === "s4")?.status).toBe(
    "accepted",
  );
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("s5", "a", "unrelated", 9),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
});

test("explicit acceptance can reframe an existing assertion without deleting its rationale", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "suggestion.record",
    suggestion: {
      ...suggestion("optional", "a", "b", 1),
      relation: "benefits_from",
    },
  });
  await send({
    type: "suggestion.decide",
    id: "optional",
    decision: "accept",
    rationale: "I can proceed without this preparation",
  });
  const graph = await run(store.read);
  expect(graph.edges).toHaveLength(2);
  expect(graph.edges[0]).toMatchObject({
    id: "ab",
    relation: "benefits_from",
    assertion: { rationale: "a allegedly requires b" },
    correction: { rationale: "I can proceed without this preparation" },
    suggestionId: "optional",
  });
  expect(graph.suggestions[0]?.status).toBe("accepted");
  expect(
    (await run(neighborhood(graph, "a", "outgoing", true))).blockingEdges,
  ).toEqual([]);
});

test("node.remove refuses incident edges, cascades on request and stays undoable", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({ type: "edge.put", edge: edge("aa", "a", "a") });
  await send({ type: "node.put", node: node("d") });
  await send({
    type: "suggestion.record",
    suggestion: suggestion("s-ac", "a", "c", 3),
  });
  await send({
    type: "suggestion.record",
    suggestion: suggestion("s-bd", "b", "d", 4),
  });
  await expect(send({ type: "node.remove", ids: ["b"] })).rejects.toMatchObject(
    {
      code: "Conflict",
      message: expect.stringContaining("ab"),
    },
  );
  await expect(send({ type: "node.remove", ids: ["b"] })).rejects.toMatchObject(
    {
      code: "Conflict",
      message: expect.stringContaining("bc"),
    },
  );
  await expect(send({ type: "node.remove", ids: ["a"] })).rejects.toMatchObject(
    {
      code: "Conflict",
      message: expect.stringContaining("aa"),
    },
  );
  await expect(
    send({ type: "node.remove", ids: ["ghost"] }),
  ).rejects.toMatchObject({ code: "NotFound" });
  expect((await run(store.read)).revision).toBe(5);

  await send({
    type: "node.remove",
    ids: ["a"],
    removeEdges: true,
    rationale: "captured in error",
  });
  let graph = await run(store.read);
  expect(graph.nodes.map((item) => item.id)).toEqual(["b", "c", "d"]);
  expect(graph.edges.map((item) => item.id)).toEqual(["bc"]);
  // Captures keep the reference: it is historical provenance, not a live link.
  expect(graph.captures[0]?.nodeIds).toContain("a");
  expect(graph.suggestions.find((item) => item.id === "s-ac")?.status).toBe(
    "superseded",
  );
  expect(graph.suggestions.find((item) => item.id === "s-bd")?.status).toBe(
    "pending",
  );
  await expect(
    send({
      type: "suggestion.decide",
      id: "s-ac",
      decision: "accept",
      rationale: "stale",
    }),
  ).rejects.toMatchObject({ code: "Conflict" });

  // Cascading also removes edges to nodes that stay.
  await send({ type: "node.remove", ids: ["b", "c"], removeEdges: true });
  graph = await run(store.read);
  expect(graph.nodes.map((item) => item.id)).toEqual(["d"]);
  expect(graph.edges).toHaveLength(0);

  await send({ type: "undo", revision: 7 });
  graph = await run(store.read);
  expect(graph.nodes.map((item) => item.id).sort()).toEqual(["b", "c", "d"]);
  expect(graph.edges.map((item) => item.id)).toEqual(["bc"]);
  // Undo stamps fresh updated revisions, so surviving pending suggestions go
  // stale: restored entities are new edits, not a time machine.
  expect(graph.suggestions.find((item) => item.id === "s-bd")?.status).toBe(
    "superseded",
  );
});

test("edge.remove resolves by id or directed pair and controls re-inference", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await expect(
    send({ type: "edge.remove", id: "ab", source: "c" }),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(send({ type: "edge.remove" })).rejects.toMatchObject({
    code: "Invalid",
  });
  await expect(
    send({ type: "edge.remove", source: "a" }),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    send({ type: "edge.remove", source: "b", target: "a" }),
  ).rejects.toMatchObject({ code: "NotFound" });
  await expect(
    send({ type: "edge.remove", id: "ghost" }),
  ).rejects.toMatchObject({ code: "NotFound" });
  expect((await run(store.read)).revision).toBe(1);

  await send({ type: "edge.remove", source: "a", target: "b" });
  expect((await run(store.read)).edges.map((item) => item.id)).toEqual(["bc"]);
  expect((await run(store.read)).suggestions).toHaveLength(0);
  // A plain removal leaves the pair suggestible again.
  await send({
    type: "suggestion.record",
    suggestion: suggestion("re-ab", "a", "b", 2),
  });

  await send({
    type: "edge.remove",
    id: "bc",
    suppress: true,
    rationale: "claim was wrong, do not re-propose",
  });
  let graph = await run(store.read);
  expect(graph.edges).toHaveLength(0);
  expect(
    graph.suggestions.find((item) => item.id === "suppressed-r4"),
  ).toMatchObject({
    status: "rejected",
    source: "b",
    target: "c",
    relation: "requires",
    model: "actor-suppression",
    decision: { revision: 4 },
    basedOnRevision: 3,
    taxonomyVersion: 1,
  });
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("again-bc", "b", "c", 4),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("again-cb", "c", "b", 4),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  // Suppression blocks inference, never an explicit re-assertion.
  await send({ type: "edge.put", edge: edge("bc2", "b", "c") });
  expect((await run(store.read)).edges.map((item) => item.id)).toEqual(["bc2"]);
});

test("edge.remove keeps suppression for corrected edges and supersedes pending proposals", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "edge.reframe",
    id: "ab",
    relation: "benefits_from",
    rationale: "Optional preparation",
    state: "disputed",
  });
  await send({
    type: "suggestion.record",
    suggestion: suggestion("dup-bc", "b", "c", 2),
  });
  await send({ type: "edge.remove", id: "ab" });
  let graph = await run(store.read);
  // The dispute lived only on the edge; removal keeps the pair rejected.
  expect(
    graph.suggestions.find((item) => item.id === "suppressed-r4"),
  ).toMatchObject({
    status: "rejected",
    source: "a",
    target: "b",
    relation: "benefits_from",
  });
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("again-ab", "a", "b", 4),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  // The tombstone's relation stays pinned like any referenced type.
  await expect(
    send({
      type: "taxonomy.replace",
      relations: graph.taxonomy.relations.filter(
        (relation) => relation.id !== "benefits_from",
      ),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });

  await send({ type: "edge.remove", id: "bc", suppress: false });
  graph = await run(store.read);
  expect(graph.suggestions.find((item) => item.id === "dup-bc")?.status).toBe(
    "superseded",
  );
  expect(
    graph.suggestions.filter((item) => item.id.startsWith("suppressed-")),
  ).toHaveLength(1);
  await expect(
    send({
      type: "suggestion.decide",
      id: "dup-bc",
      decision: "accept",
      rationale: "already superseded",
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  await send({
    type: "suggestion.record",
    suggestion: suggestion("again-cb", "c", "b", 5),
  });
  await send({
    type: "suggestion.decide",
    id: "again-cb",
    decision: "accept",
    rationale: "reverse direction is a different claim",
  });
  graph = await run(store.read);
  expect(graph.edges.map((item) => item.id)).toEqual(["again-cb"]);
  // Removing an accepted edge leaves the accepted record as provenance.
  await send({ type: "edge.remove", source: "c", target: "b" });
  graph = await run(store.read);
  expect(graph.edges).toHaveLength(0);
  expect(graph.suggestions.find((item) => item.id === "again-cb")?.status).toBe(
    "accepted",
  );

  // Suppression is idempotent when the pair is already rejected.
  await send({ type: "edge.put", edge: edge("ab2", "a", "b") });
  const count = (await run(store.read)).suggestions.length;
  await send({ type: "edge.remove", id: "ab2", suppress: true });
  expect((await run(store.read)).suggestions).toHaveLength(count);
});

test("node.remove cascade keeps suppression for disputed edges and protects re-registered pairs", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "edge.reframe",
    id: "ab",
    relation: "benefits_from",
    rationale: "Optional preparation",
    state: "disputed",
  });
  await send({
    type: "edge.reframe",
    id: "bc",
    relation: "requires",
    rationale: "disputed but same type",
    state: "disputed",
  });
  // One cascade drops two disputed edges; both get tombstones and their ids
  // cannot collide inside one revision.
  await send({
    type: "node.remove",
    ids: ["b"],
    removeEdges: true,
    rationale: "captured in error",
  });
  let graph = await run(store.read);
  expect(graph.edges).toHaveLength(0);
  expect(graph.nodes.map((item) => item.id)).toEqual(["a", "c"]);
  const tombstones = graph.suggestions.filter((item) =>
    item.id.startsWith("suppressed-"),
  );
  expect(tombstones.map((item) => item.id).sort()).toEqual([
    "suppressed-r4-ab",
    "suppressed-r4-bc",
  ]);
  expect(
    tombstones.find((item) => item.id === "suppressed-r4-ab"),
  ).toMatchObject({
    status: "rejected",
    source: "a",
    target: "b",
    relation: "benefits_from",
    model: "actor-suppression",
    promptVersion: "node.remove",
    rationale: "captured in error",
  });
  // Re-registering a node id does not reopen the pair for machine inference.
  await send({ type: "node.put", node: node("b") });
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("again-ab", "a", "b", 5),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("again-cb", "c", "b", 5),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  // An explicit assertion still wins over suppression.
  await send({ type: "edge.put", edge: edge("ab2", "a", "b") });
  expect((await run(store.read)).edges.map((item) => item.id)).toEqual(["ab2"]);
});

test("node.remove cascade bounds tombstone ids inside the Id limit", async () => {
  const { store, run, send } = await fixture();
  const longId = (stem: string) => stem + "-".repeat(120 - stem.length);
  const ab = longId("ab");
  const bc = longId("bc");
  await send({
    ...capture,
    edges: [edge(ab, "a", "b"), edge(bc, "b", "c")],
  });
  await send({
    type: "edge.reframe",
    id: ab,
    relation: "requires",
    rationale: "disputed",
    state: "disputed",
  });
  await send({
    type: "edge.reframe",
    id: bc,
    relation: "requires",
    rationale: "disputed",
    state: "disputed",
  });
  await send({ type: "node.remove", ids: ["b"], removeEdges: true });
  // Before the bound, this read threw SchemaError and wedged the store.
  const graph = await run(store.read);
  const tombstones = graph.suggestions.filter((item) =>
    item.id.startsWith("suppressed-"),
  );
  expect(tombstones).toHaveLength(2);
  for (const item of tombstones) {
    expect(item.id.length).toBeLessThanOrEqual(128);
    expect(item.status).toBe("rejected");
  }
  expect(new Set(tombstones.map((item) => item.id)).size).toBe(2);
  await send({ type: "node.put", node: node("b") });
  await expect(
    send({
      type: "suggestion.record",
      suggestion: suggestion("again-ab", "a", "b", 5),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
});

test("capture.remove drops only the record and layout.set clears positions", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "layout.set",
    positions: [{ id: "a", x: 5, y: 5, pinned: true }],
  });
  await send({
    type: "capture.remove",
    id: "capture",
    rationale: "wrong session",
  });
  let graph = await run(store.read);
  expect(graph.captures).toHaveLength(0);
  expect(graph.nodes).toHaveLength(3);
  await expect(
    send({ type: "capture.remove", id: "capture" }),
  ).rejects.toMatchObject({ code: "NotFound" });
  // The same capture id is free again; its nodes are already established.
  await send({ ...capture, nodes: [], edges: [] });
  expect((await run(store.read)).captures).toHaveLength(1);

  await send({
    type: "layout.set",
    positions: [{ id: "a", clear: true }],
  });
  graph = await run(store.read);
  expect(graph.nodes.find((item) => item.id === "a")?.position).toBeNull();
});

test("layout patches and archived source references survive edits, taxonomy cannot drop live types", async () => {
  const { store, run, send } = await fixture();
  await send(capture);
  await send({
    type: "layout.set",
    positions: [{ id: "a", x: -21, y: 7, pinned: true }],
  });
  await send({
    type: "layout.set",
    positions: [{ id: "b", x: 18, y: -100, pinned: false }],
  });
  await send({
    type: "node.put",
    node: { ...node("a", "Archived idea"), status: "archived" },
  });
  const graph = await run(store.read);
  expect(graph.nodes[0]?.position).toEqual({ x: -21, y: 7, pinned: true });
  expect(graph.nodes[1]?.position).toEqual({ x: 18, y: -100, pinned: false });
  expect(graph.captures[0]?.nodeIds).toContain("a");
  expect(graph.nodes[0]?.sources[0]?.uri).toBe("https://example.test/a");
  await expect(
    send({
      type: "layout.set",
      positions: [{ id: "missing", x: 1, y: 2, pinned: false }],
    }),
  ).rejects.toMatchObject({ code: "NotFound" });
  await expect(
    send({
      type: "taxonomy.replace",
      relations: graph.taxonomy.relations.filter(
        (relation) => relation.id !== "requires",
      ),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  await send({
    type: "taxonomy.replace",
    relations: graph.taxonomy.relations.map((relation) => ({
      ...relation,
      definition: `${relation.definition} User criteria.`,
    })),
  });
  expect((await run(store.read)).taxonomy.version).toBe(2);
  expect((await run(store.read)).edges).toHaveLength(2);
});

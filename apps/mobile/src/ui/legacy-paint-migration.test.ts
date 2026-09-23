import { describe, expect, test } from "bun:test";
import {
  initialTaxonomy,
  type Command,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import {
  LegacyPaintMigration,
  createPreferencesStorage,
  parsePreferences,
  updateDraggingPreference,
  type DisplayPreferences,
  type PaintMigrationExecute,
} from "./legacy-paint-migration";

const provenance = {
  actor: { id: "synthetic", channel: "browser" as const },
  at: "2026-09-23T00:00:00Z",
  revision: 1,
};
const node = (id: string, color?: string | null): Node => ({
  id,
  title: id,
  description: "",
  project: "",
  status: "idea",
  sources: [],
  position: null,
  created: provenance,
  updated: provenance,
  ...(color !== undefined ? { color } : {}),
});
const graph = (nodes: readonly Node[], revision = 1): Graph => ({
  revision,
  nodes,
  edges: [],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 250; index++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Expected asynchronous state did not arrive");
}
function harness(paint: Record<string, string>, connectWhileDragging = false) {
  let stored: DisplayPreferences = { paint, connectWhileDragging };
  let failedWrite = false;
  const notifications: unknown[] = [];
  const storage = createPreferencesStorage({
    key: `synthetic-${crypto.randomUUID()}`,
    read: () => JSON.stringify(stored),
    write: async (value) => {
      if (failedWrite) throw new Error("Synthetic disk failure");
      stored = JSON.parse(value);
    },
  });
  const migration = new LegacyPaintMigration(storage, (state, preferences) =>
    notifications.push({ state, preferences }),
  );
  return {
    migration,
    storage,
    notifications,
    read: () => stored,
    replace: (value: DisplayPreferences) => {
      stored = value;
    },
    failWrites: (value: boolean) => {
      failedWrite = value;
    },
  };
}

describe("mobile legacy color migration", () => {
  test("imports live unset colors in bounded batches and retires only acknowledged keys", async () => {
    const nodes = Array.from({ length: 235 }, (_, index) => node(`n${index}`));
    const h = harness(
      Object.fromEntries(nodes.map((value) => [value.id, "#Ab12Cd"])),
    );
    const sent: Command[] = [];
    await h.migration.migrate(graph(nodes), async (command, acknowledge) => {
      expect(Object.keys(h.read().paint).length).toBe(235 - sent.length * 100);
      sent.push(command);
      acknowledge();
      return true;
    });
    expect(
      sent.map((command) =>
        command.type === "node.paint" ? command.colors.length : 0,
      ),
    ).toEqual([100, 100, 35]);
    expect(
      sent.every(
        (command) =>
          command.type === "node.paint" &&
          command.onlyIfUnset &&
          command.colors.every((entry) => entry.color === "#ab12cd"),
      ),
    ).toBe(true);
    expect(h.read()).toEqual({ paint: {}, connectWhileDragging: false });
    expect(h.migration.getState()).toEqual({ pending: false, error: null });
  });

  test("canonical color and explicit null resolve local entries without sending", async () => {
    const h = harness({
      colored: "#112233",
      cleared: "#445566",
      absent: "#778899",
    });
    let calls = 0;
    await h.migration.migrate(
      graph([node("colored", "#abcdef"), node("cleared", null)]),
      async () => {
        calls++;
        return true;
      },
    );
    expect(calls).toBe(0);
    expect(h.read().paint).toEqual({ absent: "#778899" });
  });

  test("an absent node retains its legacy entry until a later graph can import it", async () => {
    const h = harness({ later: "#112233" });
    let calls = 0;
    const execute: PaintMigrationExecute = async () => {
      calls++;
      return true;
    };
    await h.migration.migrate(graph([]), execute);
    await h.migration.migrate(graph([], 2), execute);
    expect(calls).toBe(0);
    expect(h.read().paint).toEqual({ later: "#112233" });
    expect(h.migration.getState()).toEqual({ pending: true, error: null });
    await h.migration.migrate(graph([node("later")], 3), execute);
    expect(calls).toBe(1);
    expect(h.read().paint).toEqual({});
  });

  test("a rejected save remains visible and never automatically retries", async () => {
    const h = harness({ n: "#112233" });
    let calls = 0;
    const reject: PaintMigrationExecute = async () => {
      calls++;
      return false;
    };
    await h.migration.migrate(graph([node("n")]), reject);
    const error = h.migration.getState().error;
    expect(error).not.toBeNull();
    await h.migration.migrate(graph([node("n")], 2), reject);
    await h.migration.migrate(graph([node("n"), node("unrelated")], 3), reject);
    expect(calls).toBe(1);
    expect(h.migration.getState()).toEqual({ pending: true, error });
    expect(h.read().paint).toEqual({ n: "#112233" });
    await h.migration.migrate(
      graph([node("n")], 3),
      async () => {
        calls++;
        return true;
      },
      true,
    );
    expect(calls).toBe(2);
    expect(h.read().paint).toEqual({});
  });

  test("an unknown response is retired by the original explicit-retry acknowledgement", async () => {
    const h = harness({ n: "#112233" });
    let acknowledge!: () => void;
    let calls = 0;
    await h.migration.migrate(graph([node("n")]), async (_, saved) => {
      acknowledge = saved;
      calls++;
      return false;
    });
    expect(h.read().paint).toEqual({ n: "#112233" });
    acknowledge();
    await h.storage.read();
    expect(h.read().paint).toEqual({});
    // An Undo restoring absent color cannot resurrect the retired local value.
    await h.migration.migrate(graph([node("n")], 3), async () => {
      calls++;
      return true;
    });
    expect(calls).toBe(1);
    expect(h.migration.getState()).toEqual({ pending: false, error: null });
  });

  test("failed retirement never reimports on Undo and can be retried without another command", async () => {
    const h = harness({ n: "#112233" });
    let calls = 0;
    await h.migration.migrate(graph([node("n")]), async () => {
      calls++;
      h.failWrites(true);
      return true;
    });
    expect(h.migration.getState().error).toContain("cleanup needs a retry");
    await h.migration.migrate(graph([node("n")], 3), async () => {
      calls++;
      return true;
    });
    expect(calls).toBe(1);
    expect(h.read().paint).toEqual({ n: "#112233" });
    h.failWrites(false);
    await h.migration.migrate(
      graph([node("n")], 3),
      async () => {
        calls++;
        return true;
      },
      true,
    );
    expect(calls).toBe(1);
    expect(h.read().paint).toEqual({});
  });

  test("session replacement stops further batches and late acknowledgement cleans only its captured file", async () => {
    const nodes = Array.from({ length: 101 }, (_, index) => node(`n${index}`));
    const old = harness(
      Object.fromEntries(nodes.map((value) => [value.id, "#112233"])),
    );
    const replacement = harness({ other: "#445566" }, true);
    const save = deferred<boolean>();
    let calls = 0;
    const running = old.migration.migrate(graph(nodes), async () => {
      calls++;
      return save.promise;
    });
    await until(() => calls === 1);
    old.migration.dispose();
    const notifications = old.notifications.length;
    save.resolve(true);
    await running;
    expect(calls).toBe(1);
    expect(old.notifications).toHaveLength(notifications);
    expect(Object.keys(old.read().paint)).toEqual(["n100"]);
    expect(replacement.read()).toEqual({
      paint: { other: "#445566" },
      connectWhileDragging: true,
    });
    await old.migration.migrate(
      graph(nodes),
      async () => {
        calls++;
        return true;
      },
      true,
    );
    expect(calls).toBe(1);
  });

  test("retirement preserves a replacement local value and the latest interaction preference", async () => {
    const h = harness({ n: "#112233" });
    const save = deferred<boolean>();
    let sent = false;
    const running = h.migration.migrate(graph([node("n")]), async () => {
      sent = true;
      return save.promise;
    });
    await until(() => sent);
    h.migration.dispose();
    h.replace({
      paint: { n: "#abcdef", another: "#445566" },
      connectWhileDragging: true,
    });
    save.resolve(true);
    await running;
    expect(h.read()).toEqual({
      paint: { n: "#abcdef", another: "#445566" },
      connectWhileDragging: true,
    });
  });

  test("concurrent effect passes join the existing migration instead of sending twice", async () => {
    const h = harness({ n: "#112233" });
    const save = deferred<boolean>();
    let calls = 0;
    const execute: PaintMigrationExecute = async () => {
      calls++;
      return save.promise;
    };
    const first = h.migration.migrate(graph([node("n")]), execute);
    const second = h.migration.migrate(graph([node("n")]), execute);
    expect(first).toBe(second);
    await until(() => calls === 1);
    expect(calls).toBe(1);
    save.resolve(true);
    await first;
    expect(h.read().paint).toEqual({});
  });

  test("resolved remote choices retire entries even while an earlier save is blocked", async () => {
    const h = harness({ n: "#112233" });
    let calls = 0;
    const execute: PaintMigrationExecute = async () => {
      calls++;
      return false;
    };
    await h.migration.migrate(graph([node("n")]), execute);
    await h.migration.migrate(graph([node("n", null)], 2), execute);
    expect(calls).toBe(1);
    expect(h.read().paint).toEqual({});
    expect(h.migration.getState()).toEqual({ pending: false, error: null });
  });

  test("failed atomic cleanup preserves the complete remaining palette and orphan on restart", async () => {
    let stored = JSON.stringify({
      paint: { acknowledged: "#112233", pending: "#445566", orphan: "#778899" },
      connectWhileDragging: false,
    });
    const original = stored;
    const write = deferred<void>();
    let writes = 0;
    let fail = true;
    const file = {
      key: "synthetic-atomic-failure",
      read: () => stored,
      write: async (value: string) => {
        writes++;
        if (fail) await write.promise;
        stored = value;
      },
    };
    const storage = createPreferencesStorage(file);
    const migration = new LegacyPaintMigration(storage);
    const running = migration.migrate(
      graph([node("acknowledged")]),
      async () => true,
    );
    await until(() => writes === 1);
    expect(stored).toBe(original);
    write.reject(
      new Error("Synthetic atomic replacement failed before commit"),
    );
    await running;
    expect(stored).toBe(original);
    expect(migration.getState().error).toContain("cleanup needs a retry");
    migration.dispose();
    fail = false;
    const restarted = new LegacyPaintMigration(createPreferencesStorage(file));
    const sent: Command[] = [];
    await restarted.migrate(
      graph([node("acknowledged", null), node("pending")], 3),
      async (command) => {
        sent.push(command);
        return true;
      },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "node.paint",
      colors: [{ id: "pending", color: "#445566" }],
    });
    expect(JSON.parse(stored)).toEqual({
      paint: { orphan: "#778899" },
      connectWhileDragging: false,
    });
  });

  test("late old-session cleanup and a replacement-session toggle serialize by file URI", async () => {
    let stored = JSON.stringify({
      paint: { n: "#112233", orphan: "#445566" },
      connectWhileDragging: false,
    });
    const gate = deferred<void>();
    let writes = 0;
    const file = {
      key: "synthetic-replacement-file",
      read: () => stored,
      write: async (value: string) => {
        if (++writes === 1) await gate.promise;
        stored = value;
      },
    };
    const oldStorage = createPreferencesStorage(file);
    const newStorage = createPreferencesStorage(file);
    const migration = new LegacyPaintMigration(oldStorage);
    const running = migration.migrate(graph([node("n")]), async () => true);
    await until(() => writes === 1);
    migration.dispose();
    const toggled = updateDraggingPreference(newStorage, true);
    await Bun.sleep(1);
    expect(writes).toBe(1);
    expect(JSON.parse(stored).paint).toEqual({
      n: "#112233",
      orphan: "#445566",
    });
    gate.resolve();
    await Promise.all([running, toggled]);
    expect(JSON.parse(stored)).toEqual({
      paint: { orphan: "#445566" },
      connectWhileDragging: true,
    });
  });

  test("cleanup queued after a toggle retains that toggle and acknowledged batching waits for disk", async () => {
    let stored = JSON.stringify({
      paint: { n: "#112233", orphan: "#445566" },
      connectWhileDragging: false,
    });
    const gate = deferred<void>();
    let writes = 0;
    let sends = 0;
    const file = {
      key: "synthetic-toggle-first",
      read: () => stored,
      write: async (value: string) => {
        if (++writes === 1) await gate.promise;
        stored = value;
      },
    };
    const toggled = updateDraggingPreference(
      createPreferencesStorage(file),
      true,
    );
    await until(() => writes === 1);
    const migration = new LegacyPaintMigration(createPreferencesStorage(file));
    const running = migration.migrate(graph([node("n")]), async () => {
      sends++;
      return true;
    });
    await Bun.sleep(1);
    expect(sends).toBe(0);
    gate.resolve();
    await Promise.all([toggled, running]);
    expect(sends).toBe(1);
    expect(JSON.parse(stored)).toEqual({
      paint: { orphan: "#445566" },
      connectWhileDragging: true,
    });
  });

  test("an unknown-response acknowledgement suppresses reimport while atomic cleanup is pending", async () => {
    let stored = JSON.stringify({
      paint: { n: "#112233" },
      connectWhileDragging: true,
    });
    const gate = deferred<void>();
    let writes = 0;
    const storage = createPreferencesStorage({
      key: "synthetic-unknown-atomic",
      read: () => stored,
      write: async (value) => {
        writes++;
        await gate.promise;
        stored = value;
      },
    });
    const migration = new LegacyPaintMigration(storage);
    let acknowledge!: () => void;
    let sends = 0;
    await migration.migrate(graph([node("n")]), async (_, saved) => {
      sends++;
      acknowledge = saved;
      return false;
    });
    acknowledge();
    await until(() => writes === 1);
    const undoSnapshot = migration.migrate(graph([node("n")], 3), async () => {
      sends++;
      return true;
    });
    await Bun.sleep(1);
    expect(sends).toBe(1);
    gate.resolve();
    await undoSnapshot;
    expect(sends).toBe(1);
    expect(JSON.parse(stored).paint).toEqual({});
  });

  test("acknowledgement retires the exact palette used to build the submitted command", async () => {
    let stored = JSON.stringify({
      paint: { n: "#112233" },
      connectWhileDragging: false,
    });
    const storage = createPreferencesStorage({
      key: "synthetic-between-reads",
      read: () => stored,
      write: async (value) => {
        stored = value;
      },
    });
    let reads = 0;
    const migration = new LegacyPaintMigration({
      read: async () => {
        const snapshot = await storage.read();
        if (++reads === 1)
          await storage.update((current) => ({
            ...current,
            paint: { n: "#ABCDEF" },
          }));
        return snapshot;
      },
      update: storage.update,
    });
    const sent: Command[] = [];
    await migration.migrate(graph([node("n")]), async (command) => {
      sent.push(command);
      if (sent.length > 1)
        throw new Error("A stale retirement resubmitted the new value");
      return true;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "node.paint",
      colors: [{ id: "n", color: "#abcdef" }],
    });
    expect(JSON.parse(stored).paint).toEqual({});
    expect(migration.getState()).toEqual({ pending: false, error: null });
  });

  test("malformed preference JSON can be replaced but storage read errors cannot erase colors", async () => {
    let stored = "{broken";
    const next = await updateDraggingPreference(
      createPreferencesStorage({
        key: "synthetic-malformed",
        read: () => stored,
        write: async (value) => {
          stored = value;
        },
      }),
      false,
    );
    expect(JSON.parse(stored)).toEqual(next);
    expect(next).toEqual({ paint: {}, connectWhileDragging: false });
    let writes = 0;
    await expect(
      updateDraggingPreference(
        createPreferencesStorage({
          key: "synthetic-read-failed",
          read: () => {
            throw new Error("Cannot read file");
          },
          write: async () => {
            writes++;
          },
        }),
        true,
      ),
    ).rejects.toThrow("Cannot read file");
    expect(writes).toBe(0);
    expect(
      parsePreferences({
        paint: { good: "#ABC123", invalid: "red" },
        connectWhileDragging: false,
      }),
    ).toEqual({ paint: { good: "#ABC123" }, connectWhileDragging: false });
  });
});

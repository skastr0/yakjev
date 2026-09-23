import { describe, expect, test } from "bun:test";
import {
  initialTaxonomy,
  type Command,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import {
  LegacyPaintMigration,
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
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function harness(paint: Record<string, string>, connectWhileDragging = false) {
  let stored: DisplayPreferences = { paint, connectWhileDragging };
  let failedWrite = false;
  const notifications: unknown[] = [];
  const migration = new LegacyPaintMigration(
    {
      read: () => structuredClone(stored),
      write: (value) => {
        if (failedWrite) throw new Error("Synthetic disk failure");
        stored = structuredClone(value);
      },
    },
    (state, preferences) => notifications.push({ state, preferences }),
  );
  return {
    migration,
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
    const running = h.migration.migrate(
      graph([node("n")]),
      async () => save.promise,
    );
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

  test("malformed preference JSON can be replaced but storage read errors cannot erase colors", () => {
    let stored = "{broken";
    const next = updateDraggingPreference(
      {
        read: () => stored,
        write: (value) => {
          stored = value;
        },
      },
      false,
    );
    expect(JSON.parse(stored)).toEqual(next);
    expect(next).toEqual({ paint: {}, connectWhileDragging: false });
    let writes = 0;
    expect(() =>
      updateDraggingPreference(
        {
          read: () => {
            throw new Error("Cannot read file");
          },
          write: () => {
            writes++;
          },
        },
        true,
      ),
    ).toThrow("Cannot read file");
    expect(writes).toBe(0);
    expect(
      parsePreferences({
        paint: { good: "#ABC123", invalid: "red" },
        connectWhileDragging: false,
      }),
    ).toEqual({ paint: { good: "#ABC123" }, connectWhileDragging: false });
  });
});

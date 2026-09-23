import { describe, expect, test } from "bun:test";
import {
  initialTaxonomy,
  type Command,
  type Graph,
  type Node,
} from "@yakjev/protocol";
import { applyOptimistic } from "./optimistic";
import {
  clearLegacyPaint,
  LEGACY_PAINT_KEY,
  migrateLegacyPaint,
  readLegacyPaint,
} from "./paint-migration";

const provenance = {
  actor: { id: "color-test", channel: "browser" as const },
  at: "2026-09-23T00:00:00.000Z",
  revision: 1,
};

function node(id: string, color?: string | null): Node {
  return {
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
  };
}

function graph(nodes: readonly Node[]): Graph {
  return {
    revision: 1,
    nodes,
    edges: [],
    captures: [],
    suggestions: [],
    evaluations: [],
    taxonomy: initialTaxonomy,
  };
}

function memoryStorage(paint: Record<string, string>) {
  const values = new Map([[LEGACY_PAINT_KEY, JSON.stringify(paint)]]);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("legacy browser color migration", () => {
  test("imports only unset nodes and retires acknowledged/resolved entries", async () => {
    const storage = memoryStorage({
      unset: "#ED4968",
      default: "#8672fd",
      painted: "#8672fd",
      removed: "#8672fd",
    });
    let canonical = graph([
      node("unset"),
      node("default", null),
      node("painted", "#159b05"),
    ]);
    const sent: Command[] = [];
    await migrateLegacyPaint({
      storage,
      graph: () => canonical,
      signal: new AbortController().signal,
      execute: async (command) => {
        sent.push(command);
        canonical = applyOptimistic(canonical, command);
        return true;
      },
    });
    expect(sent).toEqual([
      {
        type: "node.paint",
        onlyIfUnset: true,
        colors: [{ id: "unset", color: "#ed4968" }],
      },
    ]);
    expect(canonical.nodes.map((item) => item.color)).toEqual([
      "#ed4968",
      null,
      "#159b05",
    ]);
    expect(readLegacyPaint(storage)).toEqual({ removed: "#8672fd" });

    // Undo restoring an unset color cannot resurrect the retired browser copy.
    canonical = graph([node("unset")]);
    await migrateLegacyPaint({
      storage,
      graph: () => canonical,
      signal: new AbortController().signal,
      execute: async (command) => {
        sent.push(command);
        return true;
      },
    });
    expect(sent).toHaveLength(1);
  });

  test("uses bounded batches from fresh canonical snapshots", async () => {
    const nodes = Array.from({ length: 205 }, (_, index) =>
      node(`node-${index}`),
    );
    let canonical = graph(nodes);
    const storage = memoryStorage(
      Object.fromEntries(nodes.map((item) => [item.id, "#ed4968"])),
    );
    const sizes: number[] = [];
    await migrateLegacyPaint({
      storage,
      graph: () => canonical,
      signal: new AbortController().signal,
      execute: async (command) => {
        if (command.type !== "node.paint") throw new Error("Wrong command");
        sizes.push(command.colors.length);
        canonical = applyOptimistic(canonical, command);
        return true;
      },
    });
    expect(sizes).toEqual([100, 100, 5]);
    expect(readLegacyPaint(storage)).toEqual({});
  });

  test("retains colors for nodes missing from an initial stale snapshot", async () => {
    const storage = memoryStorage({ incoming: "#ed4968" });
    let canonical = graph([]);
    let sent = 0;
    const input = {
      storage,
      graph: () => canonical,
      signal: new AbortController().signal,
      execute: async (command: Command) => {
        sent++;
        canonical = applyOptimistic(canonical, command);
        return true;
      },
    };
    expect(await migrateLegacyPaint(input)).toBe(true);
    expect(sent).toBe(0);
    expect(readLegacyPaint(storage)).toEqual({ incoming: "#ed4968" });
    canonical = graph([node("incoming")]);
    expect(await migrateLegacyPaint(input)).toBe(false);
    expect(sent).toBe(1);
    expect(canonical.nodes[0]?.color).toBe("#ed4968");
    expect(readLegacyPaint(storage)).toEqual({});
  });

  test("retains an unacknowledged batch for visible retry", async () => {
    const storage = memoryStorage({ a: "#ed4968", b: "#159b05" });
    const input = {
      storage,
      graph: () => graph([node("a"), node("b")]),
      signal: new AbortController().signal,
      execute: async () => false,
    };
    await expect(migrateLegacyPaint(input)).rejects.toThrow(
      "have not been saved",
    );
    expect(readLegacyPaint(storage)).toEqual({ a: "#ed4968", b: "#159b05" });
    await migrateLegacyPaint({ ...input, execute: async () => true });
    expect(readLegacyPaint(storage)).toEqual({});
  });

  test("reports blocked storage without sending a graph command", async () => {
    let sent = false;
    const storage = {
      ...memoryStorage({ a: "#ed4968" }),
      getItem: () => {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    };
    await expect(
      migrateLegacyPaint({
        storage,
        graph: () => graph([node("a")]),
        signal: new AbortController().signal,
        execute: async () => {
          sent = true;
          return true;
        },
      }),
    ).rejects.toThrow("Storage unavailable");
    expect(sent).toBe(false);
  });

  test("cleanup errors retain the browser record and propagate for retry", async () => {
    const storage = memoryStorage({ a: "#ed4968" });
    const failing = {
      ...storage,
      removeItem: () => {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    };
    await expect(
      migrateLegacyPaint({
        storage: failing,
        graph: () => graph([node("a")]),
        signal: new AbortController().signal,
        execute: async () => true,
      }),
    ).rejects.toThrow("Storage unavailable");
    expect(readLegacyPaint(storage)).toEqual({ a: "#ed4968" });
  });

  test("cleanup preserves another tab's changed values and unrelated entries", () => {
    const storage = memoryStorage({ a: "#159b05", b: "#8672fd" });
    clearLegacyPaint(storage, { a: "#ed4968" });
    expect(readLegacyPaint(storage)).toEqual({ a: "#159b05", b: "#8672fd" });
    clearLegacyPaint(storage, { a: "#159b05" });
    expect(readLegacyPaint(storage)).toEqual({ b: "#8672fd" });
  });

  test("an aborted session cannot begin migration", async () => {
    const controller = new AbortController();
    controller.abort();
    let sent = false;
    const storage = memoryStorage({ a: "#ed4968" });
    await migrateLegacyPaint({
      storage,
      graph: () => graph([node("a")]),
      signal: controller.signal,
      execute: async () => {
        sent = true;
        return true;
      },
    });
    expect(sent).toBe(false);
    expect(readLegacyPaint(storage)).toEqual({ a: "#ed4968" });
  });

  test("logout stops the next batch while retiring an acknowledged first batch", async () => {
    const controller = new AbortController();
    const nodes = Array.from({ length: 101 }, (_, index) =>
      node(`node-${index}`),
    );
    const storage = memoryStorage(
      Object.fromEntries(nodes.map((item) => [item.id, "#ed4968"])),
    );
    let sent = 0;
    await migrateLegacyPaint({
      storage,
      graph: () => graph(nodes),
      signal: controller.signal,
      execute: async () => {
        sent++;
        controller.abort();
        return true;
      },
    });
    expect(sent).toBe(1);
    expect(readLegacyPaint(storage)).toEqual({ "node-100": "#ed4968" });
  });

  test("cancelling an unacknowledged request retains its colors without an error", async () => {
    const controller = new AbortController();
    const storage = memoryStorage({ a: "#ed4968" });
    await migrateLegacyPaint({
      storage,
      graph: () => graph([node("a")]),
      signal: controller.signal,
      execute: async () => {
        controller.abort();
        return false;
      },
    });
    expect(readLegacyPaint(storage)).toEqual({ a: "#ed4968" });
  });

  test("an undo tombstone retires a lost acknowledgement without repainting", async () => {
    const storage = memoryStorage({ a: "#ed4968" });
    const controller = new AbortController();
    let canonical = graph([node("a")]);
    let sent = 0;
    await migrateLegacyPaint({
      storage,
      graph: () => canonical,
      signal: controller.signal,
      execute: async (command) => {
        sent++;
        canonical = applyOptimistic(canonical, command);
        controller.abort();
        return false;
      },
    });
    expect(readLegacyPaint(storage)).toEqual({ a: "#ed4968" });
    // The server's cosmetic Undo marks the previous default explicitly, so
    // every client can distinguish the undone paint from a legacy unset node.
    canonical = graph([node("a", null)]);
    await migrateLegacyPaint({
      storage,
      graph: () => canonical,
      signal: new AbortController().signal,
      execute: async () => {
        sent++;
        return true;
      },
    });
    expect(sent).toBe(1);
    expect(readLegacyPaint(storage)).toEqual({});
    expect(canonical.nodes[0]?.color).toBeNull();
  });
});

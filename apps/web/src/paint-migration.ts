import type { Command, Graph } from "@yakjev/protocol";
import { legacyPaintCommand } from "./graph-commands";

export const LEGACY_PAINT_KEY = "yakjev.nodePaint";

type Paint = Readonly<Record<string, string>>;
type PaintStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readLegacyPaint(storage: PaintStorage): Paint {
  const parsed: unknown = JSON.parse(storage.getItem(LEGACY_PAINT_KEY) ?? "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("The saved browser colors could not be read.");
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && /^#[0-9a-fA-F]{6}$/.test(entry[1]),
    ),
  );
}

// Re-read before clearing: another tab may have changed an entry while the
// command was in flight. Only retire the exact values resolved by the graph.
export function clearLegacyPaint(storage: PaintStorage, resolved: Paint) {
  if (Object.keys(resolved).length === 0) return;
  const latest = { ...readLegacyPaint(storage) };
  let changed = false;
  for (const [id, color] of Object.entries(resolved)) {
    if (Object.hasOwn(latest, id) && latest[id] === color) {
      delete latest[id];
      changed = true;
    }
  }
  if (!changed) return;
  if (Object.keys(latest).length === 0) storage.removeItem(LEGACY_PAINT_KEY);
  else storage.setItem(LEGACY_PAINT_KEY, JSON.stringify(latest));
}

function resolvedPaint(graph: Graph, legacy: Paint): Paint {
  const resolved = new Set(
    graph.nodes
      .filter((node) => node.color !== undefined)
      .map((node) => node.id),
  );
  return Object.fromEntries(
    Object.entries(legacy).filter(([id]) => resolved.has(id)),
  );
}

// True means some legacy entries need a newer snapshot. A batch receipt alone
// cannot resolve them: onlyIfUnset deliberately skips nodes removed in flight.
export async function migrateLegacyPaint({
  storage,
  graph,
  execute,
  signal,
}: {
  storage: PaintStorage;
  graph: () => Graph | null;
  execute: (command: Command) => Promise<boolean>;
  signal: AbortSignal;
}): Promise<boolean> {
  const attempted = new Set<string>();
  while (!signal.aborted) {
    const current = graph();
    if (!current) return false;
    const legacy = readLegacyPaint(storage);
    const resolved = resolvedPaint(current, legacy);
    clearLegacyPaint(storage, resolved);
    const pending = Object.entries(legacy).filter(
      ([id]) => !Object.hasOwn(resolved, id),
    );
    const available = Object.fromEntries(
      pending.filter(([id]) => !attempted.has(id)),
    );
    const command = legacyPaintCommand(current, available);
    if (!command) return pending.length > 0;
    if (signal.aborted) return false;
    for (const { id } of command.colors) attempted.add(id);
    const saved = await execute(command);
    if (!saved) {
      if (signal.aborted) return false;
      throw new Error(
        "Existing browser colors have not been saved to the graph.",
      );
    }
    const confirmed = graph();
    if (!confirmed) return true;
    clearLegacyPaint(storage, resolvedPaint(confirmed, legacy));
    // Continue other eligible entries, but never resubmit an unresolved ID in
    // this run. Missing nodes and stale snapshots must not block later batches.
  }
  return false;
}

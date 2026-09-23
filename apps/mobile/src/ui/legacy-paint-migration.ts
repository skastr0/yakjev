import { errorMessage, legacyPaintCommand } from "@yakjev/client";
import type { Command, Graph } from "@yakjev/protocol";

export type DisplayPreferences = {
  paint: Readonly<Record<string, string>>;
  connectWhileDragging: boolean;
};
export type PaintMigrationExecute = (
  command: Command,
  onSaved: () => void,
) => Promise<boolean>;
export type PreferencesStorage = {
  read(): Promise<DisplayPreferences>;
  update(
    change: (value: DisplayPreferences) => DisplayPreferences,
    recoverMalformed?: boolean,
  ): Promise<DisplayPreferences>;
};
export type MigrationState = { pending: boolean; error: string | null };

const pendingFiles = new Map<string, Promise<void>>();

// Key by file, not client: a late acknowledgement and a replacement session's
// toggle must serialize their reads as well as their atomic writes.
function withFile<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (pendingFiles.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(
    () => {},
    () => {},
  );
  pendingFiles.set(key, tail);
  void tail.then(() => {
    if (pendingFiles.get(key) === tail) pendingFiles.delete(key);
  });
  return result;
}

export function createPreferencesStorage(file: {
  key: string;
  read(): string | null | Promise<string | null>;
  write(value: string): Promise<void>;
}): PreferencesStorage {
  const read = async (recoverMalformed = false) => {
    const raw = await file.read();
    let decoded: unknown = null;
    try {
      decoded = JSON.parse(raw ?? "null");
    } catch (cause) {
      if (!recoverMalformed) throw cause;
    }
    return parsePreferences(decoded);
  };
  return {
    read: () => withFile(file.key, () => read()),
    update: (change, recoverMalformed = false) =>
      withFile(file.key, async () => {
        const current = await read(recoverMalformed);
        const next = change(current);
        if (next !== current) await file.write(JSON.stringify(next));
        return next;
      }),
  };
}

export function parsePreferences(value: unknown): DisplayPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { paint: {}, connectWhileDragging: true };
  const data = value as Record<string, unknown>;
  const paint =
    data.paint && typeof data.paint === "object" && !Array.isArray(data.paint)
      ? Object.fromEntries(
          Object.entries(data.paint).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" &&
              /^#[0-9a-fA-F]{6}$/.test(entry[1]),
          ),
        )
      : {};
  return { paint, connectWhileDragging: data.connectWhileDragging !== false };
}

export function updateDraggingPreference(
  storage: PreferencesStorage,
  enabled: boolean,
): Promise<DisplayPreferences> {
  // An unreadable file is not malformed JSON: do not discard saved colors
  // because a transient storage read failed.
  return storage.update(
    (current) => ({ ...current, connectWhileDragging: enabled }),
    true,
  );
}

/** One server file and one client lifetime; durable cleanup only follows proof. */
export class LegacyPaintMigration {
  private state: MigrationState = { pending: false, error: null };
  private running: Promise<void> | null = null;
  private graph: Graph | null = null;
  private blocked = false;
  private waitingRevision: number | null = null;
  private readonly waitingColors = new Map<string, string>();
  private disposed = false;
  // A failed disk cleanup must not re-import an acknowledged color after Undo.
  private readonly retired = new Map<string, string>();

  constructor(
    private readonly storage: PreferencesStorage,
    private readonly changed: (
      state: MigrationState,
      preferences?: DisplayPreferences,
    ) => void = () => {},
  ) {}

  getState = () => this.state;
  private publish(
    patch: Partial<MigrationState>,
    preferences?: DisplayPreferences,
  ) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state, preferences);
  }

  private async retire(
    values: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    for (const [id, color] of Object.entries(values))
      this.retired.set(id, color);
    const retiring = new Map(this.retired);
    try {
      const next = await this.storage.update((latest) => {
        const paint = { ...latest.paint };
        let changed = false;
        for (const [id, color] of retiring) {
          if (Object.hasOwn(paint, id) && paint[id] === color) {
            delete paint[id];
            changed = true;
          }
        }
        return changed ? { ...latest, paint } : latest;
      });
      for (const [id, color] of retiring)
        if (this.retired.get(id) === color) this.retired.delete(id);
      const pending = Object.keys(next.paint).length > 0;
      this.publish(
        { pending, error: this.blocked && pending ? this.state.error : null },
        next,
      );
      return true;
    } catch (cause) {
      this.publish({
        pending: true,
        error: `Existing colors are safe, but migration cleanup needs a retry. ${errorMessage(cause)}`,
      });
      return false;
    }
  }

  migrate = (
    graph: Graph,
    execute: PaintMigrationExecute,
    getGraph: () => Graph | null,
    retry = false,
  ): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    this.graph = getGraph();
    if (!this.graph) return Promise.resolve();
    if (this.running) return this.running;
    if (
      retry ||
      (this.waitingRevision !== null &&
        this.graph.revision > this.waitingRevision)
    ) {
      this.blocked = false;
      this.waitingRevision = null;
      this.waitingColors.clear();
    }
    const result = this.run(execute, getGraph);
    this.running = result;
    void result.finally(() => {
      if (this.running === result) this.running = null;
    });
    return result;
  };

  private async run(
    execute: PaintMigrationExecute,
    getGraph: () => Graph | null,
  ) {
    const attempted = new Set<string>();
    try {
      while (!this.disposed) {
        const graph = getGraph();
        if (!graph) return;
        const legacy = (await this.storage.read()).paint;
        if (this.disposed) return;
        const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
        const resolved = Object.fromEntries(
          Object.entries(legacy).filter(([id]) => {
            const node = nodes.get(id);
            return node !== undefined && node.color !== undefined;
          }),
        );
        // Canonical null is a deliberate clear. It resolves a legacy entry and
        // must never be treated as permission to resurrect its old color.
        if (!(await this.retire(resolved))) {
          this.blocked = true;
          return;
        }
        const remaining = (await this.storage.read()).paint;
        for (const [id, color] of this.waitingColors)
          if (remaining[id] !== color) this.waitingColors.delete(id);
        const eligible = Object.fromEntries(
          Object.entries(remaining).filter(
            ([id, color]) =>
              !attempted.has(id) && this.waitingColors.get(id) !== color,
          ),
        );
        const command = legacyPaintCommand(graph, eligible);
        if (this.disposed) return;
        if (!command) {
          this.blocked = this.waitingColors.size > 0;
          if (!this.blocked) this.waitingRevision = null;
          this.publish({
            pending: Object.keys(remaining).length > 0,
            error: this.blocked
              ? "Some existing colors are waiting for current graph data. Reconnect or retry colors."
              : null,
          });
          return;
        }
        if (this.blocked) return;
        for (const { id } of command.colors) attempted.add(id);
        const acknowledgement: { cleanup: Promise<boolean> | null } = {
          cleanup: null,
        };
        const acknowledge = () => {
          if (acknowledgement.cleanup) return;
          const canonical = getGraph();
          const nodes = new Map(
            canonical?.nodes.map((node) => [node.id, node]),
          );
          const resolved = command.colors.filter(
            ({ id }) => nodes.get(id)?.color !== undefined,
          );
          const unresolved = resolved.length !== command.colors.length;
          for (const { id } of command.colors) {
            if (nodes.get(id)?.color === undefined)
              this.waitingColors.set(id, remaining[id]!);
            else this.waitingColors.delete(id);
          }
          this.blocked = false;
          if (unresolved)
            this.waitingRevision = Math.max(
              this.waitingRevision ?? 0,
              graph.revision,
              canonical?.revision ?? graph.revision,
            );
          if (unresolved)
            this.publish({
              pending: true,
              error:
                "Some existing colors are waiting for current graph data. Reconnect or retry colors.",
            });
          // Even a late receipt can retire exact entries in this captured old
          // server file. It never updates a replacement session or sends work.
          acknowledgement.cleanup = this.retire(
            Object.fromEntries(resolved.map(({ id }) => [id, remaining[id]!])),
          ).then((cleaned) => {
            this.blocked = !cleaned;
            if (cleaned && this.waitingColors.size > 0)
              this.publish({
                pending: true,
                error:
                  "Some existing colors are waiting for current graph data. Reconnect or retry colors.",
              });
            return cleaned;
          });
        };
        const saved = await execute(command, acknowledge);
        if (saved) acknowledge();
        const cleaned = acknowledgement.cleanup
          ? await acknowledgement.cleanup
          : false;
        if (this.disposed) return;
        if (!saved && !acknowledgement.cleanup) {
          this.blocked = true;
          this.publish({
            pending: true,
            error:
              "Existing device colors have not been confirmed in the graph. Retry the save or retry colors.",
          });
          return;
        }
        if (!cleaned) return;
      }
    } catch (cause) {
      this.blocked = true;
      this.publish({
        pending: true,
        error: `Existing device colors have not been migrated. ${errorMessage(cause)}`,
      });
    }
  }

  dispose = () => {
    this.disposed = true;
  };
}

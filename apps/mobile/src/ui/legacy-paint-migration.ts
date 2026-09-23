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
  read(): DisplayPreferences;
  write(value: DisplayPreferences): void;
};
export type MigrationState = { pending: boolean; error: string | null };

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
  file: { read(): string | null; write(value: string): void },
  enabled: boolean,
): DisplayPreferences {
  // An unreadable file is not malformed JSON: do not discard saved colors
  // because a transient storage read failed.
  const raw = file.read();
  let decoded: unknown = null;
  try {
    decoded = JSON.parse(raw ?? "null");
  } catch {
    /* Replace malformed JSON. */
  }
  const next = { ...parsePreferences(decoded), connectWhileDragging: enabled };
  file.write(JSON.stringify(next));
  return next;
}

/** One server file and one client lifetime; durable cleanup only follows proof. */
export class LegacyPaintMigration {
  private state: MigrationState = { pending: false, error: null };
  private running: Promise<void> | null = null;
  private graph: Graph | null = null;
  private blocked = false;
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

  private retire(values: Readonly<Record<string, string>>): boolean {
    for (const [id, color] of Object.entries(values))
      this.retired.set(id, color);
    try {
      // Read immediately before the synchronous write. A newer preference or
      // differently-valued entry in the same server file must survive cleanup.
      const latest = this.storage.read();
      const paint = { ...latest.paint };
      let changed = false;
      for (const [id, color] of this.retired) {
        if (Object.hasOwn(paint, id) && paint[id] === color) {
          delete paint[id];
          changed = true;
        }
      }
      const next = { ...latest, paint };
      if (changed) this.storage.write(next);
      this.retired.clear();
      const pending = Object.keys(paint).length > 0;
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
    retry = false,
  ): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    this.graph = graph;
    if (this.running) return this.running;
    if (retry) this.blocked = false;
    const result = this.run(execute);
    this.running = result;
    void result.finally(() => {
      if (this.running === result) this.running = null;
    });
    return result;
  };

  private async run(execute: PaintMigrationExecute) {
    try {
      while (!this.disposed && this.graph) {
        const graph = this.graph;
        const legacy = this.storage.read().paint;
        const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
        const resolved = Object.fromEntries(
          Object.entries(legacy).filter(([id]) => {
            const node = nodes.get(id);
            return node !== undefined && node.color !== undefined;
          }),
        );
        // Canonical null is a deliberate clear. It resolves a legacy entry and
        // must never be treated as permission to resurrect its old color.
        if (!this.retire(resolved)) {
          this.blocked = true;
          return;
        }
        const command = legacyPaintCommand(graph, this.storage.read().paint);
        if (!command) {
          this.blocked = false;
          return;
        }
        if (this.blocked) return;
        let acknowledged = false;
        let cleaned = false;
        const acknowledge = () => {
          if (acknowledged) return;
          acknowledged = true;
          this.blocked = false;
          // Even a late receipt can retire exact entries in this captured old
          // server file. It never updates a replacement session or sends work.
          cleaned = this.retire(
            Object.fromEntries(
              command.colors.map(({ id }) => [id, legacy[id]!]),
            ),
          );
          this.blocked = !cleaned;
        };
        const saved = await execute(command, acknowledge);
        if (saved) acknowledge();
        if (this.disposed) return;
        if (!saved && !acknowledged) {
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

import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  type Actor,
  CommandRequest,
  type CommandResult,
  Graph,
  HistoryEntry,
  initialTaxonomy,
  type LayoutPoint,
  Receipt,
} from "@yakjev/protocol";
import { Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DomainError, evolve, supersedeSuggestions } from "./domain";

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: unknown;
}> {}

const GraphJson = Schema.fromJsonString(Graph);
const ReceiptJson = Schema.fromJsonString(Receipt);
const HistoryJson = Schema.fromJsonString(HistoryEntry);
const withoutPaint = (graph: Graph) => ({
  ...graph,
  revision: 0,
  nodes: graph.nodes.map(({ color: _color, ...node }) => node),
});
const empty: Graph = {
  revision: 0,
  nodes: [],
  edges: [],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
};

export class Store extends Context.Service<Store>()("@yakjev/Store", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // One authoritative graph document plus an immutable transaction journal.
    // No second browser/MCP store; before-images make conservative undo exact.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS graph_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        graph TEXT NOT NULL
      )`;
        yield* sql`CREATE TABLE IF NOT EXISTS graph_history (
        revision INTEGER PRIMARY KEY,
        actor_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request TEXT NOT NULL,
        receipt TEXT NOT NULL,
        entry TEXT NOT NULL,
        before_graph TEXT NOT NULL,
        UNIQUE (actor_id, request_id)
      )`;
        yield* sql`INSERT OR IGNORE INTO graph_state (singleton, revision, graph)
        VALUES (1, 0, ${JSON.stringify(empty)})`;
        // Canvas positions: display state, deliberately outside the journal.
        yield* sql`CREATE TABLE IF NOT EXISTS node_layout (
        node_id TEXT PRIMARY KEY,
        x REAL NOT NULL,
        y REAL NOT NULL
      )`;
      }),
    );

    const snapshot = Effect.fn("Store.snapshot")(function* () {
      const rows =
        yield* sql`SELECT graph FROM graph_state WHERE singleton = 1`;
      return yield* Schema.decodeUnknownEffect(GraphJson)(rows[0]?.graph);
    });
    const read = snapshot().pipe(
      Effect.mapError((cause) => new StorageError({ cause })),
    );
    const history = Effect.fn("Store.history")(
      function* (after: number, limit: number) {
        const rows =
          yield* sql`SELECT entry FROM graph_history WHERE revision > ${after}
        ORDER BY revision LIMIT ${Math.min(1000, Math.max(1, limit))}`;
        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(HistoryJson)(row.entry),
        );
      },
      Effect.mapError((cause) => new StorageError({ cause })),
    );
    const events = Effect.fn("Store.events")(
      function* (after: number) {
        const rows =
          yield* sql`SELECT receipt FROM graph_history WHERE revision > ${after} ORDER BY revision LIMIT 100`;
        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(ReceiptJson)(row.receipt),
        );
      },
      Effect.mapError((cause) => new StorageError({ cause })),
    );
    const findRequest = Effect.fn("Store.findRequest")(
      function* (actor: Actor, requestId: string) {
        const rows =
          yield* sql`SELECT entry FROM graph_history WHERE actor_id = ${actor.id} AND request_id = ${requestId}`;
        return rows[0]
          ? yield* Schema.decodeUnknownEffect(HistoryJson)(rows[0].entry)
          : null;
      },
      Effect.mapError((cause) => new StorageError({ cause })),
    );
    const evaluation = Effect.fn("Store.evaluation")(
      function* (id: string) {
        const rows =
          yield* sql`SELECT entry FROM graph_history WHERE json_extract(entry, '$.command.evaluation.id') = ${id} LIMIT 1`;
        if (!rows[0])
          return yield* new DomainError({
            code: "NotFound",
            message: "Unknown evaluation",
          });
        const entry = yield* Schema.decodeUnknownEffect(HistoryJson)(
          rows[0].entry,
        );
        if (entry.command.type !== "evaluation.record")
          return yield* new DomainError({
            code: "NotFound",
            message: "Unknown evaluation",
          });
        return {
          ...entry.command.evaluation,
          provenance: {
            actor: entry.actor,
            at: entry.at,
            revision: entry.revision,
          },
        };
      },
      Effect.mapError((cause) =>
        cause instanceof DomainError ? cause : new StorageError({ cause }),
      ),
    );
    const layoutRows = Effect.gen(function* () {
      const graph = yield* snapshot();
      const ids = new Set(graph.nodes.map((node) => node.id));
      const rows =
        yield* sql`SELECT node_id, x, y FROM node_layout ORDER BY node_id`;
      // Removed nodes keep a harmless row; only live nodes are returned.
      return rows.flatMap((row) =>
        ids.has(String(row.node_id))
          ? [{ id: String(row.node_id), x: Number(row.x), y: Number(row.y) }]
          : [],
      );
    });
    const layout = layoutRows.pipe(
      Effect.map((positions) => ({ positions })),
      Effect.mapError((cause) => new StorageError({ cause })),
    );
    const saveLayout = Effect.fn("Store.saveLayout")(
      function* (positions: readonly LayoutPoint[]) {
        yield* sql.withTransaction(
          Effect.forEach(
            positions,
            (point) =>
              sql`INSERT INTO node_layout (node_id, x, y) VALUES (${point.id}, ${point.x}, ${point.y})
              ON CONFLICT(node_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
            { discard: true },
          ),
        );
        return { saved: positions.length };
      },
      Effect.mapError((cause) => new StorageError({ cause })),
    );
    const exportGraph = sql
      .withTransaction(
        Effect.gen(function* () {
          const graph = yield* snapshot();
          const rows =
            yield* sql`SELECT entry FROM graph_history ORDER BY revision`;
          const history = yield* Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(HistoryJson)(row.entry),
          );
          const positions = yield* layoutRows;
          return { graph, history, layout: { positions } };
        }),
      )
      .pipe(Effect.mapError((cause) => new StorageError({ cause })));

    const execute = Effect.fn("Store.execute")(function* (
      actor: Actor,
      input: unknown,
    ) {
      const request = yield* Schema.decodeUnknownEffect(CommandRequest)(input, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          () =>
            new DomainError({
              code: "Invalid",
              message: "Invalid command request",
            }),
        ),
      );
      const encoded = JSON.stringify(request);
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Replay precedes revision validation: a lost response is retried at its original base.
            const old = yield* sql`SELECT request, receipt FROM graph_history
          WHERE actor_id = ${actor.id} AND request_id = ${request.requestId}`;
            if (old[0]) {
              if (old[0].request !== encoded)
                return yield* new DomainError({
                  code: "Conflict",
                  message: "requestId was used with a different payload",
                });
              const receipt = yield* Schema.decodeUnknownEffect(ReceiptJson)(
                old[0].receipt,
              );
              return { receipt, replayed: true } satisfies CommandResult;
            }
            const before = yield* snapshot();
            if (before.revision !== request.expectedRevision)
              return yield* new DomainError({
                code: "Conflict",
                message: "Graph revision changed; refresh before editing",
                currentRevision: before.revision,
              });
            const at = DateTime.formatIso(yield* DateTime.now);
            let after: Graph;
            if (request.command.type === "undo") {
              if (request.command.revision !== before.revision)
                return yield* new DomainError({
                  code: "Conflict",
                  message:
                    "Undo requires the current revision; explicitly edit after intervening changes",
                  currentRevision: before.revision,
                });
              const rows =
                yield* sql`SELECT before_graph, entry FROM graph_history WHERE revision = ${request.command.revision}`;
              if (!rows[0])
                return yield* new DomainError({
                  code: "NotFound",
                  message: "Unknown undo revision",
                });
              const previous = yield* Schema.decodeUnknownEffect(GraphJson)(
                rows[0].before_graph,
              );
              const undone = yield* Schema.decodeUnknownEffect(HistoryJson)(
                rows[0].entry,
              );
              const cosmeticUndo =
                undone.command.type === "node.paint" ||
                (undone.command.type === "undo" &&
                  JSON.stringify(withoutPaint(before)) ===
                    JSON.stringify(withoutPaint(previous)));
              const currentColors = new Map(
                before.nodes.map((node) => [node.id, node.color]),
              );
              after = {
                ...previous,
                revision: before.revision + 1,
                // Restoring status color is deliberate even when a node.put
                // changed color alongside content. Keep stale imports blocked.
                nodes: previous.nodes.map((node) =>
                  node.color === undefined &&
                  currentColors.get(node.id) !== undefined
                    ? { ...node, color: null }
                    : node,
                ),
              };
              // Never reuse taxonomy versions after undo: old inferences must stay stale.
              if (previous.taxonomy.version !== before.taxonomy.version)
                after = {
                  ...after,
                  taxonomy: {
                    ...previous.taxonomy,
                    version: before.taxonomy.version + 1,
                  },
                };
              // Semantic restores are new edits. Undoing paint (including an
              // undo of that undo) preserves the same content freshness.
              if (!cosmeticUndo) {
                after = {
                  ...after,
                  nodes: after.nodes.map((node) => ({
                    ...node,
                    updated: { actor, at, revision: after.revision },
                  })),
                  edges: after.edges.map((edge) => ({
                    ...edge,
                    updated: { actor, at, revision: after.revision },
                  })),
                };
                after = supersedeSuggestions(after);
              }
            } else {
              after = yield* evolve(before, request.command, actor, at);
            }
            const receipt: Receipt = {
              requestId: request.requestId,
              revision: after.revision,
              type: request.command.type,
              actor,
              at,
            };
            const entry: HistoryEntry = {
              ...receipt,
              command: request.command,
            };
            // The stored document must decode on every read. Check the exact
            // bytes before commit: a state that cannot round-trip the schema
            // fails this command instead of wedging every later read.
            const afterJson = JSON.stringify(after);
            yield* Schema.decodeUnknownEffect(GraphJson)(afterJson);
            yield* sql`UPDATE graph_state SET revision = ${after.revision}, graph = ${afterJson} WHERE singleton = 1`;
            yield* sql`INSERT INTO graph_history (revision, actor_id, request_id, request, receipt, entry, before_graph)
          VALUES (${receipt.revision}, ${actor.id}, ${receipt.requestId}, ${encoded}, ${JSON.stringify(receipt)}, ${JSON.stringify(entry)}, ${JSON.stringify(before)})`;
            return { receipt, replayed: false } satisfies CommandResult;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof DomainError ? cause : new StorageError({ cause }),
          ),
        );
    });
    return {
      read,
      history,
      events,
      evaluation,
      findRequest,
      execute,
      exportGraph,
      layout,
      saveLayout,
      check: read.pipe(Effect.asVoid),
    };
  }).pipe(Effect.mapError((cause) => new StorageError({ cause }))),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export const storeLayer = (path: string) =>
  Store.layer.pipe(
    Layer.provide(SqliteClient.layer({ filename: path, create: true })),
  );

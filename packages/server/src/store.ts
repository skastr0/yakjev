import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: unknown;
}> {}

export class Store extends Context.Service<
  Store,
  { readonly check: Effect.Effect<void, StorageError> }
>()("@yakjev/Store") {}

export const storeLayer = (path: string) =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The Bun driver enables WAL and a 5s busy timeout. Foreign keys stay explicit.
      yield* sql`PRAGMA foreign_keys = ON`.pipe(
        Effect.mapError((cause) => new StorageError({ cause })),
      );
      return {
        check: sql`SELECT count(*) AS count FROM sqlite_schema`.pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new StorageError({ cause })),
        ),
      };
    }),
  ).pipe(Layer.provide(SqliteClient.layer({ filename: path, create: true })));

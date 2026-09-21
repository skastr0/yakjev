import { Database } from "bun:sqlite";
import { Context, Effect, Layer, Schema } from "effect";

export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  { cause: Schema.Defect },
) {}

export class Store extends Context.Tag("@yakjev/Store")<
  Store,
  { readonly check: Effect.Effect<void, StorageError> }
>() {}

export const storeLayer = (path: string) =>
  Layer.scoped(
    Store,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new Database(path, { create: true, strict: true }),
          catch: (cause) => new StorageError({ cause }),
        }),
        (db) => Effect.sync(() => db.close()),
      );
      yield* Effect.try({
        try: () => {
          db.exec(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
          );
          // No speculative graph schema. Future migrations start from this empty store.
        },
        catch: (cause) => new StorageError({ cause }),
      });
      return Store.of({
        check: Effect.try({
          try: () => {
            db.query("SELECT count(*) FROM sqlite_schema").get();
          },
          catch: (cause) => new StorageError({ cause }),
        }),
      });
    }),
  );

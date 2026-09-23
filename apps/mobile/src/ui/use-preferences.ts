import { useCallback, useEffect, useMemo, useState } from "react";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { errorMessage } from "@yakjev/client";
import type { Graph } from "@yakjev/protocol";
import {
  LegacyPaintMigration,
  parsePreferences,
  updateDraggingPreference,
  type DisplayPreferences,
  type MigrationState,
  type PaintMigrationExecute,
} from "./legacy-paint-migration";

type Scope = {
  active: boolean;
  file: File | null;
  migration: LegacyPaintMigration | null;
};
const empty = (): DisplayPreferences => ({
  paint: {},
  connectWhileDragging: true,
});

// Existing colors are migration input only. The server now owns node colors;
// this file retains local interaction preferences and unacknowledged imports.
export function usePreferences(server: string, client: unknown) {
  const scope = useMemo<Scope>(
    () => ({ active: false, file: null, migration: null }),
    [server, client],
  );
  const [snapshot, setSnapshot] = useState<{
    scope: Scope;
    value: DisplayPreferences;
    ready: boolean;
    error: string | null;
    migration: MigrationState;
  }>({
    scope,
    value: empty(),
    ready: false,
    error: null,
    migration: { pending: false, error: null },
  });

  useEffect(() => {
    let active = true;
    scope.active = true;
    setSnapshot({
      scope,
      value: empty(),
      ready: false,
      error: null,
      migration: { pending: false, error: null },
    });
    void (async () => {
      try {
        const id = await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          server,
        );
        if (!active) return;
        const stored = new File(
          Paths.document,
          `yakjev-preferences-${id}.json`,
        );
        // Keep the destination even if JSON is malformed, so the next local
        // preference change can replace the unreadable file with valid data.
        scope.file = stored;
        const storage = {
          read: () =>
            parsePreferences(
              stored.exists ? JSON.parse(stored.textSync()) : null,
            ),
          write: (value: DisplayPreferences) => {
            if (!stored.exists) stored.create();
            stored.write(JSON.stringify(value));
          },
        };
        scope.migration = new LegacyPaintMigration(
          storage,
          (migration, preferences) => {
            if (active)
              setSnapshot((current) =>
                current.scope === scope
                  ? {
                      ...current,
                      migration,
                      ...(preferences ? { value: preferences } : {}),
                    }
                  : current,
              );
          },
        );
        const next = storage.read();
        if (!active) return;
        setSnapshot({
          scope,
          value: next,
          ready: true,
          error: null,
          migration: {
            pending: Object.keys(next.paint).length > 0,
            error: null,
          },
        });
      } catch (cause) {
        if (active)
          setSnapshot((current) => ({
            ...current,
            ready: true,
            error: `Could not read display preferences: ${errorMessage(cause)}`,
          }));
      }
    })();
    return () => {
      active = false;
      scope.active = false;
      scope.migration?.dispose();
      scope.migration = null;
      scope.file = null;
    };
  }, [scope, server]);

  const setConnectWhileDragging = useCallback(
    (enabled: boolean) => {
      if (!scope.active) return;
      try {
        const stored = scope.file;
        if (!stored) throw new Error("Display storage is unavailable.");
        const next = updateDraggingPreference(
          {
            read: () => (stored.exists ? stored.textSync() : null),
            write: (value) => {
              if (!stored.exists) stored.create();
              stored.write(value);
            },
          },
          enabled,
        );
        setSnapshot((current) =>
          current.scope === scope
            ? { ...current, value: next, error: null }
            : current,
        );
      } catch (cause) {
        setSnapshot((current) =>
          current.scope === scope
            ? {
                ...current,
                value: { ...current.value, connectWhileDragging: enabled },
                error: `Display changes are temporary: ${errorMessage(cause)}`,
              }
            : current,
        );
      }
    },
    [scope],
  );

  const migrateColors = useCallback(
    (graph: Graph, execute: PaintMigrationExecute) =>
      scope.active && scope.migration
        ? scope.migration.migrate(graph, execute)
        : Promise.resolve(),
    [scope],
  );
  const retryColors = useCallback(
    (graph: Graph, execute: PaintMigrationExecute) =>
      scope.active && scope.migration
        ? scope.migration.migrate(graph, execute, true)
        : Promise.resolve(),
    [scope],
  );
  const current = snapshot.scope === scope ? snapshot : null;
  return {
    connectWhileDragging: current?.value.connectWhileDragging ?? true,
    ready: current?.ready ?? false,
    error: current?.error ?? null,
    legacyPaintPending: current?.migration.pending ?? false,
    migrationError: current?.migration.error ?? null,
    setConnectWhileDragging,
    migrateColors,
    retryColors,
  };
}

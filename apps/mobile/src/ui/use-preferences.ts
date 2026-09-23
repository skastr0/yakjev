import { useCallback, useEffect, useMemo, useState } from "react";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { writeAsStringAsync } from "expo-file-system/legacy";
import { errorMessage } from "@yakjev/client";
import type { Graph } from "@yakjev/protocol";
import {
  LegacyPaintMigration,
  createPreferencesStorage,
  updateDraggingPreference,
  type DisplayPreferences,
  type MigrationState,
  type PaintMigrationExecute,
  type PreferencesStorage,
} from "./legacy-paint-migration";

type Scope = {
  active: boolean;
  storage: PreferencesStorage | null;
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
    () => ({ active: false, storage: null, migration: null }),
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
        const storage = createPreferencesStorage({
          key: stored.uri,
          read: () => (stored.exists ? stored.text() : null),
          // Expo 57's legacy nonappend implementation uses Data.write(.atomic).
          // File.write is non-atomic and can truncate unacknowledged colors.
          write: (value) => writeAsStringAsync(stored.uri, value),
        });
        scope.storage = storage;
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
        const next = await storage.read();
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
      scope.storage = null;
    };
  }, [scope, server]);

  const setConnectWhileDragging = useCallback(
    async (enabled: boolean) => {
      if (!scope.active) return;
      try {
        const storage = scope.storage;
        if (!storage) throw new Error("Display storage is unavailable.");
        const next = await updateDraggingPreference(storage, enabled);
        if (!scope.active) return;
        setSnapshot((current) =>
          current.scope === scope
            ? { ...current, value: next, error: null }
            : current,
        );
      } catch (cause) {
        if (!scope.active) return;
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
    (
      graph: Graph,
      execute: PaintMigrationExecute,
      getGraph: () => Graph | null,
    ) =>
      scope.active && scope.migration
        ? scope.migration.migrate(graph, execute, getGraph)
        : Promise.resolve(),
    [scope],
  );
  const retryColors = useCallback(
    (
      graph: Graph,
      execute: PaintMigrationExecute,
      getGraph: () => Graph | null,
    ) =>
      scope.active && scope.migration
        ? scope.migration.migrate(graph, execute, getGraph, true)
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

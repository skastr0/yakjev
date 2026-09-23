import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command, Graph, Receipt } from "@yakjev/protocol";
import {
  ApiFailure,
  decodeReceipt,
  errorMessage,
  layout as loadLayout,
  request,
  sendCommand,
  snapshot,
} from "./api";
import { applyOptimistic } from "./optimistic";
import { migrateLegacyPaint } from "./paint-migration";

type QueuedCommand = {
  command: Command;
  signal: AbortSignal;
  resolve: (saved: boolean) => void;
};

export function useGraph() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [connection, setConnection] = useState<
    "loading" | "live" | "reconnecting" | "offline" | "locked" | "locking"
  >("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [lastEdit, setLastEdit] = useState<Receipt | null>(null);
  const [session, setSession] = useState(0);
  const [paintMigrationError, setPaintMigrationError] = useState("");
  const [paintMigrationRetry, setPaintMigrationRetry] = useState(0);
  // Saved canvas positions, loaded once per session before the canvas mounts.
  const [layout, setLayout] = useState<ReadonlyMap<
    string,
    { x: number; y: number }
  > | null>(null);
  // Edits sent but not yet confirmed, shown on top of the last snapshot so the
  // graph answers at once instead of after two network round trips.
  const [inFlight, setInFlight] = useState<
    ReadonlyArray<{ key: number; command: Command }>
  >([]);
  const flightKey = useRef(0);
  const current = useRef<Graph | null>(null);
  const queue = useRef<QueuedCommand[]>([]);
  const draining = useRef(false);
  const generation = useRef(0);
  const sessionController = useRef(new AbortController());
  const migrationController = useRef<AbortController | null>(null);
  const waitingForLegacyNodes = useRef(false);

  const stopSession = useCallback(() => {
    sessionController.current.abort();
    migrationController.current?.abort();
    generation.current++;
    current.current = null;
    setInFlight([]);
  }, []);

  const refresh = useCallback(async () => {
    const startedIn = generation.current;
    const next = await snapshot();
    if (
      startedIn === generation.current &&
      (!current.current || next.revision > current.current.revision)
    ) {
      current.current = next;
      setGraph(next);
    }
    return next;
  }, []);

  useEffect(() => {
    let stopped = false;
    let events: EventSource | undefined;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => events?.close(), {
      once: true,
    });
    sessionController.current = controller;
    generation.current++;
    current.current = null;
    setGraph(null);
    setConnection("loading");
    setError("");
    setLayout(null);
    void Promise.all([refresh(), loadLayout()])
      .then(([initial, saved]) => {
        if (stopped || controller.signal.aborted) return;
        setLayout(
          new Map(saved.positions.map((point) => [point.id, point] as const)),
        );
        events = new EventSource(`/api/events?after=${initial.revision}`);
        events.onopen = () => {
          if (!stopped && !controller.signal.aborted) setConnection("live");
        };
        events.onerror = () => {
          if (stopped || controller.signal.aborted) return;
          setConnection("reconnecting");
          // EventSource does not expose HTTP status. A session check makes an
          // expired cookie actionable instead of leaving an infinite spinner.
          void request("/api/session").catch((cause: unknown) => {
            if (
              !stopped &&
              !controller.signal.aborted &&
              cause instanceof ApiFailure &&
              cause.status === 401
            ) {
              events?.close();
              stopSession();
              setGraph(null);
              setConnection("locked");
              setError("Your session expired. Unlock the graph to reconnect.");
            }
          });
        };
        events.addEventListener("change", (event) => {
          if (stopped || controller.signal.aborted) return;
          try {
            decodeReceipt((event as MessageEvent<string>).data);
          } catch {
            setError(
              "Live update could not be read. Reconnect to recover the graph.",
            );
            return;
          }
          void refresh().catch((cause: unknown) => {
            if (stopped || controller.signal.aborted) return;
            setError(errorMessage(cause));
            if (cause instanceof ApiFailure && cause.status === 401) {
              events?.close();
              stopSession();
              setConnection("locked");
              setGraph(null);
            }
          });
        });
      })
      .catch((cause: unknown) => {
        if (stopped || controller.signal.aborted) return;
        setConnection(
          cause instanceof ApiFailure && cause.status === 401
            ? "locked"
            : "offline",
        );
        setError(errorMessage(cause));
      });
    return () => {
      stopped = true;
      controller.abort();
      migrationController.current?.abort();
      generation.current++;
      events?.close();
    };
  }, [session, refresh, stopSession]);

  const saveError = (cause: unknown) =>
    cause instanceof ApiFailure && cause.status === 409
      ? `Not saved: the graph changed. Your draft is kept. Reload latest before trying again. ${cause.message}`
      : cause instanceof ApiFailure && cause.status < 500
        ? `Not saved: ${errorMessage(cause)}`
        : `Save could not be confirmed. Check history before retrying: ${errorMessage(cause)}`;

  // One send attempt: the revision is read from the live snapshot at send
  // time, and undo always targets that revision. Each sendCommand call mints
  // a fresh requestId, so the 409 retry below is never a replayed request.
  const attempt = useCallback(
    async (command: Command, signal: AbortSignal): Promise<boolean> => {
      const wire = (revision: number): Command =>
        command.type === "undo" ? { type: "undo", revision } : command;
      const send = async (revision: number) => {
        if (signal.aborted) return false;
        const result = await sendCommand(wire(revision), revision, signal);
        if (signal.aborted) return true;
        setLastEdit(result.receipt);
        await refresh().catch((cause: unknown) => {
          if (!signal.aborted)
            setError(
              `Saved at revision ${result.receipt.revision}, but refreshing the view failed: ${errorMessage(cause)}`,
            );
        });
        return true;
      };
      const revision = current.current?.revision ?? 0;
      try {
        return await send(revision);
      } catch (cause) {
        if (signal.aborted) return false;
        if (!(cause instanceof ApiFailure && cause.status === 409)) {
          setError(saveError(cause));
          return false;
        }
      }
      // One conflict pass: reload the latest graph, then retry once against
      // the revision just observed. A second failure surfaces for the caller.
      const latest = await refresh().catch(() => null);
      if (signal.aborted) return false;
      try {
        return await send(
          latest?.revision ?? current.current?.revision ?? revision,
        );
      } catch (cause) {
        if (signal.aborted) return false;
        setError(saveError(cause));
        if (cause instanceof ApiFailure && cause.status === 409)
          await refresh().catch(() => {});
        return false;
      }
    },
    [refresh],
  );

  const execute = useCallback(
    (command: Command, _expectedRevision: number, signal?: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        const sessionSignal = sessionController.current.signal;
        const active = signal
          ? AbortSignal.any([sessionSignal, signal])
          : sessionSignal;
        if (active.aborted || !current.current) {
          resolve(false);
          return;
        }
        const key = ++flightKey.current;
        setInFlight((items) => [...items, { key, command }]);
        const land = (saved: boolean) => {
          setInFlight((items) => items.filter((item) => item.key !== key));
          resolve(saved);
        };
        queue.current.push({ command, signal: active, resolve: land });
        if (draining.current) return;
        draining.current = true;
        setPending(true);
        void (async () => {
          try {
            // Re-check the queue after each drain pass and keep going until
            // it is empty; only then release the drain.
            for (;;) {
              let next: QueuedCommand | undefined;
              while ((next = queue.current.shift())) {
                if (next.signal.aborted) {
                  next.resolve(false);
                  continue;
                }
                setError("");
                setNotice("");
                next.resolve(await attempt(next.command, next.signal));
              }
              if (queue.current.length === 0) break;
            }
          } finally {
            draining.current = false;
            setPending(false);
          }
        })();
      }),
    [attempt],
  );

  const readyToMigrate = connection === "live";
  useEffect(() => {
    if (!readyToMigrate) return;
    const controller = new AbortController();
    migrationController.current = controller;
    const startedAt = current.current?.revision;
    setPaintMigrationError("");
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return;
        return migrateLegacyPaint({
          storage: window.localStorage,
          graph: () => current.current,
          execute: (command) =>
            execute(command, current.current?.revision ?? 0, controller.signal),
          signal: controller.signal,
        });
      })
      .then((waiting) => {
        if (controller.signal.aborted) return;
        waitingForLegacyNodes.current = waiting === true;
        if (waiting && current.current?.revision !== startedAt)
          setPaintMigrationRetry((value) => value + 1);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setPaintMigrationError(
            `Could not save existing browser colors: ${errorMessage(cause)}`,
          );
      })
      .finally(() => {
        if (migrationController.current === controller)
          migrationController.current = null;
      });
    return () => {
      controller.abort();
      if (migrationController.current === controller)
        migrationController.current = null;
    };
  }, [readyToMigrate, session, paintMigrationRetry, execute]);

  useEffect(() => {
    if (
      readyToMigrate &&
      !paintMigrationError &&
      waitingForLegacyNodes.current &&
      migrationController.current === null
    )
      setPaintMigrationRetry((value) => value + 1);
  }, [graph?.revision, readyToMigrate, paintMigrationError]);

  async function login(token: string) {
    stopSession();
    setError("");
    try {
      await request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setSession((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function logout() {
    stopSession();
    setGraph(null);
    setLayout(null);
    setLastEdit(null);
    setError("");
    setPaintMigrationError("");
    setConnection("locking");
    try {
      await request("/api/session", { method: "DELETE" });
      setSession((value) => value + 1);
    } catch (cause) {
      setConnection("locked");
      setError(
        `The graph is closed in this window, but server sign-out could not be confirmed: ${errorMessage(cause)}`,
      );
    }
  }
  const shown = useMemo(
    () =>
      graph &&
      inFlight.reduce(
        (view, item) => applyOptimistic(view, item.command),
        graph,
      ),
    [graph, inFlight],
  );
  return {
    graph: shown,
    layout,
    connection,
    error,
    notice,
    pending,
    paintMigrationError,
    retryPaintMigration: () => setPaintMigrationRetry((value) => value + 1),
    lastEdit,
    execute,
    login,
    logout,
    setError,
    refresh,
    retry: () => setSession((value) => value + 1),
  };
}

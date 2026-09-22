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

export function useGraph() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [connection, setConnection] = useState<
    "loading" | "live" | "reconnecting" | "offline" | "locked"
  >("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [lastEdit, setLastEdit] = useState<Receipt | null>(null);
  const [session, setSession] = useState(0);
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
  const queue = useRef<
    Array<{ command: Command; resolve: (saved: boolean) => void }>
  >([]);
  const draining = useRef(false);
  const generation = useRef(0);

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
    generation.current++;
    current.current = null;
    setGraph(null);
    setConnection("loading");
    setError("");
    setLayout(null);
    void Promise.all([refresh(), loadLayout()])
      .then(([initial, saved]) => {
        if (stopped) return;
        setLayout(
          new Map(saved.positions.map((point) => [point.id, point] as const)),
        );
        events = new EventSource(`/api/events?after=${initial.revision}`);
        events.onopen = () => setConnection("live");
        events.onerror = () => {
          setConnection("reconnecting");
          // EventSource does not expose HTTP status. A session check makes an
          // expired cookie actionable instead of leaving an infinite spinner.
          void request("/api/session").catch((cause: unknown) => {
            if (
              !stopped &&
              cause instanceof ApiFailure &&
              cause.status === 401
            ) {
              events?.close();
              current.current = null;
              setGraph(null);
              setConnection("locked");
              setError("Your session expired. Unlock the graph to reconnect.");
            }
          });
        };
        events.addEventListener("change", (event) => {
          try {
            decodeReceipt((event as MessageEvent<string>).data);
          } catch {
            setError(
              "Live update could not be read. Reconnect to recover the graph.",
            );
            return;
          }
          void refresh().catch((cause: unknown) => {
            setError(errorMessage(cause));
            if (cause instanceof ApiFailure && cause.status === 401) {
              events?.close();
              setConnection("locked");
              setGraph(null);
            }
          });
        });
      })
      .catch((cause: unknown) => {
        if (stopped) return;
        setConnection(
          cause instanceof ApiFailure && cause.status === 401
            ? "locked"
            : "offline",
        );
        setError(errorMessage(cause));
      });
    return () => {
      stopped = true;
      generation.current++;
      events?.close();
    };
  }, [session, refresh]);

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
    async (command: Command): Promise<boolean> => {
      const wire = (revision: number): Command =>
        command.type === "undo" ? { type: "undo", revision } : command;
      const send = async (revision: number) => {
        const result = await sendCommand(wire(revision), revision);
        setLastEdit(result.receipt);
        await refresh().catch((cause: unknown) =>
          setError(
            `Saved at revision ${result.receipt.revision}, but refreshing the view failed: ${errorMessage(cause)}`,
          ),
        );
        return true;
      };
      const revision = current.current?.revision ?? 0;
      try {
        return await send(revision);
      } catch (cause) {
        if (!(cause instanceof ApiFailure && cause.status === 409)) {
          setError(saveError(cause));
          return false;
        }
      }
      // One conflict pass: reload the latest graph, then retry once against
      // the revision just observed. A second failure surfaces for the caller.
      const latest = await refresh().catch(() => null);
      try {
        return await send(
          latest?.revision ?? current.current?.revision ?? revision,
        );
      } catch (cause) {
        setError(saveError(cause));
        if (cause instanceof ApiFailure && cause.status === 409)
          await refresh().catch(() => {});
        return false;
      }
    },
    [refresh],
  );

  const execute = useCallback(
    (command: Command, _expectedRevision: number) =>
      new Promise<boolean>((resolve) => {
        const key = ++flightKey.current;
        setInFlight((items) => [...items, { key, command }]);
        const land = (saved: boolean) => {
          setInFlight((items) => items.filter((item) => item.key !== key));
          resolve(saved);
        };
        queue.current.push({ command, resolve: land });
        if (draining.current) return;
        draining.current = true;
        setPending(true);
        void (async () => {
          try {
            // Re-check the queue after each drain pass and keep going until
            // it is empty; only then release the drain.
            for (;;) {
              let next:
                | { command: Command; resolve: (saved: boolean) => void }
                | undefined;
              while ((next = queue.current.shift())) {
                setError("");
                setNotice("");
                next.resolve(await attempt(next.command));
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

  async function login(token: string) {
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
    try {
      await request("/api/session", { method: "DELETE" });
      setLastEdit(null);
      setSession((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
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
    lastEdit,
    execute,
    login,
    logout,
    setError,
    refresh,
    retry: () => setSession((value) => value + 1),
  };
}

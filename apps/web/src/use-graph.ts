import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, Graph, Receipt } from "@yakjev/protocol";
import {
  ApiFailure,
  decodeReceipt,
  errorMessage,
  request,
  sendCommand,
  snapshot,
} from "./api";

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
  const current = useRef<Graph | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    const next = await snapshot();
    if (!current.current || next.revision >= current.current.revision) {
      current.current = next;
      setGraph(next);
    }
    return next;
  }, []);

  useEffect(() => {
    let stopped = false;
    let events: EventSource | undefined;
    current.current = null;
    setGraph(null);
    setConnection("loading");
    setError("");
    void refresh()
      .then((initial) => {
        if (stopped) return;
        events = new EventSource(`/api/events?after=${initial.revision}`);
        events.onopen = () => setConnection("live");
        events.onerror = () => setConnection("reconnecting");
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
      events?.close();
    };
  }, [session, refresh]);

  const execute = useCallback(
    async (command: Command, expectedRevision: number) => {
      if (busy.current) return false;
      busy.current = true;
      setPending(true);
      setError("");
      setNotice("");
      try {
        const result = await sendCommand(command, expectedRevision);
        setLastEdit(result.receipt);
        setNotice(`Saved · revision ${result.receipt.revision}`);
        await refresh();
        return true;
      } catch (cause) {
        setError(
          cause instanceof ApiFailure && cause.status === 409
            ? `Not saved: the graph changed. Your draft is kept. Reload latest before trying again. ${cause.message}`
            : `Not saved: ${errorMessage(cause)}`,
        );
        if (cause instanceof ApiFailure && cause.status === 409)
          await refresh().catch(() => {});
        return false;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [refresh],
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
  return {
    graph,
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

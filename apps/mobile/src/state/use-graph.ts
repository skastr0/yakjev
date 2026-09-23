import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import type { YakjevClient } from "@yakjev/client";
import { GraphSession } from "./graph-session";

export function useGraph(client: YakjevClient | null) {
  const session = useMemo(() => new GraphSession(client, randomUUID), [client]);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    if (AppState.currentState === "active") session.start();
    const listener = AppState.addEventListener("change", (next) => {
      if (next === "active") session.start();
      else session.suspend();
    });
    return () => {
      listener.remove();
      session.dispose();
    };
  }, [session]);
  return {
    ...state,
    execute: session.execute,
    retry: session.retry,
    refresh: session.refresh,
    reconnect: session.reconnect,
    savePositions: session.savePositions,
    retryLayout: session.retryLayout,
  };
}

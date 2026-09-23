import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { YakjevClient } from "@yakjev/client";
import type { PreviewRequest } from "@yakjev/protocol";
import { JevPreviewSession, previewKey } from "./jev-preview-session";

export function useJevPreview(
  client: YakjevClient | null,
  input: PreviewRequest | null,
  revision: number,
) {
  const session = useMemo(() => new JevPreviewSession(client), [client]);
  const key = previewKey(input, revision);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    // The serialized value is the dependency, so fresh caller objects do not
    // restart a typing debounce or make network calls each render.
    const request: PreviewRequest | null = JSON.parse(
      key.slice(key.indexOf(":") + 1),
    );
    if (AppState.currentState === "active") session.request(request, revision);
    const listener = AppState.addEventListener("change", (next) => {
      if (next === "active") session.request(request, revision);
      else session.cancel();
    });
    return () => {
      listener.remove();
      session.cancel();
    };
  }, [session, key, revision]);
  useEffect(() => () => session.dispose(), [session]);
  // Effects run after render. Mask the previous answer in that intervening
  // render so create/drop cannot commit a judgment for an older request.
  return state.key === key
    ? {
        preview: state.preview,
        loading: state.loading,
        error: state.error,
      }
    : { preview: null, loading: false, error: null };
}

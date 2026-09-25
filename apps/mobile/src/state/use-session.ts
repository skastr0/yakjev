import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { SERVER_URL } from "./server-url";
import { SessionController } from "./session-storage";

export type { Session } from "./session-storage";

const SESSION_KEY = "yakjev.connection.v1";

export function useSession() {
  const controller = useMemo(
    () =>
      new SessionController(
        {
          get: () => SecureStore.getItemAsync(SESSION_KEY),
          set: (value) =>
            SecureStore.setItemAsync(SESSION_KEY, value, {
              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            }),
          remove: () => SecureStore.deleteItemAsync(SESSION_KEY),
        },
        __DEV__,
        SERVER_URL,
      ),
    [],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.restore();
    return controller.dispose;
  }, [controller]);
  return {
    ...state,
    connect: controller.connect,
    disconnect: controller.disconnect,
  };
}

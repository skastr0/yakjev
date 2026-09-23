import { useCallback, useEffect, useRef, useState } from "react";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { errorMessage } from "@yakjev/client";

type Preferences = {
  paint: Readonly<Record<string, string>>;
  connectWhileDragging: boolean;
};
const empty = (): Preferences => ({ paint: {}, connectWhileDragging: true });

// Display preferences live on this device, scoped to the server. Graph data
// and credentials are never written into this file.
export function usePreferences(server: string) {
  const [value, setValue] = useState<Preferences>(empty);
  const current = useRef(value);
  const file = useRef<File | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setReady(false);
    current.current = empty();
    setValue(current.current);
    file.current = null;
    void (async () => {
      try {
        const id = await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          server,
        );
        const stored = new File(
          Paths.document,
          `yakjev-preferences-${id}.json`,
        );
        const decoded: unknown = stored.exists
          ? JSON.parse(await stored.text())
          : null;
        if (!active) return;
        file.current = stored;
        const next = parsePreferences(decoded);
        current.current = next;
        setValue(next);
      } catch (cause) {
        if (active)
          setError(
            `Could not read display preferences: ${errorMessage(cause)}`,
          );
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
      file.current = null;
    };
  }, [server]);

  const update = useCallback((patch: Partial<Preferences>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setValue(next);
    try {
      if (!file.current) throw new Error("Display storage is unavailable.");
      if (!file.current.exists) file.current.create();
      file.current.write(JSON.stringify(next));
      setError(null);
    } catch (cause) {
      setError(`Display changes are temporary: ${errorMessage(cause)}`);
    }
  }, []);

  return {
    ...value,
    ready,
    error,
    paintNode: useCallback(
      (id: string, hex: string) => {
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
        update({ paint: { ...current.current.paint, [id]: hex } });
      },
      [update],
    ),
    setConnectWhileDragging: useCallback(
      (enabled: boolean) => update({ connectWhileDragging: enabled }),
      [update],
    ),
  };
}

function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object") return empty();
  const data = value as Record<string, unknown>;
  const paint =
    data.paint && typeof data.paint === "object"
      ? Object.fromEntries(
          Object.entries(data.paint).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" &&
              /^#[0-9a-fA-F]{6}$/.test(entry[1]),
          ),
        )
      : {};
  return { paint, connectWhileDragging: data.connectWhileDragging !== false };
}

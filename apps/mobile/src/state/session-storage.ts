import { normalizeServerUrl } from "@yakjev/client";

export type Session = { baseUrl: string; token: string };

export interface SessionStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

export function validateSession(
  endpoint: string,
  token: string,
  development = false,
): Session {
  let baseUrl: string;
  try {
    baseUrl = normalizeServerUrl(endpoint);
  } catch {
    throw new Error(
      "Enter an HTTPS server origin, without credentials, a path, or query. Development builds also allow HTTP on localhost.",
    );
  }
  if (!development && new URL(baseUrl).protocol !== "https:")
    throw new Error("Use HTTPS to connect to your Yakjev server.");
  const cleanToken = token.trim();
  if (!cleanToken || /[\r\n]/.test(cleanToken))
    throw new Error("Enter a valid owner token.");
  return { baseUrl, token: cleanToken };
}

export function decodeSession(value: string, development = false): Session {
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("baseUrl" in parsed) ||
    !("token" in parsed) ||
    typeof parsed.baseUrl !== "string" ||
    typeof parsed.token !== "string"
  )
    throw new Error("Saved connection could not be read. Connect again.");
  return validateSession(parsed.baseUrl, parsed.token, development);
}

// Serializing secure-storage mutations prevents an older connect from writing
// credentials back after lock. Generation guards also isolate delayed restores.
export class SessionController {
  private generation = 0;
  private writes = Promise.resolve();
  private state: {
    session: Session | null;
    loading: boolean;
    error: string | null;
  } = {
    session: null,
    loading: true,
    error: null,
  };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: SessionStorage,
    private readonly development = false,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: typeof this.state) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private mutate(operation: () => Promise<void>) {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }

  restore = async () => {
    const generation = ++this.generation;
    try {
      const saved = await this.storage.get();
      if (generation !== this.generation) return;
      this.update({
        session: saved ? decodeSession(saved, this.development) : null,
        loading: false,
        error: null,
      });
    } catch (cause) {
      if (generation === this.generation)
        this.update({
          session: null,
          loading: false,
          error:
            cause instanceof Error
              ? cause.message
              : "Saved connection could not be read.",
        });
    }
  };

  connect = async (endpoint: string, token: string): Promise<boolean> => {
    const generation = ++this.generation;
    this.update({ session: null, loading: true, error: null });
    try {
      const session = validateSession(endpoint, token, this.development);
      await this.mutate(() => this.storage.set(JSON.stringify(session)));
      if (generation !== this.generation) return false;
      this.update({ session, loading: false, error: null });
      return true;
    } catch (cause) {
      if (generation === this.generation)
        this.update({
          session: null,
          loading: false,
          error:
            cause instanceof Error
              ? cause.message
              : "Connection could not be saved.",
        });
      return false;
    }
  };

  disconnect = async () => {
    const generation = ++this.generation;
    this.update({ session: null, loading: false, error: null });
    try {
      await this.mutate(() => this.storage.remove());
    } catch {
      if (generation === this.generation)
        this.update({
          session: null,
          loading: false,
          error:
            "Locked, but saved credentials could not be removed. Lock again to retry.",
        });
    }
  };

  dispose = () => {
    this.generation++;
    this.listeners.clear();
  };
}

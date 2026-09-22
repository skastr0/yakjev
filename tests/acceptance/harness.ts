// Black-box acceptance harness. Owned by the product/E2E reviewer.
//
// The server is the real entrypoint (`packages/server/src/main.ts`) started as a
// child process against a disposable SQLite directory. Tests observe only the
// HTTP/SSE surface: never owner internals, never a second store.
import { spawn, type Subprocess } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const serverEntry = "packages/server/src/main.ts";

/**
 * Synthetic owner token for the disposable acceptance server. Not a secret and
 * never used against a deployed instance; the harness passes a minimal
 * environment so no real credential can leak into this run.
 */
export const acceptanceToken = "acceptance-owner-token-0123456789abcdef";

export type GraphEvent = {
  /** SSE `id:` field, which the contract defines as the graph revision. */
  readonly id: number | undefined;
  readonly event: string | undefined;
  readonly data: unknown;
};

export type ServerHandle = {
  readonly origin: string;
  readonly port: number;
  readonly dataDir: string;
  readonly logs: () => string;
  /** Authenticated request against the running server. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Request with no credentials, for fail-closed checks. */
  fetchAnonymous(path: string, init?: RequestInit): Promise<Response>;
  /** Authenticated request that must succeed, decoded as JSON. */
  json<T>(path: string, init?: RequestInit): Promise<T>;
  /** Open a durable SSE stream, optionally replaying after a revision. */
  events(options?: { after?: number }): Promise<EventStream>;
  /** Stop and start again on the same port and data directory. */
  restart(): Promise<void>;
  /** Stop the server and delete its disposable data directory. */
  stop(): Promise<void>;
};

export class EventStream {
  readonly events: GraphEvent[] = [];
  readonly url: string;
  #error: unknown = undefined;
  #controller = new AbortController();
  #waiters = new Set<() => void>();
  #closed = false;

  constructor(url: string) {
    this.url = url;
  }

  get error(): unknown {
    return this.#error;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Abort signal for the underlying request; aborted by `close()`. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  push(event: GraphEvent): void {
    this.events.push(event);
    for (const notify of this.#waiters) notify();
    this.#waiters.clear();
  }

  fail(error: unknown): void {
    this.#error = error;
    for (const notify of this.#waiters) notify();
    this.#waiters.clear();
  }

  close(): void {
    this.#closed = true;
    this.#controller.abort();
    for (const notify of this.#waiters) notify();
    this.#waiters.clear();
  }

  #wake(): Promise<void> {
    return new Promise((resolveWake) => {
      const notify = () => resolveWake();
      this.#waiters.add(notify);
      setTimeout(() => {
        this.#waiters.delete(notify);
        resolveWake();
      }, 100);
    });
  }

  /** Wait until a received event matches, or fail loudly on timeout. */
  async waitFor(
    predicate: (event: GraphEvent) => boolean,
    options: { timeoutMs?: number; description?: string } = {},
  ): Promise<GraphEvent> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.events.find(predicate);
      if (match) return match;
      if (this.#error !== undefined) {
        throw new Error(
          `SSE stream ${this.url} failed: ${String(this.#error)}\n${JSON.stringify(this.events)}`,
        );
      }
      if (this.#closed) {
        throw new Error(
          `SSE stream ${this.url} closed before ${options.description ?? "matching event"}; saw ${JSON.stringify(this.events)}`,
        );
      }
      await this.#wake();
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for ${options.description ?? "matching event"} on ${this.url}; saw ${JSON.stringify(this.events)}`,
    );
  }

  /** Wait until an event reports the given revision. */
  waitForRevision(revision: number, timeoutMs = 5_000): Promise<GraphEvent> {
    return this.waitFor(
      (event) => event.id === revision || revisionOf(event.data) === revision,
      { timeoutMs, description: `revision ${revision}` },
    );
  }
}

/** Best-effort revision extraction from a receipt payload. */
export function revisionOf(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const candidate = (data as { revision?: unknown }).revision;
  return typeof candidate === "number" ? candidate : undefined;
}

export function nodeIds(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const nodes = (data as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) =>
      typeof node === "object" && node !== null
        ? (node as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

export function edgeKeys(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const edges = (data as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return [];
  return edges
    .map((edge) => {
      if (typeof edge !== "object" || edge === null) return undefined;
      const record = edge as { source?: unknown; target?: unknown };
      if (
        typeof record.source !== "string" ||
        typeof record.target !== "string"
      )
        return undefined;
      return `${record.source}->${record.target}`;
    })
    .filter((key): key is string => key !== undefined);
}

async function pickPort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("could not reserve a probe port");
  return port;
}

function startChild(
  port: number,
  dataDir: string,
  token: string,
  extraEnv: Record<string, string> = {},
): Subprocess {
  return spawn({
    cmd: ["bun", serverEntry],
    cwd: repoRoot,
    // Deliberately minimal environment: no Railway, Tailscale, Amp, or provider
    // credentials can leak into the disposable acceptance run.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      YAKJEV_LISTEN_PORT: String(port),
      YAKJEV_DATA_DIR: dataDir,
      YAKJEV_OWNER_TOKEN: token,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function collect(stream: ReadableStream<Uint8Array> | undefined): () => string {
  let text = "";
  if (!stream) return () => text;
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of stream) text += decoder.decode(chunk);
    } catch {
      // Stream ends when the child exits; the captured text is what matters.
    }
  })();
  return () => text;
}

async function waitForReady(
  origin: string,
  child: Subprocess,
  logs: () => string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited early with code ${child.exitCode}\n${logs()}`,
      );
    }
    try {
      const response = await fetch(`${origin}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `server did not answer /healthz within ${timeoutMs}ms\n${logs()}`,
  );
}

async function stopChild(child: Subprocess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

export async function startServer(
  options: {
    dataDir?: string;
    port?: number;
    env?: Record<string, string>;
    /** Bearer token for this run; defaults to the synthetic acceptance token. */
    token?: string;
  } = {},
): Promise<ServerHandle> {
  const token = options.token ?? acceptanceToken;
  const dataDir =
    options.dataDir ?? (await mkdtemp(join(tmpdir(), "yakjev-acceptance-")));
  const port = options.port ?? (await pickPort());
  const origin = `http://127.0.0.1:${port}`;
  const extraEnv = options.env ?? {};
  let child = startChild(port, dataDir, token, extraEnv);
  let stdout = collect(child.stdout as ReadableStream<Uint8Array>);
  let stderr = collect(child.stderr as ReadableStream<Uint8Array>);
  const logs = () => `${stdout()}\n${stderr()}`.trim();
  try {
    await waitForReady(origin, child, logs);
  } catch (error) {
    // A failed startup must not leak the child process or its disposable
    // directory: the caller never receives a handle it could stop.
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  const handle: ServerHandle = {
    origin,
    port,
    dataDir,
    logs,
    async fetch(path, init) {
      const headers = new Headers(init?.headers);
      headers.set("accept", headers.get("accept") ?? "application/json");
      // Never overwrite a caller-supplied credential: tests must be able to send
      // a wrong or missing one and observe the server's answer.
      if (!headers.has("authorization")) {
        headers.set("authorization", `Bearer ${token}`);
      }
      return fetch(`${origin}${path}`, { ...init, headers });
    },
    async fetchAnonymous(path, init) {
      const headers = new Headers(init?.headers);
      headers.set("accept", headers.get("accept") ?? "application/json");
      return fetch(`${origin}${path}`, { ...init, headers });
    },
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await handle.fetch(path, init);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `${init?.method ?? "GET"} ${path} -> ${response.status} ${response.statusText}\n${text}`,
        );
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`${path} did not return JSON:\n${text}`);
      }
    },
    async events(eventOptions = {}) {
      const query =
        eventOptions.after === undefined ? "" : `?after=${eventOptions.after}`;
      const url = `${origin}/api/events${query}`;
      const stream = new EventStream(url);
      const response = await fetch(url, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${token}`,
        },
        signal: stream.signal,
      });
      if (!response.ok) {
        stream.fail(
          new Error(`GET ${url} -> ${response.status} ${response.statusText}`),
        );
        return stream;
      }
      const body = response.body;
      if (!body) {
        stream.fail(new Error(`GET ${url} returned no body`));
        return stream;
      }
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for await (const chunk of body) {
            buffer += decoder.decode(chunk, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              stream.push(parseFrame(frame));
              boundary = buffer.indexOf("\n\n");
            }
          }
        } catch (error) {
          stream.fail(error);
        }
      })();
      return stream;
    },
    async restart() {
      await stopChild(child);
      child = startChild(port, dataDir, token, extraEnv);
      stdout = collect(child.stdout as ReadableStream<Uint8Array>);
      stderr = collect(child.stderr as ReadableStream<Uint8Array>);
      try {
        await waitForReady(origin, child, logs);
      } catch (error) {
        // Keep the data directory: the caller may still want to inspect the
        // graph it was verifying. Only the failed child is cleaned up.
        await stopChild(child);
        throw error;
      }
    },
    async stop() {
      await stopChild(child);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return handle;
}

function parseFrame(frame: string): GraphEvent {
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).trimStart();
    if (field === "id") {
      const parsed = Number(value);
      id = Number.isInteger(parsed) ? parsed : undefined;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  if (raw !== "") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  return { id, event, data };
}

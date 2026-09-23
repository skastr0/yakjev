import {
  ApiFailure,
  createEventParser,
  decodeReceipt,
  errorMessage,
  type YakjevClient,
} from "@yakjev/client";
import {
  LAYOUT_BATCH_MAX,
  type Command,
  type Graph,
  type LayoutPoint,
  type Receipt,
} from "@yakjev/protocol";

export type GraphConnection =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "locked";
export type GraphState = {
  graph: Graph | null;
  positions: readonly LayoutPoint[];
  connection: GraphConnection;
  pending: number;
  layoutPending: boolean;
  failedWrite: boolean;
  error: string | null;
  notice: string | null;
  lastEdit: Receipt | null;
};
type Attempt = {
  command: Command;
  expectedRevision: number;
  requestId: string;
};
type QueuedWrite = {
  attempt: Attempt;
  resolve: (saved: boolean) => void;
  confirmed: boolean;
};

const initialState = (): GraphState => ({
  graph: null,
  positions: [],
  connection: "locked",
  pending: 0,
  layoutPending: false,
  failedWrite: false,
  error: null,
  notice: null,
  lastEdit: null,
});

/** A session owns every request and callback. It never stores a second graph database. */
export class GraphSession {
  private state = initialState();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private scope: AbortController | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private layoutPromise: Promise<boolean> | null = null;
  private layoutLoaded = false;
  private readonly dirtyPositions = new Map<string, LayoutPoint>();
  private queue: QueuedWrite[] = [];
  private sending: QueuedWrite | null = null;
  private failedAttempt: Attempt | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;

  constructor(
    private readonly client: YakjevClient | null,
    private readonly randomUUID: () => string,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<GraphState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private current(generation: number) {
    return this.active && this.generation === generation;
  }
  private clearTimer() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  start = () => {
    if (this.active || !this.client) return;
    this.active = true;
    this.scope = new AbortController();
    const generation = ++this.generation;
    this.update({
      connection: this.state.graph ? "reconnecting" : "connecting",
    });
    void this.boot(generation);
  };

  private async boot(generation: number) {
    if (!this.client || !this.scope) return;
    const signal = this.scope.signal;
    try {
      await Promise.all([
        this.refresh(),
        this.layoutLoaded
          ? Promise.resolve()
          : this.client.layout(signal).then((saved) => {
              if (!this.current(generation)) return;
              this.layoutLoaded = true;
              const positions = new Map(
                saved.positions.map((point) => [point.id, point]),
              );
              for (const [id, point] of this.dirtyPositions)
                positions.set(id, point);
              this.update({ positions: [...positions.values()] });
            }),
      ]);
      if (!this.current(generation)) return;
      await this.readEvents(generation, signal);
    } catch (cause) {
      if (!this.current(generation)) return;
      if (this.unauthorized(cause)) return;
      this.update({
        connection: this.state.graph ? "reconnecting" : "offline",
        error: errorMessage(cause),
      });
      this.scheduleReconnect();
    }
  }

  private async readEvents(generation: number, signal: AbortSignal) {
    const stream = new AbortController();
    const abort = () => stream.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) stream.abort();
    try {
      await this.consumeEvents(generation, stream);
    } finally {
      signal.removeEventListener("abort", abort);
      stream.abort();
    }
  }

  private async consumeEvents(generation: number, stream: AbortController) {
    if (!this.client) return;
    const signal = stream.signal;
    const response = await this.client.events({
      after: this.state.graph?.revision ?? 0,
      signal,
    });
    if (!this.current(generation)) {
      await response.body?.cancel();
      return;
    }
    if (!response.body)
      throw new Error(
        "Live updates are unavailable. Reconnect to refresh the graph.",
      );
    const openedAt = Date.now();
    this.update({
      connection: "live",
      ...(!this.failedAttempt && !this.dirtyPositions.size
        ? { error: null }
        : {}),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createEventParser((event) => {
      if (!this.current(generation) || event.event !== "change") return;
      const receipt = decodeReceipt(event.data);
      if (receipt.revision > (this.state.graph?.revision ?? -1))
        void this.refresh().catch((cause: unknown) => {
          if (this.current(generation) && !this.unauthorized(cause)) {
            this.update({
              connection: "reconnecting",
              error: errorMessage(cause),
            });
            // Reopening starts with a fresh snapshot. A failed event refresh
            // must recover even when the server sends no further changes.
            stream.abort();
          }
        });
    });
    try {
      while (this.current(generation)) {
        const chunk = await reader.read();
        if (!this.current(generation)) return;
        if (chunk.done) break;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.end();
      if (this.current(generation))
        throw new Error("Live connection interrupted. Reconnecting…");
    } finally {
      // An HTTP 200 that immediately closes is still a failed connection.
      if (Date.now() - openedAt >= 10_000) this.retryCount = 0;
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private scheduleReconnect() {
    if (!this.active || this.retryTimer) return;
    const delay = Math.min(30_000, 800 * 2 ** Math.min(this.retryCount++, 6));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active) void this.boot(this.generation);
    }, delay);
  }

  refresh = (): Promise<void> => {
    if (!this.client || !this.active || !this.scope) return Promise.resolve();
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }
    const generation = this.generation;
    const signal = this.scope.signal;
    const client = this.client;
    const result = (async () => {
      do {
        this.refreshAgain = false;
        const graph = await client.snapshot(signal);
        if (!this.current(generation)) return;
        if (!this.state.graph || graph.revision >= this.state.graph.revision)
          this.update({ graph });
      } while (this.refreshAgain && this.current(generation));
    })();
    this.refreshPromise = result;
    void result
      .finally(() => {
        if (this.refreshPromise === result) this.refreshPromise = null;
      })
      .catch(() => {});
    return result;
  };

  execute = (command: Command): Promise<boolean> => {
    if (
      !this.active ||
      !this.client ||
      !this.state.graph ||
      this.state.connection === "locked"
    )
      return Promise.resolve(false);
    if (this.failedAttempt) {
      this.update({
        error:
          "The previous save is unconfirmed. Retry that save before making another edit.",
      });
      return Promise.resolve(false);
    }
    return this.enqueue({
      command,
      expectedRevision: this.state.graph.revision,
      requestId: this.randomUUID(),
    });
  };

  retry = (): Promise<boolean> => {
    if (!this.active || !this.failedAttempt || this.sending)
      return Promise.resolve(false);
    const attempt = this.failedAttempt;
    this.failedAttempt = null;
    this.update({ failedWrite: false });
    return this.enqueue(attempt);
  };

  private enqueue(attempt: Attempt) {
    return new Promise<boolean>((resolve) => {
      this.queue.push({ attempt, resolve, confirmed: false });
      this.update({
        pending: this.queue.length + (this.sending ? 1 : 0),
        error: null,
        notice: null,
      });
      void this.drain(this.generation);
    });
  }

  private async drain(generation: number) {
    if (
      this.sending ||
      !this.client ||
      !this.scope ||
      !this.current(generation)
    )
      return;
    const next = this.queue.shift();
    if (!next) return;
    this.sending = next;
    const { command, expectedRevision, requestId } = next.attempt;
    try {
      const result = await this.client.sendCommand(
        command,
        expectedRevision,
        requestId,
        this.scope.signal,
      );
      if (!this.current(generation)) return;
      next.confirmed = true;
      this.update({
        lastEdit: result.receipt,
        notice: `Saved at revision ${result.receipt.revision}.`,
        failedWrite: false,
      });
      await this.refresh().catch((cause: unknown) => {
        if (this.current(generation) && !this.unauthorized(cause))
          this.update({
            error: `Saved, but refreshing failed: ${errorMessage(cause)}`,
          });
      });
      if (this.current(generation)) next.resolve(true);
    } catch (cause) {
      if (!this.current(generation)) return;
      if (this.unauthorized(cause)) return;
      const definitive =
        cause instanceof ApiFailure &&
        cause.status >= 400 &&
        cause.status < 500;
      if (!definitive) this.failedAttempt = next.attempt;
      this.update({
        failedWrite: !definitive,
        error:
          cause instanceof ApiFailure && cause.status === 409
            ? "The graph changed. Your draft is kept. Review the latest graph before saving again."
            : definitive
              ? `Not saved: ${errorMessage(cause)}`
              : `Save is unconfirmed. Retry uses the same request so it cannot create a duplicate. ${errorMessage(cause)}`,
      });
      // Queued drafts were authored before this failure; none are rebased or sent.
      for (const queued of this.queue.splice(0)) queued.resolve(false);
      if (cause instanceof ApiFailure && cause.status === 409)
        await this.refresh().catch(() => {});
      next.resolve(false);
    } finally {
      if (this.sending === next) {
        this.sending = null;
        this.update({ pending: this.queue.length });
        if (this.current(generation)) void this.drain(generation);
      }
    }
  }

  savePositions = (points: readonly LayoutPoint[]): Promise<boolean> => {
    if (!this.client || this.state.connection === "locked")
      return Promise.resolve(false);
    const positions = new Map(
      this.state.positions.map((point) => [point.id, point]),
    );
    for (const point of points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      this.dirtyPositions.set(point.id, point);
      positions.set(point.id, point);
    }
    this.update({
      positions: [...positions.values()],
      layoutPending: this.dirtyPositions.size > 0,
    });
    return this.retryLayout();
  };

  retryLayout = (): Promise<boolean> => {
    if (this.layoutPromise) return this.layoutPromise;
    if (!this.active || !this.client || !this.scope)
      return Promise.resolve(false);
    const generation = this.generation;
    const signal = this.scope.signal;
    const client = this.client;
    const result = (async () => {
      try {
        while (this.dirtyPositions.size && this.current(generation)) {
          const batch = [...this.dirtyPositions.values()].slice(
            0,
            LAYOUT_BATCH_MAX,
          );
          await client.saveLayout(batch, signal);
          if (!this.current(generation)) return false;
          for (const point of batch)
            if (this.dirtyPositions.get(point.id) === point)
              this.dirtyPositions.delete(point.id);
          this.update({ layoutPending: this.dirtyPositions.size > 0 });
        }
        if (
          this.current(generation) &&
          this.state.error?.startsWith("Positions have not been saved.")
        )
          this.update({ error: null });
        return this.current(generation);
      } catch (cause) {
        if (this.current(generation) && !this.unauthorized(cause))
          this.update({
            error: `Positions have not been saved. Retry when connected. ${errorMessage(cause)}`,
            layoutPending: true,
          });
        return false;
      }
    })();
    this.layoutPromise = result;
    void result.finally(() => {
      if (this.layoutPromise === result) this.layoutPromise = null;
    });
    return result;
  };

  private unauthorized(cause: unknown) {
    if (
      !(
        cause instanceof ApiFailure &&
        (cause.status === 401 || cause.status === 403)
      )
    )
      return false;
    this.stop(false);
    this.failedAttempt = null;
    this.dirtyPositions.clear();
    this.layoutLoaded = false;
    this.state = initialState();
    this.update({
      error: "Your token was refused. Lock the app and connect again.",
    });
    return true;
  }

  private stop(preserveAttempt: boolean) {
    this.active = false;
    this.generation++;
    this.clearTimer();
    this.scope?.abort();
    this.scope = null;
    this.refreshPromise = null;
    this.layoutPromise = null;
    this.refreshAgain = false;
    if (this.sending) {
      if (preserveAttempt && !this.sending.confirmed)
        this.failedAttempt = this.sending.attempt;
      this.sending.resolve(this.sending.confirmed);
      this.sending = null;
    }
    for (const queued of this.queue.splice(0)) queued.resolve(false);
    this.update({ pending: 0, failedWrite: this.failedAttempt !== null });
  }

  suspend = () => {
    this.stop(true);
    if (this.state.connection !== "locked")
      this.update({
        connection: "offline",
        ...(this.failedAttempt
          ? {
              error:
                "Save was interrupted. Retry to confirm it without creating a duplicate.",
            }
          : {}),
      });
  };

  reconnect = () => {
    if (this.state.connection === "locked") return;
    this.suspend();
    this.retryCount = 0;
    this.start();
  };

  dispose = () => {
    this.stop(false);
    this.failedAttempt = null;
    this.dirtyPositions.clear();
    this.layoutLoaded = false;
    this.retryCount = 0;
    this.state = initialState();
    this.listeners.clear();
  };
}

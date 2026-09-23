import { Schema } from "effect";
import {
  CommandRequest,
  CommandResult,
  Graph,
  HistoryEntry,
  Id,
  JevCalls,
  Layout,
  LayoutSave,
  Neighborhood,
  Preview,
  PreviewRequest,
  Receipt,
  Revision,
  type Command,
  type LayoutPoint,
} from "@yakjev/protocol";
import { randomUUID, type RandomUUID } from "./id";

export class ApiFailure extends Error {
  override readonly name = "ApiFailure";

  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly currentRevision?: number,
  ) {
    super(message);
  }
}

// Only the standard response surface consumed here. Requiring Response itself
// would pull Bun-only extensions into Expo callers when workspace types merge.
export type ClientResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Pick<Headers, "get">;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
};

export type ClientOptions = {
  baseUrl: string;
  token?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<ClientResponse>;
  randomUUID?: RandomUUID;
};

export type Direction = "outgoing" | "incoming" | "both";

// Tokens travel only to the configured origin, over TLS or loopback during
// development. Redirects are rejected before a credential can follow them.
export function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "Use an HTTPS server URL, or HTTP on localhost for development.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use the server origin without a path, query, or credentials.",
    );
  }
  return url.origin;
}

async function checkResponse(
  response: ClientResponse,
): Promise<ClientResponse> {
  if (response.ok) return response;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // A proxy may return HTML; the status still explains the failure.
  }
  throw new ApiFailure(
    response.status,
    typeof body.message === "string"
      ? body.message
      : `Request failed (${response.status})`,
    typeof body.error === "string" ? body.error : undefined,
    typeof body.currentRevision === "number" ? body.currentRevision : undefined,
  );
}

export function createClient(options: ClientOptions) {
  const baseUrl = normalizeServerUrl(options.baseUrl);
  const token = options.token?.trim();
  if (options.token !== undefined && (!token || /[\r\n]/.test(token))) {
    throw new Error("Enter a valid owner token.");
  }
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const newId = options.randomUUID ?? randomUUID;

  const response = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return checkResponse(
      await fetchRequest(`${baseUrl}${path}`, {
        ...init,
        headers,
        credentials: token ? "omit" : "same-origin",
        redirect: "error",
      }),
    );
  };
  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    const result = await response(path, init);
    return result.status === 204 ? null : result.json();
  };
  const get = (path: string, signal?: AbortSignal) =>
    request(path, signal ? { signal } : undefined);
  const json = (
    method: "POST" | "PUT",
    body: unknown,
    signal?: AbortSignal,
  ): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  return {
    snapshot: async (signal?: AbortSignal) =>
      Schema.decodeUnknownSync(Graph)(await get("/api/graph", signal)),
    layout: async (signal?: AbortSignal) =>
      Schema.decodeUnknownSync(Layout)(await get("/api/layout", signal)),
    history: async (after = 0, signal?: AbortSignal) => {
      Schema.decodeUnknownSync(Revision)(after);
      return Schema.decodeUnknownSync(Schema.Array(HistoryEntry))(
        await get(`/api/history?after=${after}`, signal),
      );
    },
    neighborhood: async (
      id: string,
      direction: Direction = "both",
      blocking = false,
      signal?: AbortSignal,
    ) => {
      Schema.decodeUnknownSync(Id)(id);
      Schema.decodeUnknownSync(
        Schema.Literals(["outgoing", "incoming", "both"]),
      )(direction);
      return Schema.decodeUnknownSync(Neighborhood)(
        await get(
          `/api/neighborhood?id=${encodeURIComponent(id)}&direction=${direction}&blocking=${blocking}`,
          signal,
        ),
      );
    },
    preview: async (input: PreviewRequest, signal?: AbortSignal) =>
      Schema.decodeUnknownSync(Preview)(
        await request(
          "/api/jev/preview",
          json("POST", Schema.decodeUnknownSync(PreviewRequest)(input), signal),
        ),
      ),
    saveLayout: async (
      positions: readonly LayoutPoint[],
      signal?: AbortSignal,
    ) =>
      Schema.decodeUnknownSync(Schema.Struct({ saved: Revision }))(
        await request(
          "/api/layout",
          json(
            "PUT",
            Schema.decodeUnknownSync(LayoutSave)({ positions }),
            signal,
          ),
        ),
      ),
    // Retain requestId with the pending command and reuse it if the response is
    // lost. The server, not the client, owns replay and revision enforcement.
    sendCommand: async (
      command: Command,
      expectedRevision: number,
      requestId = newId(),
      signal?: AbortSignal,
    ) =>
      Schema.decodeUnknownSync(CommandResult)(
        await request(
          "/api/commands",
          json(
            "POST",
            Schema.decodeUnknownSync(CommandRequest)({
              requestId,
              expectedRevision,
              command,
            }),
            signal,
          ),
        ),
      ),
    jevCalls: async (signal?: AbortSignal) =>
      Schema.decodeUnknownSync(JevCalls)(await get("/api/jev/calls", signal)),
    exportGraph: async (signal?: AbortSignal) =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          graph: Graph,
          history: Schema.Array(HistoryEntry),
          layout: Layout,
        }),
      )(await get("/api/export", signal)),
    // Inject expo/fetch to consume Response.body on native. The same bearer
    // boundary and failure decoding apply before handing the stream to the UI.
    events: async ({
      after = 0,
      signal,
    }: { after?: number; signal?: AbortSignal } = {}) => {
      Schema.decodeUnknownSync(Revision)(after);
      return response(`/api/events?after=${after}`, {
        headers: { Accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
    },
  };
}

export type YakjevClient = ReturnType<typeof createClient>;

export const decodeReceipt = (data: string) =>
  Schema.decodeUnknownSync(Receipt)(JSON.parse(data));

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred";

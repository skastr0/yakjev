import { Schema } from "effect";
import {
  CommandResult,
  Graph,
  HistoryEntry,
  JevCalls,
  Layout,
  type LayoutPoint,
  Neighborhood,
  Preview,
  Receipt,
  type Command,
  type PreviewRequest,
} from "@yakjev/protocol";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
      )
        message = body.message;
    } catch {
      /* HTTP status is still actionable if a proxy returns HTML. */
    }
    throw new ApiFailure(response.status, message);
  }
  return response.status === 204 ? null : response.json();
}

export const snapshot = async () =>
  Schema.decodeUnknownSync(Graph)(await request("/api/graph"));
export const history = async () =>
  Schema.decodeUnknownSync(Schema.Array(HistoryEntry))(
    await request("/api/history?after=0"),
  );
export const neighborhood = async (
  id: string,
  direction: string,
  blocking: boolean,
) =>
  Schema.decodeUnknownSync(Neighborhood)(
    await request(
      `/api/neighborhood?id=${encodeURIComponent(id)}&direction=${direction}&blocking=${blocking}`,
    ),
  );
export const decodeReceipt = (data: string) =>
  Schema.decodeUnknownSync(Receipt)(JSON.parse(data));

export async function sendCommand(
  command: Command,
  expectedRevision: number,
  signal?: AbortSignal,
) {
  return Schema.decodeUnknownSync(CommandResult)(
    await request("/api/commands", {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        expectedRevision,
        command,
      }),
    }),
  );
}

// Ephemeral Jev judgments against the live graph. Nothing is saved. Abort
// stale calls with the signal; an unavailable provider returns no judgments.
export async function previewJev(input: PreviewRequest, signal?: AbortSignal) {
  return Schema.decodeUnknownSync(Preview)(
    await request("/api/jev/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    }),
  );
}

// Canvas positions live outside the journal: saving creates no revision.
export const layout = async () =>
  Schema.decodeUnknownSync(Layout)(await request("/api/layout"));
export const saveLayout = async (positions: readonly LayoutPoint[]) =>
  request("/api/layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions }),
  });

export const jevCalls = async () =>
  Schema.decodeUnknownSync(JevCalls)(await request("/api/jev/calls"));

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred";

// Minimal MCP client over streamable HTTP, for parity checks only. It speaks the
// same JSON-RPC surface an authorized agent uses; it never bypasses auth.
import type { ServerHandle } from "./harness";

export type JsonRpcReply = {
  readonly status: number;
  readonly session: string | null;
  readonly payload: unknown;
};

type RpcBody = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
};

function parseMaybeSse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  const last = dataLines.at(-1);
  if (last === undefined) return trimmed;
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
}

export async function rpc(
  server: ServerHandle,
  body: RpcBody,
  options: { session?: string; anonymous?: boolean } = {},
): Promise<JsonRpcReply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (options.session !== undefined) {
    headers["mcp-session-id"] = options.session;
    headers["mcp-protocol-version"] = "2025-06-18";
  }
  const request = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
  const response = options.anonymous
    ? await server.fetchAnonymous("/mcp", request)
    : await server.fetch("/mcp", request);
  const text = await response.text();
  return {
    status: response.status,
    session: response.headers.get("mcp-session-id"),
    payload: parseMaybeSse(text),
  };
}

export async function openSession(server: ServerHandle): Promise<string> {
  const initialized = await rpc(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "yakjev-acceptance", version: "1" },
    },
  });
  if (initialized.status !== 200 || !initialized.session) {
    throw new Error(
      `MCP initialize failed: ${initialized.status} ${JSON.stringify(initialized.payload).slice(0, 200)}`,
    );
  }
  return initialized.session;
}

export type ToolCallResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly { type: string; text?: string }[];
};

export async function callTool(
  server: ServerHandle,
  session: string,
  name: string,
  args: unknown,
  id = 2,
): Promise<ToolCallResult> {
  const reply = await rpc(
    server,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { session },
  );
  const payload = reply.payload as {
    result?: ToolCallResult;
    error?: { message?: string };
  };
  if (reply.status !== 200) {
    throw new Error(
      `tools/call ${name} -> ${reply.status} ${JSON.stringify(payload).slice(0, 240)}`,
    );
  }
  if (payload.error) {
    throw new Error(
      `tools/call ${name} returned a JSON-RPC error: ${payload.error.message}`,
    );
  }
  return payload.result ?? {};
}

export async function listTools(
  server: ServerHandle,
  session: string,
): Promise<string[]> {
  const reply = await rpc(
    server,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { session },
  );
  const payload = reply.payload as {
    result?: { tools?: { name?: string }[] };
  };
  return (payload.result?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");
}

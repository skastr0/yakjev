// The only place acceptance tests encode the wire contract.
//
// The types are imported from the published protocol package rather than copied:
// a black-box test may depend on the public contract, and deriving them here
// means this file cannot silently drift from the schema it asserts. The payload
// builders and the independently written assertions live in the tests.
import * as protocol from "../../packages/protocol/src/index.ts";
import type { ServerHandle } from "./harness";

export type Id = typeof protocol.Id.Type;
export type Revision = typeof protocol.Revision.Type;
export type Source = typeof protocol.Source.Type;
export type Actor = protocol.Actor;
export type Provenance = typeof protocol.Provenance.Type;
export type Position = typeof protocol.Position.Type;
export type NodeInput = typeof protocol.NodeInput.Type;
export type GraphNode = protocol.Node;
export type Relation = typeof protocol.Relation.Type;
export type Taxonomy = protocol.Taxonomy;
export type EdgeInput = typeof protocol.EdgeInput.Type;
export type GraphEdge = protocol.Edge;
export type Capture = typeof protocol.Capture.Type;
export type CaptureInput = typeof protocol.CaptureInput.Type;
export type SuggestionInput = protocol.SuggestionInput;
export type Suggestion = typeof protocol.Suggestion.Type;
export type GraphSnapshot = protocol.Graph;
export type Command = protocol.Command;
export type CommandRequest = protocol.CommandRequest;
export type Receipt = protocol.Receipt;
export type CommandResult = protocol.CommandResult;
export type HistoryEntry = protocol.HistoryEntry;
export type Neighborhood = protocol.Neighborhood;
export type ApiError = typeof protocol.ApiError.Type;

export type Failure = { readonly status: number; readonly body: unknown };

export async function readGraph(server: ServerHandle): Promise<GraphSnapshot> {
  return server.json<GraphSnapshot>("/api/graph");
}

export async function sendCommand(
  server: ServerHandle,
  expectedRevision: Revision,
  command: Command,
  requestId: Id = nextRequestId(),
): Promise<CommandResult> {
  const request: CommandRequest = { requestId, expectedRevision, command };
  return server.json<CommandResult>("/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

/** POST that is expected to fail; returns status and parsed body. */
export async function sendCommandExpectingFailure(
  server: ServerHandle,
  expectedRevision: Revision,
  command: Command,
  requestId: Id = nextRequestId(),
): Promise<Failure> {
  const request: CommandRequest = { requestId, expectedRevision, command };
  const response = await server.fetch("/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw text for the assertion message.
  }
  return { status: response.status, body };
}

export async function history(
  server: ServerHandle,
  after = 0,
): Promise<HistoryEntry[]> {
  return server.json<HistoryEntry[]>(`/api/history?after=${after}`);
}

export async function neighborhood(
  server: ServerHandle,
  options: {
    id: Id;
    direction: "outgoing" | "incoming" | "both";
    blocking?: boolean;
  },
): Promise<Neighborhood> {
  const query = new URLSearchParams({
    id: options.id,
    direction: options.direction,
  });
  if (options.blocking !== undefined)
    query.set("blocking", String(options.blocking));
  return server.json<Neighborhood>(`/api/neighborhood?${query}`);
}

export async function search(
  server: ServerHandle,
  q: string,
): Promise<GraphNode[]> {
  return server.json<GraphNode[]>(`/api/search?${new URLSearchParams({ q })}`);
}

export async function exportAll(
  server: ServerHandle,
): Promise<{ graph: GraphSnapshot; history: HistoryEntry[] }> {
  return server.json<{ graph: GraphSnapshot; history: HistoryEntry[] }>(
    "/api/export",
  );
}

let counter = 0;

/** Unique request id per attempt, so idempotency is only tested deliberately. */
export function nextRequestId(prefix = "acceptance"): Id {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export function nodeByTitle(
  snapshot: GraphSnapshot,
  title: string,
): GraphNode | undefined {
  return snapshot.nodes.find((node) => node.title === title);
}

export function nodeById(
  snapshot: GraphSnapshot,
  id: Id,
): GraphNode | undefined {
  return snapshot.nodes.find((node) => node.id === id);
}

export function edgeById(
  snapshot: GraphSnapshot,
  id: Id,
): GraphEdge | undefined {
  return snapshot.edges.find((edge) => edge.id === id);
}

export function edgeBetween(
  snapshot: GraphSnapshot,
  source: Id,
  target: Id,
): GraphEdge | undefined {
  return snapshot.edges.find(
    (edge) => edge.source === source && edge.target === target,
  );
}

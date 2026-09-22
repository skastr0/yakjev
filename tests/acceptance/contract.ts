// The only place acceptance tests encode the wire contract.
//
// Mirrors the frozen protocol published by the backend owner
// (`packages/protocol/src/graph.ts` in thread T-01a0c770-931d-75f8-bc3e-5d687825e9a5).
// These are structural black-box types on purpose: acceptance asserts observable
// HTTP/SSE behavior and never imports owner internals.
import type { ServerHandle } from "./harness";

export type Id = string;
export type Actor = { readonly id: Id; readonly channel: Channel };
export type Channel = "browser" | "mcp" | "system";
export type Provenance = {
  readonly actor: Actor;
  readonly at: string;
  readonly revision: number;
};
export type Source = { readonly uri: string; readonly label: string };
export type Position = {
  readonly x: number;
  readonly y: number;
  readonly pinned: boolean;
};
export type NodeStatus = "idea" | "active" | "done" | "archived";

export type NodeInput = {
  readonly id: Id;
  readonly title: string;
  readonly description: string;
  readonly project: string;
  readonly status: NodeStatus;
  readonly sources: readonly Source[];
};

export type GraphNode = NodeInput & {
  readonly position: Position | null;
  readonly created: Provenance;
  readonly updated: Provenance;
};

export type Relation = {
  readonly id: Id;
  readonly label: string;
  readonly definition: string;
  readonly blocking: boolean;
};
export type Taxonomy = {
  readonly version: number;
  readonly relations: readonly Relation[];
};

export type EdgeInput = {
  readonly id: Id;
  readonly source: Id;
  readonly target: Id;
  readonly relation: Id;
  readonly rationale: string;
};
export type Assertion = {
  readonly relation: Id;
  readonly rationale: string;
  readonly provenance: Provenance;
};
export type Correction = Assertion & {
  readonly state: "asserted" | "disputed";
};
export type EdgeState = "asserted" | "disputed";
export type GraphEdge = EdgeInput & {
  readonly state: EdgeState;
  readonly assertion: Assertion;
  readonly correction: Correction | null;
  readonly updated: Provenance;
};

export type CaptureInput = {
  readonly id: Id;
  readonly text: string;
  readonly sources: readonly Source[];
  readonly nodeIds: readonly Id[];
};
export type Capture = CaptureInput & { readonly provenance: Provenance };

export type SuggestionInput = {
  readonly id: Id;
  readonly source: Id;
  readonly target: Id;
  readonly relation: Id;
  readonly rationale: string;
  readonly confidence: number | null;
  readonly evidence: readonly string[];
  readonly model: string;
  readonly promptVersion: string;
  readonly taxonomyVersion: number;
  readonly basedOnRevision: number;
};
export type Suggestion = SuggestionInput & {
  readonly status: "pending" | "accepted" | "rejected";
  readonly provenance: Provenance;
  readonly decision: Provenance | null;
};

export type GraphSnapshot = {
  readonly revision: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly captures: readonly Capture[];
  readonly suggestions: readonly Suggestion[];
  readonly taxonomy: Taxonomy;
};

export type Command =
  | {
      readonly type: "capture";
      readonly capture: CaptureInput;
      readonly nodes: readonly NodeInput[];
      readonly edges: readonly EdgeInput[];
    }
  | { readonly type: "node.put"; readonly node: NodeInput }
  | { readonly type: "edge.put"; readonly edge: EdgeInput }
  | {
      readonly type: "edge.reframe";
      readonly id: Id;
      readonly relation: Id;
      readonly rationale: string;
      readonly state: EdgeState;
    }
  | {
      readonly type: "layout.set";
      readonly positions: readonly ({ readonly id: Id } & Position)[];
    }
  | {
      readonly type: "taxonomy.replace";
      readonly relations: readonly Relation[];
    }
  | { readonly type: "suggestion.record"; readonly suggestion: SuggestionInput }
  | {
      readonly type: "suggestion.decide";
      readonly id: Id;
      readonly decision: "accept" | "reject";
      readonly rationale: string;
    }
  | { readonly type: "undo"; readonly revision: number };

export type CommandRequest = {
  readonly requestId: Id;
  readonly expectedRevision: number;
  readonly command: Command;
};

export type Receipt = {
  readonly requestId: Id;
  readonly revision: number;
  readonly type: string;
  readonly actor: Actor;
  readonly at: string;
};
export type CommandResult = {
  readonly receipt: Receipt;
  readonly replayed: boolean;
};
export type HistoryEntry = Receipt & { readonly command: Command };

export type Neighborhood = {
  readonly root: Id;
  readonly revision: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly blockingEdges: readonly Id[];
  readonly cycleDetected: boolean;
  readonly interpretation: string;
};

export type ApiError = {
  readonly error:
    | "Unauthorized"
    | "Forbidden"
    | "Invalid"
    | "NotFound"
    | "Conflict"
    | "StorageError";
  readonly message: string;
  readonly currentRevision?: number;
};

export type Failure = { readonly status: number; readonly body: unknown };

export async function readGraph(server: ServerHandle): Promise<GraphSnapshot> {
  return server.json<GraphSnapshot>("/api/graph");
}

export async function sendCommand(
  server: ServerHandle,
  expectedRevision: number,
  command: Command,
  requestId: string = nextRequestId(),
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
  expectedRevision: number,
  command: Command,
  requestId: string = nextRequestId(),
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
export function nextRequestId(prefix = "acceptance"): string {
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

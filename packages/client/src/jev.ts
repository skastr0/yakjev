import type {
  Command,
  Edge,
  EdgeInput,
  Graph,
  JevOrigin,
  Preview,
  PreviewJudgment,
} from "@yakjev/protocol";
import { captureIntention } from "./graph-commands";
import { randomUUID, type RandomUUID } from "./id";

// A link Jev is about to make, drawn on the canvas before it exists. `from` is
// a node id, or a client point for a node that does not exist yet.
export type Ghost = {
  from: string | { x: number; y: number };
  to: string;
  strength: number;
  label: string;
  kind: "typing" | "drag";
  // Relation id when the label is a display word such as "same".
  relation?: string;
};

// Judgments Jev will act on, limited to nodes the owner can see.
export function connections(
  preview: Preview | null,
  graph: Pick<Graph, "nodes">,
): PreviewJudgment[] {
  if (!preview || preview.status !== "succeeded") return [];
  const visible = new Set(graph.nodes.map((node) => node.id));
  return preview.judgments.filter(
    (judgment) =>
      judgment.connect &&
      judgment.relation !== null &&
      visible.has(judgment.nodeId),
  );
}

// The edge Jev decided between the focus (new or moved node) and a candidate.
export function jevEdge(
  focus: string,
  preview: Preview,
  judgment: PreviewJudgment,
  newId: RandomUUID = randomUUID,
): EdgeInput | null {
  if (!judgment.relation) return null;
  const forward = judgment.direction === "focus_to_candidate";
  return {
    id: newId(),
    source: forward ? focus : judgment.nodeId,
    target: forward ? judgment.nodeId : focus,
    relation: judgment.relation,
    rationale: JEV_RATIONALE,
    origin: jevOrigin(preview, judgment),
  };
}

export const JEV_RATIONALE = "Connected by Jev.";

export function jevOrigin(
  preview: Preview,
  judgment: PreviewJudgment,
): JevOrigin {
  return {
    model: preview.model ?? "unknown",
    promptVersion: preview.promptVersion,
    confidence: probability(judgment.confidence),
    same: judgment.same,
  };
}

// A capture that carries Jev's edges when the preview was judged for exactly
// this text; otherwise the server connects the new node after commit.
export function captureWithJev(
  title: string,
  draft: DraftPreview | null,
  graph: Pick<Graph, "nodes">,
  newId: RandomUUID = randomUUID,
): { command: Command; nodeId: string; connected: number } | null {
  const built = captureIntention(title, newId);
  if (!built || built.command.type !== "capture") return null;
  const current =
    draft !== null &&
    draft.text === title.trim() &&
    draft.preview.status === "succeeded";
  if (!current)
    return {
      command: { ...built.command, autoConnect: true },
      nodeId: built.nodeId,
      connected: 0,
    };
  const edges = connections(draft.preview, graph).flatMap((judgment) => {
    const edge = jevEdge(built.nodeId, draft.preview, judgment, newId);
    return edge ? [edge] : [];
  });
  return {
    command: { ...built.command, edges, autoConnect: false },
    nodeId: built.nodeId,
    connected: edges.length,
  };
}

export function relationLabel(
  graph: Pick<Graph, "taxonomy">,
  judgment: PreviewJudgment,
) {
  if (judgment.same) return "same";
  return judgment.relation ? labelOf(graph, judgment.relation) : "";
}

export function typingGhosts(
  judgments: readonly PreviewJudgment[],
  graph: Pick<Graph, "taxonomy">,
  from: { x: number; y: number },
): Ghost[] {
  return judgments.map((judgment) => ({
    from,
    to: judgment.nodeId,
    strength: clamp(judgment.relatedness),
    label: relationLabel(graph, judgment),
    kind: "typing",
    ...(judgment.relation ? { relation: judgment.relation } : {}),
  }));
}

// The owner says Jev was wrong about this pair. The server suppresses it and
// feeds the removal back to Jev as a correction.
export function unlinkJev(id: string): Command {
  return {
    type: "edge.remove",
    id,
    suppress: true,
    rationale: "Not related, per the owner.",
  };
}

// A new relation for a Jev edge. Keeps an owner-written rationale; replaces
// Jev's boilerplate with what was corrected.
export function correctJev(
  edge: Edge,
  relation: string,
  rationale: string,
  graph: Pick<Graph, "taxonomy">,
): Command {
  const own = rationale.trim();
  return {
    type: "edge.reframe",
    id: edge.id,
    relation,
    rationale:
      own && own !== JEV_RATIONALE
        ? own
        : `Corrected from ${labelOf(graph, edge.relation)}.`,
    state: edge.state,
  };
}

// This node's connections that Jev made, with the node on the other end.
export function jevEdgesOf(graph: Pick<Graph, "edges">, id: string) {
  return graph.edges.flatMap((edge) =>
    edge.origin && (edge.source === id || edge.target === id)
      ? [
          {
            edge,
            other: edge.source === id ? edge.target : edge.source,
            outgoing: edge.source === id,
          },
        ]
      : [],
  );
}

export function labelOf(graph: Pick<Graph, "taxonomy">, relation: string) {
  return (
    graph.taxonomy.relations.find((item) => item.id === relation)?.label ??
    relation
  );
}

// Edges Jev made on its own after `since`: the server's background connects
// carry the suggestion they came from; edges made in this browser do not.
export function backgroundArrivals(
  graph: Pick<Graph, "edges">,
  since: number,
): Edge[] {
  return graph.edges.filter(
    (edge) =>
      edge.origin !== undefined &&
      edge.suggestionId !== undefined &&
      edge.correction === null &&
      edge.updated.revision > since,
  );
}

export type DraftPreview = { text: string; preview: Preview };

export function percentText(value: number | null | undefined) {
  const share = probability(value);
  return share === null ? "" : `${Math.round(share * 100)}%`;
}

function probability(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : clamp(value);
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

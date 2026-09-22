import { useEffect, useRef, useState } from "react";
import type {
  Command,
  EdgeInput,
  Graph,
  JevOrigin,
  Preview,
  PreviewJudgment,
} from "@yakjev/protocol";
import { previewJev } from "./api";
import { captureIntention } from "./graph-commands";

// A link Jev is about to make, drawn on the canvas before it exists. `from` is
// a node id, or a client point for a node that does not exist yet.
export type Ghost = {
  from: string | { x: number; y: number };
  to: string;
  strength: number;
  label: string;
  kind: "typing" | "drag";
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
): EdgeInput | null {
  if (!judgment.relation) return null;
  const forward = judgment.direction === "focus_to_candidate";
  return {
    id: crypto.randomUUID(),
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
): { command: Command; nodeId: string; connected: number } | null {
  const built = captureIntention(title);
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
    const edge = jevEdge(built.nodeId, draft.preview, judgment);
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
  const relation = graph.taxonomy.relations.find(
    (item) => item.id === judgment.relation,
  );
  return relation?.label ?? judgment.relation ?? "";
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
  }));
}

export type DraftPreview = { text: string; preview: Preview };
export type DraftState = {
  // The latest finished preview, possibly for older text.
  result: DraftPreview | null;
  loading: boolean;
  failed: boolean;
};

const DRAFT_DELAY_MS = 220;

// Judges the intention as it is typed: debounced, stale calls aborted, and
// answers cached per text so backspacing is instant.
export function useDraftPreview(title: string, revision: number): DraftState {
  const text = title.trim();
  const cache = useRef(new Map<string, Preview>());
  const cachedRevision = useRef(revision);
  const [state, setState] = useState<DraftState>({
    result: null,
    loading: false,
    failed: false,
  });
  useEffect(() => {
    if (cachedRevision.current !== revision) {
      cache.current.clear();
      cachedRevision.current = revision;
    }
    if (text.length < 3) {
      setState({ result: null, loading: false, failed: false });
      return;
    }
    const hit = cache.current.get(text);
    if (hit) {
      setState({
        result: { text, preview: hit },
        loading: false,
        failed: false,
      });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewJev({ draft: { title: text } }, controller.signal).then(
        (preview) => {
          cache.current.set(text, preview);
          setState({
            result: { text, preview },
            loading: false,
            failed: false,
          });
        },
        () => {
          if (controller.signal.aborted) return;
          setState((current) => ({ ...current, loading: false, failed: true }));
        },
      );
    }, DRAFT_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, revision]);
  return state;
}

export type PairState = {
  preview: Preview | null;
  judgment: PreviewJudgment | null;
  loading: boolean;
};

// Jev's judgment of a drawn link, reused from the drag when it has one.
export function usePairPreview(
  source: string,
  target: string,
  given: Preview | undefined,
): PairState {
  const [fetched, setFetched] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setFetched(null);
    setLoading(false);
    if (given?.judgments.some((item) => item.nodeId === target)) return;
    const controller = new AbortController();
    setLoading(true);
    previewJev(
      { focusNodeId: source, includeNodeIds: [target] },
      controller.signal,
    ).then(
      (preview) => {
        setFetched(preview);
        setLoading(false);
      },
      () => {
        if (!controller.signal.aborted) setLoading(false);
      },
    );
    return () => controller.abort();
  }, [source, target, given]);
  const preview = given?.judgments.some((item) => item.nodeId === target)
    ? given
    : fetched;
  const judgment =
    preview?.status === "succeeded"
      ? (preview.judgments.find((item) => item.nodeId === target) ?? null)
      : null;
  return { preview, judgment, loading };
}

export function confidenceText(confidence: number | null | undefined) {
  const value = probability(confidence);
  return value === null ? "" : `${Math.round(value * 100)}%`;
}

function probability(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : clamp(value);
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

import { useEffect, useRef, useState } from "react";
import type { Edge, Graph, Preview, PreviewJudgment } from "@yakjev/protocol";
import { backgroundArrivals, type DraftPreview } from "@yakjev/client/jev";
import { previewJev } from "./api";

export * from "@yakjev/client/jev";

const ARRIVAL_MS = 8000;

export type Arrival = { edge: Edge; until: number };

// Background Jev edges as they arrive, each shown for a while. Nothing is
// announced for the graph as first loaded.
export function useJevArrivals(graph: Pick<Graph, "edges" | "revision">) {
  const seen = useRef<number | null>(null);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const since = seen.current;
    seen.current = graph.revision;
    const live = new Set(graph.edges.map((edge) => edge.id));
    setArrivals((current) => {
      const kept = current.filter((item) => live.has(item.edge.id));
      if (since === null || graph.revision <= since) return kept;
      const known = new Set(kept.map((item) => item.edge.id));
      const until = Date.now() + ARRIVAL_MS;
      const fresh = backgroundArrivals(graph, since)
        .filter((edge) => !known.has(edge.id))
        .map((edge) => ({ edge, until }));
      return fresh.length === 0 && kept.length === current.length
        ? current
        : [...kept, ...fresh];
    });
  }, [graph]);
  useEffect(() => {
    if (held || arrivals.length === 0) return;
    const next = Math.min(...arrivals.map((item) => item.until));
    const timer = setTimeout(
      () =>
        setArrivals((current) =>
          current.filter((item) => item.until > Date.now()),
        ),
      Math.max(0, next - Date.now()) + 20,
    );
    return () => clearTimeout(timer);
  }, [arrivals, held]);
  return {
    arrivals,
    dismiss: (id: string) =>
      setArrivals((current) => current.filter((item) => item.edge.id !== id)),
    // Hovering keeps the chips; leaving gives them a few more seconds.
    hold: (on: boolean) => {
      setHeld(on);
      if (!on) {
        const until = Date.now() + ARRIVAL_MS / 2;
        setArrivals((current) =>
          current.map((item) => ({
            ...item,
            until: Math.max(item.until, until),
          })),
        );
      }
    },
  };
}

// A brief confirmation that outlives the card that caused it (a removed edge
// closes its card at once).
export function announceLearned(message: string) {
  if (typeof document === "undefined") return;
  document.querySelector(".jev-learned")?.remove();
  const toast = document.createElement("div");
  toast.className = "jev-learned";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2200);
}

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
      previewJev(
        { draft: { title: text }, purpose: "typing" },
        controller.signal,
      ).then(
        (preview) => {
          cache.current.set(text, preview);
          if (controller.signal.aborted) return;
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
  // Keyed on whether the canvas already judged the pair, not on the object.
  const judged = given?.judgments.some((item) => item.nodeId === target);
  useEffect(() => {
    setFetched(null);
    setLoading(false);
    if (judged) return;
    const controller = new AbortController();
    setLoading(true);
    previewJev(
      {
        focusNodeId: source,
        includeNodeIds: [target],
        only: true,
        purpose: "link",
      },
      controller.signal,
    ).then(
      (preview) => {
        if (controller.signal.aborted) return;
        setFetched(preview);
        setLoading(false);
      },
      () => {
        if (!controller.signal.aborted) setLoading(false);
      },
    );
    return () => controller.abort();
  }, [source, target, judged]);
  const preview = judged && given ? given : fetched;
  const judgment =
    preview?.status === "succeeded"
      ? (preview.judgments.find((item) => item.nodeId === target) ?? null)
      : null;
  return { preview, judgment, loading };
}

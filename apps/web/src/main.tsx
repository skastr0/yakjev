import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  Command,
  Graph,
  Preview,
  PreviewJudgment,
} from "@yakjev/protocol";
import { errorMessage, previewJev, request, saveLayout } from "./api";
import { GraphCanvas, type CanvasHandle } from "./graph-canvas";
import { JevContext } from "./jev-context";
import { JevDevPanel } from "./jev-dev";
import { jevEdge, relationLabel, type Ghost } from "./jev";
import { GraphEditor, JevActivity, type Mode } from "./editor";
import {
  dragJudgments,
  searchNodes,
  unjudgedIds,
  visibleGraph,
} from "./graph-model";
import { readPaint, writePaint } from "./blend";
import { useGraph } from "./use-graph";
import "./style.css";

function App() {
  const state = useGraph();
  const graph = state.graph;
  const canvas = useRef<CanvasHandle>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [focusRoot, setFocusRoot] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const [paint, setPaint] = useState(readPaint);
  const [typingGhosts, setTypingGhosts] = useState<Ghost[]>([]);
  const onTypingGhosts = useCallback((next: Ghost[]) => {
    setTypingGhosts(next);
  }, []);
  const linkGeneration = useRef(0);
  // A new object every render makes the canvas re-apply layout on camera ticks.
  const view = useMemo(
    () => (graph ? visibleGraph(graph, showArchived) : null),
    [graph, showArchived],
  );
  const jev = useDragConnect(view, state.execute);
  const ghosts = useMemo(
    () => [...typingGhosts, ...jev.ghosts],
    [typingGhosts, jev.ghosts],
  );
  const matches = useMemo(() => {
    if (!view || !query.trim()) return null;
    return searchNodes(view.nodes, query);
  }, [view, query]);
  const [jevDev, setJevDev] = useState(readJevDev);
  const toggleJevDev = () =>
    setJevDev((open) => {
      writeJevDev(!open);
      return !open;
    });
  const matchIds = useMemo(
    () => (matches ? new Set(matches.map((node) => node.id)) : null),
    [matches],
  );
  const hidden = useMemo(
    () => (focusRoot ? neighborhood(view, focusRoot) : null),
    [view, focusRoot],
  );

  useEffect(() => {
    if (!view || !mode) return;
    if (mode.kind === "node" && !view.nodes.some((node) => node.id === mode.id))
      setMode(null);
    if (mode.kind === "edge" && !view.edges.some((edge) => edge.id === mode.id))
      setMode(null);
    if (
      mode.kind === "suggestion" &&
      !view.suggestions.some((item) => item.id === mode.id)
    )
      setMode(null);
    if (focusRoot && !view.nodes.some((node) => node.id === focusRoot))
      setFocusRoot(null);
  }, [view, mode, focusRoot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = isTyping(event.target);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (typing) return;
        event.preventDefault();
        undo();
        return;
      }
      if (typing) {
        if (event.key === "Escape") {
          linkGeneration.current += 1;
          setMode(null);
          (event.target as HTMLElement).blur();
        }
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        findRef.current?.focus();
      } else if (event.key === "`" && graph) {
        toggleJevDev();
      } else if (event.key === "Escape") {
        linkGeneration.current += 1;
        setMode(null);
        setFocusRoot(null);
        setQuery("");
      } else if (
        event.key === "c" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        graph
      ) {
        event.preventDefault();
        setMode({
          kind: "create",
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
      } else if (event.key === "f" && mode?.kind === "node") {
        toggleFocus(mode.id);
      } else if (
        (event.key === "Backspace" || event.key === "Delete") &&
        mode?.kind === "node" &&
        graph
      ) {
        event.preventDefault();
        const node = graph.nodes.find((item) => item.id === mode.id);
        if (!node || node.status === "archived") return;
        void state.execute(
          {
            type: "node.put",
            node: {
              id: node.id,
              title: node.title,
              description: node.description,
              project: node.project,
              status: "archived",
              sources: node.sources,
            },
          },
          graph.revision,
        );
      } else if (
        !typing &&
        mode &&
        (mode.kind === "edge" || mode.kind === "assert") &&
        /^[1-9]$/.test(event.key) &&
        graph
      ) {
        const relation = graph.taxonomy.relations[Number(event.key) - 1];
        if (!relation) return;
        const choice = document.querySelector<HTMLButtonElement>(
          `.graph-editor [data-relation="${CSS.escape(relation.id)}"]`,
        );
        choice?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function undo() {
    if (!state.lastEdit) return;
    void state.execute(
      { type: "undo", revision: state.lastEdit.revision },
      state.lastEdit.revision,
    );
  }

  function toggleFocus(id: string) {
    setFocusRoot((current) => (current === id ? null : id));
    setFocusId(id);
  }

  async function exportGraph() {
    try {
      const data = await request("/api/export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "yakjev-graph.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      state.setError(errorMessage(cause));
    }
  }

  const anchor = (() => {
    void viewTick;
    if (!mode) return null;
    if (mode.kind === "create") return { x: mode.x, y: mode.y };
    if (mode.kind === "assert")
      return canvas.current?.anchorBetween(mode.source, mode.target) ?? null;
    if (mode.kind === "node")
      return canvas.current?.anchorNode(mode.id) ?? null;
    if (!view) return null;
    if (mode.kind === "edge") {
      const edge = view.edges.find((item) => item.id === mode.id);
      return edge
        ? (canvas.current?.anchorBetween(edge.source, edge.target) ?? null)
        : null;
    }
    const suggestion = view.suggestions.find((item) => item.id === mode.id);
    return suggestion
      ? (canvas.current?.anchorBetween(suggestion.source, suggestion.target) ??
          null)
      : null;
  })();

  return (
    <main className="workbench">
      <header className="topbar">
        <a href="/" className="brand">
          yakjev
        </a>
        {graph && (
          <input
            ref={findRef}
            className="find"
            type="search"
            aria-label="Find intentions"
            placeholder="Find"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !matches?.length) return;
              event.preventDefault();
              const id = matches[matchIndex]?.id;
              if (id) {
                setFocusId(id);
                setMode({ kind: "node", id });
              }
              setMatchIndex((matchIndex + 1) % matches.length);
            }}
          />
        )}
        <div
          className="connection-status"
          data-state={state.connection}
          role="status"
        >
          <span className="status-dot" data-jev={jev.busy ? "on" : undefined} />
          {state.connection === "live"
            ? state.pending
              ? "Saving…"
              : `Live · r${graph?.revision ?? 0}${view ? ` · ${view.nodes.length}` : ""}`
            : state.connection === "reconnecting"
              ? "Reconnecting…"
              : state.connection === "locked"
                ? "Private graph"
                : state.connection === "loading"
                  ? "Connecting…"
                  : "Server unavailable"}
        </div>
        {graph && (
          <nav aria-label="Workspace">
            <JevContext graph={graph} execute={state.execute} />
            <button
              type="button"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((value) => !value)}
            >
              Archived
            </button>
            <button type="button" disabled={!state.lastEdit} onClick={undo}>
              Undo
            </button>
            <button type="button" onClick={() => void exportGraph()}>
              Export
            </button>
            <button
              type="button"
              aria-pressed={jevDev}
              title="Jev calls, tokens, and cost (`)"
              onClick={toggleJevDev}
            >
              Jev
            </button>
            <button type="button" onClick={() => void state.logout()}>
              Lock
            </button>
          </nav>
        )}
      </header>
      {graph && jevDev && <JevDevPanel onClose={toggleJevDev} />}
      {state.error && (
        <div className="notice error" role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={() => state.setError("")}>
            Dismiss
          </button>
          {!graph && (
            <button type="button" onClick={state.retry}>
              Retry connection
            </button>
          )}
        </div>
      )}
      {state.connection === "reconnecting" && (
        <div className="notice" role="status">
          Live updates are reconnecting.
          <button type="button" onClick={state.retry}>
            Reconnect now
          </button>
        </div>
      )}
      {!graph || !view || !state.layout ? (
        <section className="entry-screen">
          <h1>
            A place for
            <br />
            the whole tangle.
          </h1>
          {state.connection === "locked" ? (
            <form
              className="login-form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = token;
                setToken("");
                void state.login(value);
              }}
            >
              <p>
                Unlock your private graph with the owner access token. It is
                exchanged for a secure session, never stored in this browser’s
                local storage.
              </p>
              <label>
                Owner access token
                <input
                  type="password"
                  autoComplete="current-password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  required
                />
              </label>
              <button className="primary" type="submit">
                Unlock graph
              </button>
            </form>
          ) : (
            <p role="status">
              {state.connection === "loading"
                ? "Loading your graph…"
                : "The graph could not be loaded. No local data has replaced it."}
            </p>
          )}
        </section>
      ) : (
        <div className="workspace-grid">
          {focusRoot && (
            <button
              type="button"
              className="exit-focus"
              onClick={() => setFocusRoot(null)}
            >
              Whole graph
            </button>
          )}
          <GraphCanvas
            ref={canvas}
            data={view}
            savedLayout={state.layout ?? EMPTY_LAYOUT}
            onLayout={(positions) =>
              saveLayout(positions).then(
                () => true,
                (cause: unknown) => {
                  state.setError(
                    `Positions not saved yet, retrying: ${errorMessage(cause)}`,
                  );
                  return false;
                },
              )
            }
            selection={
              mode?.kind === "node" ||
              mode?.kind === "edge" ||
              mode?.kind === "suggestion"
                ? mode
                : null
            }
            hidden={hidden}
            matches={matchIds}
            focusId={focusId}
            paint={paint}
            ghosts={ghosts}
            onView={() => {
              if (mode) setViewTick((value) => value + 1);
            }}
            onSelect={(next) => {
              linkGeneration.current += 1;
              setMode(next);
            }}
            onCreate={(at) => setMode({ kind: "create", ...at })}
            onLink={(source, target) => {
              const existing = view.edges.find(
                (edge) => edge.source === source && edge.target === target,
              );
              if (existing) {
                setMode({ kind: "edge", id: existing.id });
                return;
              }
              linkGeneration.current += 1;
              setMode({ kind: "assert", source, target });
            }}
            onDragStart={jev.onStart}
            onDragMove={jev.onMove}
            onDragEnd={jev.onEnd}
            onDragCancel={jev.onCancel}
            onFocusNode={toggleFocus}
          />
          {mode && (
            <GraphEditor
              graph={view}
              mode={mode}
              anchor={anchor}
              execute={state.execute}
              focused={
                focusRoot !== null &&
                mode.kind === "node" &&
                focusRoot === mode.id
              }
              onClose={() => {
                linkGeneration.current += 1;
                setMode(null);
              }}
              onCreated={(id) => {
                setMode({ kind: "node", id });
                setFocusId(id);
              }}
              onAsserted={(id) => setMode({ kind: "edge", id })}
              onFocus={toggleFocus}
              onGhosts={onTypingGhosts}
              onPlace={(id, at) => canvas.current?.placeAt(id, at)}
              paint={paint}
              onPaint={(id, color) =>
                setPaint((current) => writePaint(current, id, color))
              }
            />
          )}
          <JevActivity
            graph={view}
            execute={state.execute}
            onOpen={(id) => setMode({ kind: "edge", id })}
          />
        </div>
      )}
    </main>
  );
}

function neighborhood(
  graph: ReturnType<typeof visibleGraph> | null,
  id: string,
) {
  if (!graph) return null;
  const next = new Set([id]);
  for (const edge of graph.edges) {
    if (edge.source === id) next.add(edge.target);
    if (edge.target === id) next.add(edge.source);
  }
  for (const suggestion of graph.suggestions) {
    if (suggestion.status !== "pending") continue;
    if (suggestion.source === id) next.add(suggestion.target);
    if (suggestion.target === id) next.add(suggestion.source);
  }
  return next;
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
}

// A drag asks Jev only about nodes it lingers near: sweeping past nodes
// costs nothing, and each call names just the new nearby nodes (only:true).
const INCLUDE_DELAY_MS = 200;
// Answers for (revision, dragged node, neighbour), reused across drags until
// the graph changes, so moving a node around the same area is free.
const dragMemo = new Map<
  string,
  { judgment: PreviewJudgment; preview: Preview }
>();
const memoKey = (revision: number, focus: string, node: string) =>
  `${revision}|${focus}|${node}`;
const RETRY_MS = 1000;

type Slot =
  | { kind: "judgment"; judgment: PreviewJudgment; preview: Preview }
  | { kind: "none" }
  | { kind: "retry"; at: number };

type Session = {
  focusId: string;
  nearby: readonly string[];
  held: Map<string, Slot>;
  phase: "drag" | "commit" | "dead";
  abort: AbortController;
  chain: Promise<void>;
  timer: number;
};

function useDragConnect(
  graph: Graph | null,
  execute: (command: Command, revision: number) => Promise<boolean>,
) {
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const session = useRef<Session | null>(null);
  const depth = useRef(0);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [busy, setBusy] = useState(false);

  function begin() {
    depth.current += 1;
    setBusy(true);
  }
  function finish() {
    depth.current = Math.max(0, depth.current - 1);
    setBusy(depth.current > 0);
  }
  function publish(current: Session) {
    const data = graphRef.current;
    if (!data || session.current !== current) return;
    const next = dragJudgments(
      current.focusId,
      current.nearby,
      judgmentsOf(current),
      data.edges,
    ).map((judgment) => ghostFrom(current.focusId, data, judgment));
    setGhosts((previous) => (sameGhosts(previous, next) ? previous : next));
  }
  function schedule(current: Session, delay = INCLUDE_DELAY_MS) {
    window.clearTimeout(current.timer);
    current.timer = window.setTimeout(() => {
      if (session.current !== current || current.phase !== "drag") return;
      for (const [id, slot] of current.held)
        if (slot.kind === "retry") current.held.delete(id);
      const missing = unjudgedIds(current.nearby, new Set(current.held.keys()));
      if (missing.length) void ask(current, missing);
    }, delay);
  }
  function ask(current: Session, include: readonly string[]) {
    const task = current.chain.then(async () => {
      if (!alive(current)) return;
      begin();
      try {
        const preview = await previewJev(
          include.length
            ? {
                focusNodeId: current.focusId,
                includeNodeIds: [...include],
                only: true,
                purpose: "drag",
              }
            : { focusNodeId: current.focusId, purpose: "drag" },
          current.abort.signal,
        );
        if (!alive(current)) return;
        const answered = absorb(current, preview, include);
        if (!answered) noteRetry(current, include);
        publish(current);
        if (current.phase === "drag")
          schedule(current, answered ? INCLUDE_DELAY_MS : RETRY_MS);
      } catch {
        if (!alive(current)) return;
        noteRetry(current, include);
        if (current.phase === "drag") schedule(current, RETRY_MS);
      } finally {
        finish();
      }
    });
    current.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return current.chain;
  }

  useEffect(
    () => () => {
      const current = session.current;
      if (!current) return;
      current.phase = "dead";
      current.abort.abort();
      window.clearTimeout(current.timer);
    },
    [],
  );

  return {
    ghosts,
    busy,
    onStart(id: string, nearby: readonly string[]) {
      const previous = session.current;
      if (previous && previous.phase !== "commit") {
        previous.phase = "dead";
        previous.abort.abort();
        window.clearTimeout(previous.timer);
      }
      const current: Session = {
        focusId: id,
        nearby,
        held: new Map(),
        phase: "drag",
        abort: new AbortController(),
        chain: Promise.resolve(),
        timer: 0,
      };
      session.current = current;
      const revision = graphRef.current?.revision;
      if (revision !== undefined)
        for (const [key, hit] of dragMemo)
          if (key.startsWith(`${revision}|${id}|`))
            current.held.set(hit.judgment.nodeId, { kind: "judgment", ...hit });
      setGhosts([]);
      publish(current);
      schedule(current);
    },
    onMove(id: string, nearby: readonly string[]) {
      const current = session.current;
      if (!current || current.phase !== "drag" || current.focusId !== id)
        return;
      if (sameIds(current.nearby, nearby)) return;
      current.nearby = nearby;
      publish(current);
      schedule(current);
    },
    onCancel() {
      const current = session.current;
      if (!current || current.phase === "commit") return;
      current.phase = "dead";
      current.abort.abort();
      window.clearTimeout(current.timer);
      session.current = null;
      setGhosts([]);
    },
    async onEnd(id: string, nearby: readonly string[]) {
      const current = session.current;
      if (!current || current.phase !== "drag" || current.focusId !== id)
        return;
      current.phase = "commit";
      current.nearby = nearby;
      window.clearTimeout(current.timer);
      const missing = unjudgedIds(nearby, answeredIds(current));
      if (missing.length) await ask(current, missing);
      else await current.chain;
      const data = graphRef.current;
      const edges =
        data && current.phase === "commit"
          ? dragJudgments(
              current.focusId,
              current.nearby,
              judgmentsOf(current),
              data.edges,
            ).flatMap((judgment) => {
              const slot = current.held.get(judgment.nodeId);
              if (!slot || slot.kind !== "judgment") return [];
              const edge = jevEdge(current.focusId, slot.preview, judgment);
              return edge ? [edge] : [];
            })
          : [];
      if (session.current === current) {
        session.current = null;
        setGhosts([]);
      }
      for (const edge of edges) {
        const saved = await executeRef.current(
          { type: "edge.put", edge },
          data?.revision ?? 0,
        );
        if (!saved) break;
      }
    },
  };
}

function alive(current: Session) {
  return current.phase !== "dead" && !current.abort.signal.aborted;
}

function answeredIds(current: Session) {
  const ids = new Set<string>();
  for (const [id, slot] of current.held) if (slot.kind !== "retry") ids.add(id);
  return ids;
}

function judgmentsOf(current: Session) {
  return [...current.held.values()].flatMap((slot) =>
    slot.kind === "judgment" ? [slot.judgment] : [],
  );
}

function absorb(
  current: Session,
  preview: Preview,
  include: readonly string[],
) {
  if (preview.status !== "succeeded") return false;
  for (const judgment of preview.judgments) {
    current.held.set(judgment.nodeId, {
      kind: "judgment",
      judgment,
      preview,
    });
    dragMemo.set(
      memoKey(preview.basedOnRevision, current.focusId, judgment.nodeId),
      { judgment, preview },
    );
  }
  if (dragMemo.size > 5000) dragMemo.clear();
  for (const id of include)
    if (!current.held.has(id)) current.held.set(id, { kind: "none" });
  return true;
}

function noteRetry(current: Session, include: readonly string[]) {
  const at = Date.now();
  for (const id of include) current.held.set(id, { kind: "retry", at });
}

function ghostFrom(
  focusId: string,
  graph: Graph,
  judgment: PreviewJudgment,
): Ghost {
  const forward = judgment.direction === "focus_to_candidate";
  const relatedness = judgment.relatedness;
  return {
    from: forward ? focusId : judgment.nodeId,
    to: forward ? judgment.nodeId : focusId,
    strength: Number.isFinite(relatedness)
      ? Math.min(1, Math.max(0, relatedness))
      : 0,
    label: relationLabel(graph, judgment),
    kind: "drag",
    ...(judgment.relation ? { relation: judgment.relation } : {}),
  };
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function sameGhosts(left: readonly Ghost[], right: readonly Ghost[]) {
  return (
    left.length === right.length &&
    left.every((ghost, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        ghost.kind === other.kind &&
        ghost.to === other.to &&
        ghost.label === other.label &&
        ghost.relation === other.relation &&
        ghost.strength === other.strength &&
        endpoint(ghost.from) === endpoint(other.from)
      );
    })
  );
}

function endpoint(end: Ghost["from"]) {
  return typeof end === "string" ? end : `${end.x},${end.y}`;
}

const EMPTY_LAYOUT: ReadonlyMap<string, { x: number; y: number }> = new Map();
const JEV_DEV_KEY = "yakjev.jevDev";
function readJevDev() {
  try {
    return localStorage.getItem(JEV_DEV_KEY) === "open";
  } catch {
    return false;
  }
}
function writeJevDev(open: boolean) {
  try {
    if (open) localStorage.setItem(JEV_DEV_KEY, "open");
    else localStorage.removeItem(JEV_DEV_KEY);
  } catch {
    /* A remembered panel is a convenience only. */
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

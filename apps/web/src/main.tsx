import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage, request } from "./api";
import { GraphCanvas, type CanvasHandle } from "./graph-canvas";
import { GraphEditor, type Mode } from "./editor";
import { searchNodes, visibleGraph } from "./graph-model";
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
  const [evaluating, setEvaluating] = useState(false);
  const view = graph ? visibleGraph(graph, showArchived) : null;
  const matches = view && query.trim() ? searchNodes(view.nodes, query) : null;
  const matchIds = matches ? new Set(matches.map((node) => node.id)) : null;
  const hidden = focusRoot ? neighborhood(view, focusRoot) : null;

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
          setMode(null);
          (event.target as HTMLElement).blur();
        }
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        findRef.current?.focus();
      } else if (event.key === "Escape") {
        setMode(null);
        setFocusRoot(null);
        setQuery("");
      } else if (event.key === "c" && graph) {
        setMode({
          kind: "create",
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
      } else if (event.key === "f" && mode?.kind === "node") {
        toggleFocus(mode.id);
      } else if (event.key === "j" && mode?.kind === "node") {
        void askJev(mode.id);
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

  async function askJev(id: string) {
    if (!graph || evaluating) return;
    setEvaluating(true);
    state.setError("");
    try {
      await request("/api/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedRevision: graph.revision,
          query: graph.nodes.find((node) => node.id === id)?.title ?? "",
          focusNodeId: id,
        }),
      });
      const next = await state.refresh();
      const latest = next.evaluations.at(-1);
      if (latest && latest.status !== "succeeded")
        state.setError("Jev recorded no suggestion.");
    } catch (cause) {
      state.setError(errorMessage(cause));
    } finally {
      setEvaluating(false);
    }
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
          <span className="status-dot" />
          {state.connection === "live"
            ? evaluating
              ? "Jev is looking…"
              : state.pending
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
            <button type="button" onClick={() => void state.logout()}>
              Lock
            </button>
          </nav>
        )}
      </header>
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
      {!graph || !view ? (
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
            onView={() => setViewTick((value) => value + 1)}
            onSelect={(next) => setMode(next)}
            onCreate={(at) => setMode({ kind: "create", ...at })}
            onLink={(source, target) => {
              const existing = view.edges.find(
                (edge) => edge.source === source && edge.target === target,
              );
              setMode(
                existing
                  ? { kind: "edge", id: existing.id }
                  : { kind: "assert", source, target },
              );
            }}
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
              onClose={() => setMode(null)}
              onCreated={(id) => {
                setMode({ kind: "node", id });
                setFocusId(id);
              }}
              onAsserted={(id) => setMode({ kind: "edge", id })}
              onFocus={toggleFocus}
              onAskJev={(id) => void askJev(id)}
            />
          )}
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

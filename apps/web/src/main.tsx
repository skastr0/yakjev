import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage, request } from "./api";
import { NodeForm, TaxonomyForm } from "./forms";
import { GraphCanvas } from "./graph-canvas";
import { searchNodes, type Selection } from "./graph-model";
import { HistoryPanel, Inspector } from "./inspector";
import { useGraph } from "./use-graph";
import "./style.css";

function App() {
  const state = useGraph();
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [visible, setVisible] = useState<ReadonlySet<string> | null>(null);
  const [panel, setPanel] = useState<
    "inspect" | "capture" | "taxonomy" | "history" | "jev"
  >("capture");
  const [epoch, setEpoch] = useState(0);
  const [includeArchived, setIncludeArchived] = useState(false);
  const graph = state.graph;
  const select = (next: Selection) => {
    setSelection(next);
    setPanel("inspect");
  };
  const nodes = graph
    ? searchNodes(
        graph.nodes.filter(
          (node) => includeArchived || node.status !== "archived",
        ),
        query,
      )
    : [];
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
  return (
    <main className="workbench">
      <header className="topbar">
        <a href="/" className="brand">
          yakjev
        </a>
        <span className="tagline">KEEP THE THREAD</span>
        <div
          className="connection-status"
          data-state={state.connection}
          role="status"
        >
          <span className="status-dot" />
          {state.connection === "live"
            ? `Live · r${graph?.revision ?? 0}`
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
            <button onClick={() => setPanel("history")}>History</button>
            <button
              onClick={() => {
                setPanel("taxonomy");
                setEpoch((value) => value + 1);
              }}
            >
              Taxonomy
            </button>
            <button onClick={() => void exportGraph()}>Export ↗</button>
            <button onClick={() => void state.logout()}>Lock</button>
          </nav>
        )}
      </header>
      {state.error && (
        <div className="notice error" role="alert">
          <span>{state.error}</span>
          <button
            onClick={() => {
              state.setError("");
            }}
          >
            Dismiss
          </button>
          {!graph && <button onClick={state.retry}>Retry connection</button>}
        </div>
      )}
      {graph && (state.notice || state.pending) && (
        <div className="notice" role="status">
          <span>{state.pending ? "Saving to graph…" : state.notice}</span>
          {state.lastEdit && (
            <button
              disabled={state.pending}
              onClick={() =>
                void state.execute(
                  { type: "undo", revision: state.lastEdit!.revision },
                  state.lastEdit!.revision,
                )
              }
            >
              Undo last edit
            </button>
          )}
        </div>
      )}
      {state.connection === "reconnecting" && (
        <div className="notice" role="status">
          The graph may be out of date while live updates reconnect.
          <button onClick={state.retry}>Reconnect now</button>
        </div>
      )}
      {!graph ? (
        <section className="entry-screen">
          <p className="eyebrow">YOUR INTENTIONS, CONNECTED</p>
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
              <button className="primary">Unlock graph</button>
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
          <aside className="node-sidebar" aria-label="Find intentions">
            <div className="sidebar-head">
              <button
                className="primary"
                onClick={() => {
                  setPanel("capture");
                  setEpoch((value) => value + 1);
                }}
              >
                + Capture intention
              </button>
              <label className="search-label">
                Search intentions
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Title, context, project, source…"
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(event) => setIncludeArchived(event.target.checked)}
                />
                Include archived
              </label>
              <div className="section-heading">
                <p className="eyebrow">{query ? "MATCHES" : "INTENTIONS"}</p>
                <span className="count">{nodes.length}</span>
              </div>
            </div>
            <div className="node-list">
              {!nodes.length && (
                <p className="hint">
                  {query
                    ? "No matches. Try another word or capture a new intention."
                    : "Your graph starts with an idea. It does not have to be a commitment."}
                </p>
              )}
              {nodes.map((node) => (
                <button
                  className={`node-card ${selection?.kind === "node" && selection.id === node.id ? "selected" : ""}`}
                  key={node.id}
                  onClick={() => {
                    select({ kind: "node", id: node.id });
                    setVisible(null);
                  }}
                >
                  <span className={`node-mark ${node.status}`}>○</span>
                  <span>
                    <strong>{node.title}</strong>
                    <small>
                      {node.project || "No project"} · {node.status}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <div className="sidebar-foot">
              <button onClick={() => setPanel("jev")}>
                Jev &amp; suggestions{" "}
                <span className="count">
                  {
                    graph.suggestions.filter(
                      (item) => item.status === "pending",
                    ).length
                  }
                </span>
              </button>
              <p>Ideas are not commitments.</p>
            </div>
          </aside>
          <section className="graph-region" aria-label="Graph workbench">
            <div className="graph-heading">
              <div>
                <p className="eyebrow">
                  {visible ? "FOCUSED NEIGHBORHOOD" : "THE WHOLE TANGLE"}
                </p>
                <h1>Intention graph</h1>
              </div>
              <span className="meta">
                {graph.nodes.length} nodes · {graph.edges.length} assertions
              </span>
            </div>
            {visible && (
              <button className="exit-focus" onClick={() => setVisible(null)}>
                ← Show whole graph
              </button>
            )}
            <GraphCanvas
              data={graph}
              selection={selection}
              visible={visible}
              select={select}
              pending={state.pending}
              report={state.setError}
              save={(positions, revision) =>
                state.execute({ type: "layout.set", positions }, revision)
              }
            />
          </section>
          <aside
            className="inspector"
            aria-label="Selection inspector"
            tabIndex={-1}
          >
            {panel === "capture" && (
              <>
                <p className="eyebrow">QUICK CAPTURE</p>
                <h2>Keep an intention.</h2>
                <p className="hint">
                  Enough context to return to it. Connect it when you are ready.
                </p>
                <NodeForm
                  key={epoch}
                  graph={graph}
                  execute={state.execute}
                  pending={state.pending}
                  saved={(id) => select({ kind: "node", id })}
                />
              </>
            )}
            {panel === "inspect" && (
              <Inspector
                graph={graph}
                execute={state.execute}
                pending={state.pending}
                selection={selection}
                select={select}
                focus={setVisible}
                report={state.setError}
              />
            )}
            {panel === "taxonomy" && (
              <>
                <p className="eyebrow">USER-DEFINED CRITERIA</p>
                <h2>Relationship taxonomy</h2>
                <button
                  className="text-button"
                  onClick={() => setEpoch((value) => value + 1)}
                >
                  Reload latest (discard draft)
                </button>
                <TaxonomyForm
                  key={epoch}
                  graph={graph}
                  execute={state.execute}
                  pending={state.pending}
                  saved={() => setEpoch((value) => value + 1)}
                />
              </>
            )}
            {panel === "history" && (
              <>
                <p className="eyebrow">NOTHING SILENTLY REWRITTEN</p>
                <h2>Graph history</h2>
                <HistoryPanel
                  graph={graph}
                  execute={state.execute}
                  pending={state.pending}
                />
              </>
            )}
            {panel === "jev" && (
              <>
                <p className="eyebrow">REVIEW, THEN DECIDE</p>
                <h2>Jev &amp; suggestions</h2>
                <p className="hint">
                  Suggested connections are never hard blockers until explicitly
                  accepted.
                </p>
                {!graph.suggestions.length && (
                  <p>No suggestions recorded yet.</p>
                )}
                {graph.suggestions.map((suggestion) => (
                  <button
                    className="connection-card"
                    key={suggestion.id}
                    onClick={() =>
                      select({ kind: "suggestion", id: suggestion.id })
                    }
                  >
                    <span>
                      {
                        graph.nodes.find(
                          (node) => node.id === suggestion.source,
                        )?.title
                      }{" "}
                      →{" "}
                      {
                        graph.nodes.find(
                          (node) => node.id === suggestion.target,
                        )?.title
                      }
                    </span>
                    <small>Machine suggestion · {suggestion.status}</small>
                  </button>
                ))}
                <p className="hint">
                  Evaluation controls are awaiting the server’s Jev capability
                  contract.
                </p>
              </>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

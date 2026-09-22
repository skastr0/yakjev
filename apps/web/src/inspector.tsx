import { useEffect, useState } from "react";
import type {
  Edge,
  Graph,
  HistoryEntry,
  Neighborhood,
  Node,
} from "@yakjev/protocol";
import { errorMessage, history, neighborhood } from "./api";
import {
  ConnectForm,
  NodeForm,
  RelationSelect,
  Sources,
  type EditorProps,
} from "./forms";
import { initialPosition, type Selection } from "./graph-model";

type Props = EditorProps & {
  selection: Selection;
  select: (value: Selection) => void;
  focus: (value: ReadonlySet<string> | null) => void;
  report: (message: string) => void;
};

export function Inspector(props: Props) {
  const [epoch, setEpoch] = useState(0);
  const { graph, selection } = props;
  if (!selection)
    return (
      <div className="inspector-empty">
        <p className="eyebrow">INSPECT THE CONNECTION</p>
        <h2>
          What is really
          <br />
          in the way?
        </h2>
        <p>
          Select an intention or a relationship. Its context, sources, and
          original assertion stay here as you revise the graph.
        </p>
        <p className="hint">
          Suggestions are proposals. Nothing here completes work in the real
          world.
        </p>
      </div>
    );
  const item =
    selection.kind === "node"
      ? graph.nodes.find((node) => node.id === selection.id)
      : selection.kind === "edge"
        ? graph.edges.find((edge) => edge.id === selection.id)
        : graph.suggestions.find(
            (suggestion) => suggestion.id === selection.id,
          );
  if (!item) return <p>This item is no longer in the current graph.</p>;
  return (
    <>
      <div className="section-heading">
        <p className="eyebrow">
          {selection.kind === "edge"
            ? "RELATIONSHIP"
            : selection.kind === "suggestion"
              ? "MACHINE SUGGESTION"
              : "INTENTION"}
        </p>
        <button
          className="text-button"
          onClick={() => props.select(null)}
          aria-label="Close inspector"
        >
          ×
        </button>
      </div>
      <button
        className="text-button reload-draft"
        onClick={() => setEpoch((value) => value + 1)}
      >
        Reload latest (discard draft)
      </button>
      {selection.kind === "node" && (
        <NodeInspector
          key={`${selection.id}:${epoch}`}
          {...props}
          node={item as Node}
        />
      )}
      {selection.kind === "edge" && (
        <EdgeInspector
          key={`${selection.id}:${epoch}`}
          {...props}
          edge={item as Edge}
        />
      )}
      {selection.kind === "suggestion" && (
        <SuggestionInspector
          key={`${selection.id}:${epoch}`}
          {...props}
          suggestion={item as Graph["suggestions"][number]}
        />
      )}
    </>
  );
}

function NodeInspector(props: Props & { node: Node }) {
  const { node, graph, pending, execute } = props;
  const [editing, setEditing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [direction, setDirection] = useState("outgoing");
  const [blocking, setBlocking] = useState(true);
  const [scope, setScope] = useState<Neighborhood | null>(null);
  const [expanding, setExpanding] = useState(false);
  const edges = graph.edges.filter(
    (edge) => edge.source === node.id || edge.target === node.id,
  );
  const title = (id: string) =>
    graph.nodes.find((item) => item.id === id)?.title ?? id;
  async function expand() {
    setExpanding(true);
    try {
      const result = await neighborhood(node.id, direction, blocking);
      setScope(result);
      props.focus(new Set(result.nodes.map((item) => item.id)));
    } catch (cause) {
      props.report(errorMessage(cause));
    } finally {
      setExpanding(false);
    }
  }
  return (
    <>
      <h2>{node.title}</h2>
      <div className="badges">
        <span>{node.status}</span>
        <span>{node.project || "No project"}</span>
        <span>{node.position?.pinned ? "Pinned" : "Unpinned"}</span>
      </div>
      <p className="preserve-text">
        {node.description || "No context added yet."}
      </p>
      <Sources sources={node.sources} />
      <p className="meta">
        Captured by {node.created.actor.id} · {node.created.actor.channel}
        <br />
        Updated at revision {node.updated.revision}
      </p>
      <div className="button-row">
        <button onClick={() => setEditing(!editing)}>
          {editing ? "Close editor" : "Edit intention"}
        </button>
        <button onClick={() => setConnecting(!connecting)}>
          {connecting ? "Close connection" : "+ Connect"}
        </button>
        <button
          disabled={pending}
          onClick={() =>
            void execute(
              {
                type: "layout.set",
                positions: [
                  {
                    id: node.id,
                    ...(node.position ?? initialPosition(node.id)),
                    pinned: !node.position?.pinned,
                  },
                ],
              },
              graph.revision,
            )
          }
        >
          {node.position?.pinned ? "Unpin" : "Pin position"}
        </button>
      </div>
      {editing && <NodeForm {...props} saved={() => setEditing(false)} />}
      {connecting && (
        <ConnectForm
          {...props}
          sourceId={node.id}
          saved={(id) => props.select({ kind: "edge", id })}
        />
      )}
      <section className="inspector-section">
        <h3>Explore the neighborhood</h3>
        <label>
          Direction
          <select
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
          >
            <option value="outgoing">What this intention needs →</option>
            <option value="incoming">What needs this intention ←</option>
            <option value="both">Both directions ↔</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={blocking}
            onChange={(event) => setBlocking(event.target.checked)}
          />
          Only claimed blockers
        </label>
        <div className="button-row">
          <button disabled={expanding} onClick={() => void expand()}>
            {expanding ? "Expanding…" : "Expand neighborhood"}
          </button>
          <button
            onClick={() => {
              setScope(null);
              props.focus(null);
            }}
          >
            Show whole graph
          </button>
        </div>
        {scope && (
          <p role="status" className="interpretation">
            {scope.interpretation}
            {scope.cycleDetected && " A cycle is part of this tangle."}
          </p>
        )}
      </section>
      <section className="inspector-section">
        <h3>
          Connections <span className="count">{edges.length}</span>
        </h3>
        {!edges.length && (
          <p className="hint">
            No assertions yet. Connect another intention without merging either
            idea.
          </p>
        )}
        {edges.map((edge) => (
          <button
            key={edge.id}
            className="connection-card"
            onClick={() => props.select({ kind: "edge", id: edge.id })}
          >
            <span>
              {title(edge.source)} <b>→</b> {title(edge.target)}
            </span>
            <small>
              {
                graph.taxonomy.relations.find((r) => r.id === edge.relation)
                  ?.label
              }{" "}
              ·{" "}
              {edge.state === "disputed"
                ? "disputed"
                : edge.correction
                  ? "corrected"
                  : "asserted"}
            </small>
          </button>
        ))}
      </section>
      <details className="inspector-section">
        <summary>Original captures</summary>
        {graph.captures
          .filter((capture) => capture.nodeIds.includes(node.id))
          .map((capture) => (
            <div key={capture.id}>
              <p className="preserve-text">{capture.text}</p>
              <Sources sources={capture.sources} />
              <p className="meta">
                Original capture · revision {capture.provenance.revision}
              </p>
            </div>
          ))}
      </details>
    </>
  );
}

function EdgeInspector({
  edge,
  graph,
  execute,
  pending,
  select,
}: Props & { edge: Edge }) {
  const [revision, setRevision] = useState(graph.revision);
  const [relation, setRelation] = useState(edge.relation);
  const [rationale, setRationale] = useState("");
  const [state, setState] = useState(edge.state);
  const currentRelation = graph.taxonomy.relations.find(
    (item) => item.id === edge.relation,
  );
  const title = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.title ?? id;
  return (
    <>
      <div className="edge-direction">
        <button onClick={() => select({ kind: "node", id: edge.source })}>
          {title(edge.source)}
        </button>
        <span>↓ {currentRelation?.label ?? edge.relation}</span>
        <button onClick={() => select({ kind: "node", id: edge.target })}>
          {title(edge.target)}
        </button>
      </div>
      <div className="badges">
        <span>
          {edge.state === "disputed"
            ? "Disputed"
            : edge.correction
              ? "User-corrected"
              : "Asserted"}
        </span>
        <span
          className={
            currentRelation?.blocking && edge.state === "asserted"
              ? "blocking"
              : ""
          }
        >
          {currentRelation?.blocking && edge.state === "asserted"
            ? "Claimed prerequisite"
            : "Not a hard blocker"}
        </span>
      </div>
      <p className="interpretation">{currentRelation?.definition}</p>
      <h3>Current rationale</h3>
      <p className="preserve-text">
        {edge.rationale || "No rationale recorded."}
      </p>
      <p className="meta">
        {edge.updated.actor.id} · {edge.updated.actor.channel} · revision{" "}
        {edge.updated.revision}
      </p>
      <section className="inspector-section">
        <h3>Reframe this relationship</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const panel = event.currentTarget.closest("aside");
            void execute(
              { type: "edge.reframe", id: edge.id, relation, rationale, state },
              revision,
            ).then((saved) => {
              if (saved) {
                setRevision(revision + 1);
                setRationale("");
                panel?.scrollTo({ top: 0 });
              }
            });
          }}
        >
          <RelationSelect
            label="Reframe as"
            taxonomy={graph.taxonomy}
            value={relation}
            onChange={setRelation}
          />
          <label>
            Assertion state
            <select
              value={state}
              onChange={(event) =>
                setState(event.target.value as Edge["state"])
              }
            >
              <option value="asserted">Asserted</option>
              <option value="disputed">Disputed · remove blocking force</option>
            </select>
          </label>
          <label>
            Reason for this correction
            <textarea
              required
              maxLength={2000}
              rows={3}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="What changes your understanding?"
            />
          </label>
          <p className="hint">
            Reframing preserves both ideas, their sources, and the original
            assertion. It does not complete either intention.
          </p>
          <button className="primary" disabled={pending || !rationale.trim()}>
            Save reframe
          </button>
        </form>
      </section>
      <section className="inspector-section original">
        <h3>Original assertion</h3>
        <strong>
          {graph.taxonomy.relations.find(
            (item) => item.id === edge.assertion.relation,
          )?.label ?? edge.assertion.relation}
        </strong>
        <p className="preserve-text">
          {edge.assertion.rationale || "No original rationale recorded."}
        </p>
        <p className="meta">
          {edge.assertion.provenance.actor.id} ·{" "}
          {edge.assertion.provenance.actor.channel} · revision{" "}
          {edge.assertion.provenance.revision}
        </p>
      </section>
      <HistoryPanel
        graph={graph}
        execute={execute}
        pending={pending}
        edgeId={edge.id}
      />
    </>
  );
}

function SuggestionInspector({
  suggestion,
  graph,
  execute,
  pending,
}: Props & { suggestion: Graph["suggestions"][number] }) {
  const [revision] = useState(graph.revision);
  const [rationale, setRationale] = useState("");
  const title = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.title ?? id;
  return (
    <>
      <h2>
        {title(suggestion.source)} → {title(suggestion.target)}
      </h2>
      <div className="badges">
        <span>Machine suggestion</span>
        <span>{suggestion.status}</span>
      </div>
      <h3>
        {
          graph.taxonomy.relations.find(
            (relation) => relation.id === suggestion.relation,
          )?.label
        }
      </h3>
      <p className="interpretation">
        A proposal, not a dependency or permission. Accepting explicitly creates
        an assertion; existing assertions cannot be overwritten.
      </p>
      <p>{suggestion.rationale}</p>
      <p>
        Confidence:{" "}
        {suggestion.confidence === null
          ? "not supplied"
          : `${Math.round(suggestion.confidence * 100)}%`}
      </p>
      <h3>Evidence</h3>
      <ul>
        {suggestion.evidence.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      <p className="meta">
        Model: {suggestion.model}
        <br />
        Prompt: {suggestion.promptVersion}
        <br />
        Taxonomy: {suggestion.taxonomyVersion}
        <br />
        Input revision: {suggestion.basedOnRevision}
      </p>
      {suggestion.status === "pending" && (
        <>
          <label>
            Decision rationale
            <textarea
              value={rationale}
              maxLength={2000}
              onChange={(event) => setRationale(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              disabled={pending}
              onClick={() =>
                void execute(
                  {
                    type: "suggestion.decide",
                    id: suggestion.id,
                    decision: "accept",
                    rationale,
                  },
                  revision,
                )
              }
            >
              Accept suggestion
            </button>
            <button
              disabled={pending}
              onClick={() =>
                void execute(
                  {
                    type: "suggestion.decide",
                    id: suggestion.id,
                    decision: "reject",
                    rationale,
                  },
                  revision,
                )
              }
            >
              Decline
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function HistoryPanel({
  graph,
  execute,
  pending,
  edgeId,
}: EditorProps & { edgeId?: string }) {
  const [entries, setEntries] = useState<readonly HistoryEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void history()
      .then((value) => {
        if (active) {
          setEntries(value);
          setError("");
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [graph.revision]);
  const shown = entries
    .filter(
      (entry) =>
        !edgeId ||
        (entry.command.type === "edge.put" &&
          entry.command.edge.id === edgeId) ||
        (entry.command.type === "edge.reframe" &&
          entry.command.id === edgeId) ||
        (entry.command.type === "capture" &&
          entry.command.edges.some((edge) => edge.id === edgeId)) ||
        entry.command.type === "undo",
    )
    .reverse();
  return (
    <section className="inspector-section">
      <h3>History</h3>
      {loading && <p role="status">Loading history…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !shown.length && <p className="hint">No edits yet.</p>}
      {shown.map((entry) => (
        <div className="history-entry" key={entry.revision}>
          <div>
            <strong>{entry.type}</strong>
            <span className="meta">
              r{entry.revision} · {entry.actor.id} · {entry.actor.channel}
            </span>
          </div>
          <time className="meta">{new Date(entry.at).toLocaleString()}</time>
          {entry.command.type === "edge.reframe" && (
            <p>
              {entry.command.relation}: {entry.command.rationale}
            </p>
          )}
          {entry.revision === graph.revision && (
            <button
              disabled={pending}
              onClick={() =>
                void execute(
                  { type: "undo", revision: entry.revision },
                  entry.revision,
                )
              }
            >
              Undo revision {entry.revision}
            </button>
          )}
        </div>
      ))}
      <p className="hint">
        Undo is revision-checked. Intervening edits must never be overwritten.
      </p>
    </section>
  );
}

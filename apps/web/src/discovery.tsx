import { useEffect, useState } from "react";
import { Schema } from "effect";
import type { Graph } from "@yakjev/protocol";
import { ApiFailure, errorMessage, request } from "./api";
import type { Selection } from "./graph-model";

const Coverage = Schema.Struct({
  eligible: Schema.Number,
  considered: Schema.Number,
  limit: Schema.Number,
  truncated: Schema.Boolean,
  strategy: Schema.String,
});
const Discovery = Schema.Struct({
  basedOnRevision: Schema.Number,
  coverage: Coverage,
  candidates: Schema.Array(
    Schema.Struct({
      nodeId: Schema.String,
      lexicalScore: Schema.Number,
      sharedTokens: Schema.Array(Schema.String),
      via: Schema.String,
    }),
  ),
});
const EvaluationResult = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["succeeded", "failed", "unavailable"]),
  basedOnRevision: Schema.Number,
  taxonomyVersion: Schema.Number,
  inputHash: Schema.String,
  promptVersion: Schema.String,
  requestedModel: Schema.String,
  resolvedModel: Schema.NullOr(Schema.String),
  coverage: Coverage,
  elapsedMs: Schema.Number,
  judgments: Schema.Array(
    Schema.Struct({
      nodeId: Schema.String,
      relatedness: Schema.Number,
      match: Schema.Boolean,
      relation: Schema.NullOr(Schema.String),
      direction: Schema.NullOr(Schema.String),
      confidence: Schema.NullOr(Schema.Number),
      suppressed: Schema.Boolean,
    }),
  ),
  failure: Schema.NullOr(
    Schema.Struct({ code: Schema.String, message: Schema.String }),
  ),
  rawResponse: Schema.Json,
});

export function RelatedHints({
  query,
  graph,
}: {
  query: string;
  graph: Graph;
}) {
  const [result, setResult] = useState<typeof Discovery.Type | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setResult(null);
    setError("");
    if (!query.trim()) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      void request(`/api/discovery?query=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted)
            setResult(Schema.decodeUnknownSync(Discovery)(value));
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(cause));
        });
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, graph.revision]);
  const hints =
    result?.candidates
      .filter((candidate) => candidate.lexicalScore > 0)
      .slice(0, 5) ?? [];
  if (!query.trim()) return null;
  return (
    <section className="related-hints">
      <h3>Possibly related</h3>
      <p className="hint">
        Shared words, not inferred dependencies. Captures stay separate.
      </p>
      {error && (
        <p className="hint" role="status">
          Related lookup unavailable: {error}
        </p>
      )}
      {result && !hints.length && (
        <p className="hint">No shared-word matches.</p>
      )}
      {hints.map((hint) => (
        <details key={hint.nodeId} className="connection-card">
          <summary>
            {graph.nodes.find((node) => node.id === hint.nodeId)?.title}
          </summary>
          <p className="hint">
            {graph.nodes.find((node) => node.id === hint.nodeId)?.description}
          </p>
          <small>Shared: {hint.sharedTokens.join(", ")}</small>
        </details>
      ))}
    </section>
  );
}

export function DiscoveryPanel({
  graph,
  select,
  refresh,
  focusNodeId,
}: {
  graph: Graph;
  select: (selection: Selection) => void;
  refresh: () => Promise<Graph>;
  focusNodeId?: string;
}) {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(focusNodeId ?? "");
  const [evaluating, setEvaluating] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<typeof EvaluationResult.Type | null>(
    null,
  );
  const [loadingId, setLoadingId] = useState("");
  const title = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.title ?? id;
  async function load(id: string) {
    setLoadingId(id);
    setError("");
    try {
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ result: EvaluationResult }),
      )(await request(`/api/evaluations/${encodeURIComponent(id)}`));
      setResult(envelope.result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingId("");
    }
  }
  async function evaluate() {
    setEvaluating(true);
    setError("");
    setStatus("Evaluating… No suggestions have been accepted.");
    try {
      const response = Schema.decodeUnknownSync(
        Schema.Struct({ evaluationId: Schema.String }),
      )(
        await request("/api/evaluations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            expectedRevision: graph.revision,
            query,
            ...(focus ? { focusNodeId: focus } : {}),
          }),
        }),
      );
      await refresh();
      await load(response.evaluationId);
      setStatus(
        "Evaluation recorded. Review results before accepting a suggestion.",
      );
    } catch (cause) {
      setStatus("");
      setError(
        cause instanceof ApiFailure && cause.status === 409
          ? `Evaluation stale: the graph changed. No result was applied. Evaluate again against the current graph. ${cause.message}`
          : `Evaluation unavailable: ${errorMessage(cause)}`,
      );
      await refresh().catch(() => {});
    } finally {
      setEvaluating(false);
    }
  }
  return (
    <>
      <p className="eyebrow">REVIEW, THEN DECIDE</p>
      <h2>Jev &amp; discovery</h2>
      <p className="hint">
        Jev reranks up to 24 lexical and graph candidates. This is not a global
        semantic index; scores are relevance, never priority.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void evaluate();
        }}
      >
        <label>
          Evaluate connections for
          <select
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
          >
            <option value="">Search without a focus intention</option>
            {graph.nodes
              .filter((node) => node.status !== "archived")
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.title}
                </option>
              ))}
          </select>
        </label>
        <label>
          Search context
          <textarea
            value={query}
            maxLength={2000}
            required={!focus}
            rows={3}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              focus ? "Optional context" : "What are you looking for?"
            }
          />
        </label>
        <button
          className="primary"
          disabled={evaluating || (!focus && !query.trim())}
        >
          {evaluating ? "Evaluating…" : "Evaluate with Jev"}
        </button>
      </form>
      {status && (
        <p role="status" className="hint">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="interpretation">
          {error}
        </p>
      )}
      {result && (
        <section className="inspector-section">
          <h3>Evaluation · {result.status}</h3>
          {result.failure && (
            <p role="status">
              {result.failure.message} ({result.failure.code})
            </p>
          )}
          <p className="hint">
            Coverage: {result.coverage.considered} of {result.coverage.eligible}{" "}
            eligible nodes
            {result.coverage.truncated
              ? " · bounded shortlist, more nodes may be relevant"
              : " · all eligible nodes considered"}
            .
          </p>
          {result.judgments.map((judgment) => (
            <button
              className="connection-card"
              key={judgment.nodeId}
              onClick={() => select({ kind: "node", id: judgment.nodeId })}
            >
              <span>{title(judgment.nodeId)}</span>
              <small>
                {judgment.match
                  ? `${Math.round(judgment.relatedness * 100)}% relatedness`
                  : "No match"}
                {judgment.relation ? ` · ${judgment.relation}` : ""}
                {judgment.suppressed ? " · existing assertion preserved" : ""}
              </small>
            </button>
          ))}
          <p className="meta">
            {result.resolvedModel ?? result.requestedModel} · {result.elapsedMs}
            ms
            <br />
            Input r{result.basedOnRevision} · taxonomy v{result.taxonomyVersion}
            <br />
            Prompt {result.promptVersion}
            <br />
            Input hash {result.inputHash}
          </p>
          <details>
            <summary>Recorded probabilities and evidence</summary>
            <pre className="json-evidence">
              {JSON.stringify(result.rawResponse, null, 2)}
            </pre>
          </details>
        </section>
      )}
      <section className="inspector-section">
        <h3>Suggestions</h3>
        <p className="hint">Proposals only. Confidence is not permission.</p>
        {!graph.suggestions.length && (
          <p className="hint">No suggestions recorded yet.</p>
        )}
        {graph.suggestions.map((suggestion) => (
          <button
            className="connection-card"
            key={suggestion.id}
            onClick={() => select({ kind: "suggestion", id: suggestion.id })}
          >
            <span>
              {title(suggestion.source)} → {title(suggestion.target)}
            </span>
            <small>
              {suggestion.relation} · {suggestion.status}
            </small>
          </button>
        ))}
      </section>
      <section className="inspector-section">
        <h3>Past evaluations</h3>
        {!graph.evaluations.length && (
          <p className="hint">No evaluations yet.</p>
        )}
        {[...graph.evaluations].reverse().map((evaluation) => (
          <button
            className="connection-card"
            key={evaluation.id}
            disabled={loadingId === evaluation.id}
            onClick={() => void load(evaluation.id)}
          >
            <span>
              {loadingId === evaluation.id
                ? "Loading…"
                : `Evaluation · input r${evaluation.basedOnRevision}`}
            </span>
            <small>
              Taxonomy v{evaluation.taxonomyVersion} · recorded r
              {evaluation.provenance.revision}
            </small>
          </button>
        ))}
      </section>
    </>
  );
}

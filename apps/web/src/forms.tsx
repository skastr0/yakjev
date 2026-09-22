import { useState } from "react";
import type { Command, Graph, Node, Taxonomy } from "@yakjev/protocol";
import { safeSourceHref } from "./graph-model";

export type Execute = (command: Command, revision: number) => Promise<boolean>;
export type EditorProps = { graph: Graph; execute: Execute; pending: boolean };

export function Sources({ sources }: { sources: Node["sources"] }) {
  return (
    <ul className="sources">
      {sources.map((source, index) => (
        <li key={`${source.uri}-${index}`}>
          {safeSourceHref(source.uri) ? (
            <a
              href={safeSourceHref(source.uri)}
              target="_blank"
              rel="noreferrer"
            >
              {source.label || source.uri} ↗
            </a>
          ) : (
            <span>
              {source.label && `${source.label} · `}
              <code>{source.uri}</code>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SourceFields({
  sources,
  setSources,
}: {
  sources: Node["sources"];
  setSources: (value: Node["sources"]) => void;
}) {
  return (
    <fieldset className="source-fields">
      <legend>Source references</legend>
      <p className="hint">
        Links and identifiers only. Full documents stay in their canonical
        stores.
      </p>
      {sources.map((source, index) => (
        <div className="source-row" key={index}>
          <label>
            Reference {index + 1}
            <input
              value={source.uri}
              required
              maxLength={2048}
              placeholder="https://… or source identifier"
              onChange={(event) =>
                setSources(
                  sources.map((item, i) =>
                    i === index ? { ...item, uri: event.target.value } : item,
                  ),
                )
              }
            />
          </label>
          <label>
            Label {index + 1}
            <input
              value={source.label}
              maxLength={240}
              placeholder="Session, plan, repository…"
              onChange={(event) =>
                setSources(
                  sources.map((item, i) =>
                    i === index ? { ...item, label: event.target.value } : item,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() => setSources(sources.filter((_, i) => i !== index))}
          >
            Remove reference {index + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={sources.length >= 40}
        onClick={() => setSources([...sources, { uri: "", label: "" }])}
      >
        + Add source reference
      </button>
    </fieldset>
  );
}

export function NodeForm({
  graph,
  execute,
  pending,
  node,
  saved,
  related,
}: EditorProps & {
  node?: Node;
  saved: (id: string) => void;
  related?: (query: string) => void;
}) {
  const [revision] = useState(graph.revision);
  const [title, setTitle] = useState(node?.title ?? "");
  const [description, setDescription] = useState(node?.description ?? "");
  const [project, setProject] = useState(node?.project ?? "");
  const [status, setStatus] = useState<Node["status"]>(node?.status ?? "idea");
  const [sources, setSources] = useState<Node["sources"]>(node?.sources ?? []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          const id = node?.id ?? crypto.randomUUID();
          const input = {
            id,
            title: title.trim(),
            description,
            project,
            status,
            sources,
          };
          const command: Command = node
            ? { type: "node.put", node: input }
            : {
                type: "capture",
                capture: {
                  id: crypto.randomUUID(),
                  text: `${title.trim()}${description ? `\n\n${description}` : ""}`,
                  sources,
                  nodeIds: [id],
                },
                nodes: [input],
                edges: [],
              };
          if (await execute(command, node ? revision : graph.revision))
            saved(id);
        })();
      }}
    >
      <label>
        Title
        <input
          autoFocus
          name="title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            related?.(event.target.value);
          }}
          required
          maxLength={240}
          placeholder="An idea, an intention, a knot…"
        />
      </label>
      <label>
        Context
        <textarea
          name="context"
          value={description}
          maxLength={2000}
          rows={4}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What matters? Why did this come up?"
        />
      </label>
      <div className="field-pair">
        <label>
          Project
          <input
            name="project"
            value={project}
            maxLength={240}
            onChange={(event) => setProject(event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as Node["status"])
            }
          >
            <option value="idea">Idea</option>
            <option value="active">Active</option>
            <option value="done">Done</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </div>
      <SourceFields sources={sources} setSources={setSources} />
      {node && (
        <p className="hint">
          Completion and archive affect this graph only. Source documents are
          never deleted.
        </p>
      )}
      <button className="primary" disabled={pending || !title.trim()}>
        {pending ? "Saving…" : node ? "Save node" : "Capture intention"}
      </button>
    </form>
  );
}

export function RelationSelect({
  taxonomy,
  value,
  onChange,
  label = "Relationship",
}: {
  taxonomy: Taxonomy;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {taxonomy.relations.map((relation) => (
          <option key={relation.id} value={relation.id}>
            {relation.label}
            {relation.blocking
              ? " · claimed prerequisite"
              : " · not a hard blocker"}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ConnectForm({
  graph,
  execute,
  pending,
  sourceId,
  saved,
}: EditorProps & { sourceId: string; saved: (id: string) => void }) {
  const [revision] = useState(graph.revision);
  const [target, setTarget] = useState("");
  const [relation, setRelation] = useState(
    graph.taxonomy.relations[0]?.id ?? "requires",
  );
  const [rationale, setRationale] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          const id = crypto.randomUUID();
          if (
            await execute(
              {
                type: "edge.put",
                edge: { id, source: sourceId, target, relation, rationale },
              },
              revision,
            )
          )
            saved(id);
        })();
      }}
    >
      <p className="hint">
        Source → target. “Requires” means this intention claims to need the
        target. Cycles are allowed.
      </p>
      <label>
        Connect to
        <select
          required
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">Choose an intention…</option>
          {graph.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
              {node.id === sourceId ? " (self)" : ""}
            </option>
          ))}
        </select>
      </label>
      <RelationSelect
        taxonomy={graph.taxonomy}
        value={relation}
        onChange={setRelation}
      />
      <label>
        Why does this connection exist?
        <textarea
          value={rationale}
          maxLength={2000}
          rows={3}
          onChange={(event) => setRationale(event.target.value)}
        />
      </label>
      <button className="primary" disabled={pending || !target}>
        Assert connection
      </button>
    </form>
  );
}

export function TaxonomyForm({
  graph,
  execute,
  pending,
  saved,
}: EditorProps & { saved: () => void }) {
  const [revision] = useState(graph.revision);
  const [relations, setRelations] = useState(graph.taxonomy.relations);
  const change = (
    index: number,
    patch: Partial<Taxonomy["relations"][number]>,
  ) =>
    setRelations(
      relations.map((relation, i) =>
        i === index ? { ...relation, ...patch } : relation,
      ),
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void execute({ type: "taxonomy.replace", relations }, revision).then(
          (ok) => {
            if (ok) saved();
          },
        );
      }}
    >
      <p className="hint">
        Version {graph.taxonomy.version}. Definitions guide Jev. Changing them
        does not erase prior judgments or user corrections.
      </p>
      {relations.map((relation, index) => (
        <fieldset key={index}>
          <legend>{relation.id}</legend>
          <label>
            Relation name
            <input
              required
              maxLength={240}
              value={relation.label}
              onChange={(event) => change(index, { label: event.target.value })}
            />
          </label>
          <label>
            Definition
            <textarea
              rows={3}
              maxLength={2000}
              value={relation.definition}
              onChange={(event) =>
                change(index, { definition: event.target.value })
              }
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={relation.blocking}
              onChange={(event) =>
                change(index, { blocking: event.target.checked })
              }
            />
            Claimed necessary prerequisite
          </label>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={relations.length >= 40}
        onClick={() =>
          setRelations([
            ...relations,
            {
              id: `relation-${crypto.randomUUID()}`,
              label: "New relation",
              definition: "",
              blocking: false,
            },
          ])
        }
      >
        + Add relation
      </button>
      <button className="primary" disabled={pending}>
        Save taxonomy
      </button>
    </form>
  );
}

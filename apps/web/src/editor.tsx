import { useEffect, useState } from "react";
import type { Command, Graph, Node } from "@yakjev/protocol";
import {
  addRelation,
  assertEdge,
  captureIntention,
  decideSuggestion,
  reframeEdge,
  removeEdge,
  removeNode,
  updateNode,
} from "./graph-commands";
import { safeSourceHref, type Selection } from "./graph-model";
import { PALETTE } from "./blend";

export type Mode =
  | { kind: "create"; x: number; y: number }
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "suggestion"; id: string }
  | { kind: "assert"; source: string; target: string };

type Execute = (command: Command, revision: number) => Promise<boolean>;
type Point = { x: number; y: number };

const STATUSES: Node["status"][] = ["idea", "active", "done", "archived"];

export function GraphEditor({
  graph,
  mode,
  anchor,
  execute,
  onClose,
  onCreated,
  onAsserted,
  onFocus,
  onAskJev,
  focused,
  paint,
  onPaint,
}: {
  graph: Graph;
  mode: Mode;
  anchor: Point | null;
  execute: Execute;
  onClose: () => void;
  onCreated: (id: string) => void;
  onAsserted: (id: string) => void;
  onFocus: (id: string) => void;
  onAskJev: (id: string) => void;
  focused: boolean;
  paint: Readonly<Record<string, string>>;
  onPaint: (id: string, color: string) => void;
}) {
  if (!anchor) return null;
  const style = placeCard(anchor, mode.kind);
  return (
    <div
      className="graph-editor"
      style={style}
      role="dialog"
      aria-label={labelFor(mode)}
    >
      {mode.kind === "create" && (
        <Create
          revision={graph.revision}
          execute={execute}
          onClose={onClose}
          onCreated={onCreated}
          onPaint={onPaint}
        />
      )}
      {mode.kind === "node" && (
        <NodeCard
          graph={graph}
          id={mode.id}
          execute={execute}
          focused={focused}
          onFocus={onFocus}
          onAskJev={onAskJev}
          onClose={onClose}
          color={paint[mode.id] ?? null}
          onPaint={onPaint}
        />
      )}
      {mode.kind === "edge" && (
        <EdgeCard
          graph={graph}
          id={mode.id}
          execute={execute}
          onClose={onClose}
        />
      )}
      {mode.kind === "suggestion" && (
        <SuggestionCard
          graph={graph}
          id={mode.id}
          execute={execute}
          onClose={onClose}
        />
      )}
      {mode.kind === "assert" && (
        <AssertCard
          graph={graph}
          source={mode.source}
          target={mode.target}
          execute={execute}
          onAsserted={onAsserted}
        />
      )}
    </div>
  );
}

function Create({
  revision,
  execute,
  onClose,
  onCreated,
  onPaint,
}: {
  revision: number;
  execute: Execute;
  onClose: () => void;
  onCreated: (id: string) => void;
  onPaint: (id: string, color: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [color, setColor] = useState<string>(PALETTE[0].hex);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const built = captureIntention(title);
        if (!built) return;
        void execute(built.command, revision).then((ok) => {
          if (!ok) return;
          onPaint(built.nodeId, color);
          onCreated(built.nodeId);
        });
      }}
    >
      <input
        autoFocus
        aria-label="Intention"
        value={title}
        maxLength={240}
        placeholder="An intention"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      />
      <Swatches value={color} onChange={setColor} />
    </form>
  );
}

function NodeCard({
  graph,
  id,
  execute,
  focused,
  onFocus,
  onAskJev,
  onClose,
  color,
  onPaint,
}: {
  graph: Graph;
  id: string;
  execute: Execute;
  focused: boolean;
  onFocus: (id: string) => void;
  onAskJev: (id: string) => void;
  onClose: () => void;
  color: string | null;
  onPaint: (id: string, color: string) => void;
}) {
  const node = graph.nodes.find((item) => item.id === id);
  const [title, setTitle] = useState(node?.title ?? "");
  const [project, setProject] = useState(node?.project ?? "");
  const [description, setDescription] = useState(node?.description ?? "");
  const [source, setSource] = useState("");
  useEffect(() => {
    if (!node) return;
    setTitle(node.title);
    setProject(node.project);
    setDescription(node.description);
  }, [
    node?.id,
    node?.title,
    node?.project,
    node?.description,
    node?.updated.revision,
  ]);
  if (!node) return null;
  const save = (patch: Parameters<typeof updateNode>[1]) => {
    const command = updateNode(node, patch);
    if (command) void execute(command, graph.revision);
  };
  return (
    <div>
      <input
        aria-label="Title"
        value={title}
        maxLength={240}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (title.trim() && title.trim() !== node.title) save({ title });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") onClose();
        }}
      />
      <input
        aria-label="Project"
        value={project}
        maxLength={240}
        placeholder="Project"
        onChange={(event) => setProject(event.target.value)}
        onBlur={() => {
          if (project !== node.project) save({ project });
        }}
      />
      <input
        aria-label="Context"
        value={description}
        maxLength={2000}
        placeholder="Context"
        onChange={(event) => setDescription(event.target.value)}
        onBlur={() => {
          if (description !== node.description) save({ description });
        }}
      />
      <div className="chip-row" role="group" aria-label="Status">
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={node.status === status}
            onClick={() => {
              if (node.status !== status) save({ status });
            }}
          >
            {status}
          </button>
        ))}
      </div>
      <Swatches value={color} onChange={(hex) => onPaint(node.id, hex)} />
      {node.sources.length > 0 && (
        <ul className="source-links">
          {node.sources.map((item, index) => {
            const href = safeSourceHref(item.uri);
            return (
              <li key={`${item.uri}-${index}`}>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {item.label || item.uri}
                  </a>
                ) : (
                  <span>{item.label || item.uri}</span>
                )}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    save({
                      sources: node.sources.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const uri = source.trim();
          if (!uri) return;
          save({ sources: [...node.sources, { uri, label: "" }] });
          setSource("");
        }}
      >
        <input
          aria-label="Source"
          value={source}
          maxLength={2048}
          placeholder="Source URL or identifier"
          onChange={(event) => setSource(event.target.value)}
        />
      </form>
      <div className="chip-row">
        <button type="button" onClick={() => onFocus(node.id)}>
          {focused ? "Whole graph" : "Neighborhood"}
        </button>
        <button type="button" onClick={() => onAskJev(node.id)}>
          Ask Jev
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            void execute(removeNode(node.id), graph.revision).then((ok) => {
              if (ok) onClose();
            });
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function EdgeCard({
  graph,
  id,
  execute,
  onClose,
}: {
  graph: Graph;
  id: string;
  execute: Execute;
  onClose: () => void;
}) {
  const edge = graph.edges.find((item) => item.id === id);
  const [rationale, setRationale] = useState(edge?.rationale ?? "");
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (edge) setRationale(edge.rationale);
  }, [edge?.id, edge?.rationale, edge?.updated.revision]);
  if (!edge) return null;
  const title = (nodeId: string) =>
    graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId;
  const apply = (patch: Parameters<typeof reframeEdge>[1]) => {
    void execute(reframeEdge(edge, patch), graph.revision);
  };
  return (
    <div>
      <p className="editor-claim">
        {title(edge.source)} → {title(edge.target)}
      </p>
      <RelationChoices
        graph={graph}
        selected={edge.relation}
        onChoose={(relation) => {
          if (relation !== edge.relation) apply({ relation, rationale });
        }}
      />
      {adding ? (
        <input
          autoFocus
          aria-label="New relation"
          value={label}
          placeholder="New relation"
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setAdding(false);
            if (event.key !== "Enter") return;
            event.preventDefault();
            const command = addRelation(graph.taxonomy, label);
            if (command.type !== "taxonomy.replace") return;
            void execute(command, graph.revision).then((ok) => {
              if (!ok) return;
              setAdding(false);
              setLabel("");
            });
          }}
        />
      ) : (
        <button
          type="button"
          className="text-button"
          onClick={() => setAdding(true)}
        >
          + Type
        </button>
      )}
      <input
        aria-label="Rationale"
        value={rationale}
        maxLength={2000}
        placeholder="Why this claim"
        onChange={(event) => setRationale(event.target.value)}
        onBlur={() => {
          if (rationale.trim() && rationale.trim() !== edge.rationale)
            apply({ rationale });
        }}
      />
      <div className="chip-row">
        <button
          type="button"
          aria-pressed={edge.state === "disputed"}
          onClick={() =>
            apply({
              state: edge.state === "disputed" ? "asserted" : "disputed",
              rationale,
            })
          }
        >
          {edge.state === "disputed" ? "Assert" : "Dispute"}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            void execute(removeEdge(edge.id), graph.revision).then((ok) => {
              if (ok) onClose();
            });
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function AssertCard({
  graph,
  source,
  target,
  execute,
  onAsserted,
}: {
  graph: Graph;
  source: string;
  target: string;
  execute: Execute;
  onAsserted: (id: string) => void;
}) {
  const [rationale, setRationale] = useState("");
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const title = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.title ?? id;
  const choose = (relation: string) => {
    const built = assertEdge(source, target, relation, rationale);
    void execute(built.command, graph.revision).then((ok) => {
      if (ok) onAsserted(built.edgeId);
    });
  };
  return (
    <div>
      <p className="editor-claim">
        {title(source)} → {title(target)}
      </p>
      <RelationChoices graph={graph} selected={null} onChoose={choose} />
      {adding ? (
        <input
          autoFocus
          aria-label="New relation"
          value={label}
          placeholder="New relation"
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setAdding(false);
            if (event.key !== "Enter") return;
            event.preventDefault();
            const command = addRelation(graph.taxonomy, label);
            if (command.type !== "taxonomy.replace") return;
            const relation = command.relations.at(-1);
            void execute(command, graph.revision).then((ok) => {
              if (ok && relation) choose(relation.id);
            });
          }}
        />
      ) : (
        <button
          type="button"
          className="text-button"
          onClick={() => setAdding(true)}
        >
          + Type
        </button>
      )}
      <input
        aria-label="Rationale"
        value={rationale}
        maxLength={2000}
        placeholder="Why this claim"
        onChange={(event) => setRationale(event.target.value)}
      />
    </div>
  );
}

function SuggestionCard({
  graph,
  id,
  execute,
  onClose,
}: {
  graph: Graph;
  id: string;
  execute: Execute;
  onClose: () => void;
}) {
  const suggestion = graph.suggestions.find((item) => item.id === id);
  if (!suggestion || suggestion.status !== "pending") return null;
  const title = (nodeId: string) =>
    graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId;
  const relation =
    graph.taxonomy.relations.find((item) => item.id === suggestion.relation)
      ?.label ?? suggestion.relation;
  return (
    <div>
      <p className="editor-claim">Suggestion · not an assertion</p>
      <p>
        {title(suggestion.source)} → {relation} → {title(suggestion.target)}
      </p>
      <p className="editor-note">{suggestion.rationale}</p>
      <div className="chip-row">
        <button
          type="button"
          className="primary"
          onClick={() => {
            void execute(decideSuggestion(id, "accept"), graph.revision).then(
              (ok) => {
                if (ok) onClose();
              },
            );
          }}
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => {
            void execute(decideSuggestion(id, "reject"), graph.revision).then(
              (ok) => {
                if (ok) onClose();
              },
            );
          }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function RelationChoices({
  graph,
  selected,
  onChoose,
}: {
  graph: Graph;
  selected: string | null;
  onChoose: (relation: string) => void;
}) {
  return (
    <div className="chip-row" role="group" aria-label="Relationship">
      {graph.taxonomy.relations.map((relation) => (
        <button
          key={relation.id}
          type="button"
          aria-pressed={selected === relation.id}
          data-relation={relation.id}
          data-blocking={relation.blocking ? "true" : "false"}
          onClick={() => onChoose(relation.id)}
        >
          {relation.label}
        </button>
      ))}
    </div>
  );
}

function Swatches({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="chip-row" role="group" aria-label="Color">
      {PALETTE.map((swatch) => (
        <button
          key={swatch.id}
          type="button"
          className="swatch"
          aria-label={swatch.id}
          aria-pressed={value === swatch.hex}
          style={{ background: swatch.hex }}
          onClick={() => onChange(swatch.hex)}
        />
      ))}
    </div>
  );
}

function placeCard(
  anchor: Point,
  kind?: Mode["kind"],
): { left: number; top: number } {
  const margin = 12;
  const innerW = typeof window !== "undefined" ? window.innerWidth : 1024;
  const innerH = typeof window !== "undefined" ? window.innerHeight : 768;
  const cardWidth = Math.min(300, Math.max(0, innerW - margin * 2));
  const cardHeight =
    kind === "create" ? 80 : Math.min(320, Math.max(0, innerH - margin * 2));

  const isCenter =
    Math.abs(anchor.x - innerW / 2) <= 16 &&
    Math.abs(anchor.y - innerH / 2) <= 16;

  let left: number;
  let top: number;

  if (isCenter) {
    left = Math.round((innerW - cardWidth) / 2);
    top = Math.round((innerH - cardHeight) / 2);
  } else {
    left = anchor.x + 16;
    if (left + cardWidth > innerW - margin) {
      left = anchor.x - cardWidth - 16;
    }
    top = anchor.y - 12;
    if (top + cardHeight > innerH - margin) {
      top = anchor.y - cardHeight - 12;
    }
  }

  const maxLeft = Math.max(margin, innerW - margin - cardWidth);
  const maxTop = Math.max(margin, innerH - margin - cardHeight);

  left = Math.min(Math.max(margin, left), maxLeft);
  top = Math.min(Math.max(margin, top), maxTop);

  return { left, top };
}

function labelFor(mode: Mode) {
  if (mode.kind === "create") return "Capture intention";
  if (mode.kind === "assert") return "Claim a relationship";
  if (mode.kind === "edge") return "Relationship";
  if (mode.kind === "suggestion") return "Suggestion";
  return "Intention";
}

export function selectionMode(selection: Selection): Mode | null {
  if (!selection) return null;
  if (selection.kind === "node") return { kind: "node", id: selection.id };
  if (selection.kind === "edge") return { kind: "edge", id: selection.id };
  return { kind: "suggestion", id: selection.id };
}

import { Schema } from "effect";

export const Id = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
);
export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ShortText = Schema.String.check(Schema.isMaxLength(2000));
const Title = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(240),
);
export const Source = Schema.Struct({
  uri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  label: Schema.String.check(Schema.isMaxLength(240)),
});
export const Actor = Schema.Struct({
  id: Id,
  channel: Schema.Literals(["browser", "mcp", "system"]),
});
export type Actor = typeof Actor.Type;
export const Provenance = Schema.Struct({
  actor: Actor,
  at: Schema.String,
  revision: Revision,
});
export const Position = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  pinned: Schema.Boolean,
});
export const NodeInput = Schema.Struct({
  id: Id,
  title: Title,
  description: ShortText,
  project: Schema.String.check(Schema.isMaxLength(240)),
  status: Schema.Literals(["idea", "active", "done", "archived"]),
  sources: Schema.Array(Source).check(Schema.isMaxLength(40)),
});
export const Node = Schema.Struct({
  ...NodeInput.fields,
  position: Schema.NullOr(Position),
  created: Provenance,
  updated: Provenance,
});
export type Node = typeof Node.Type;
export const Relation = Schema.Struct({
  id: Id,
  label: Title,
  definition: ShortText,
  blocking: Schema.Boolean,
});
export const Taxonomy = Schema.Struct({
  version: Revision,
  relations: Schema.Array(Relation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(40),
  ),
});
export type Taxonomy = typeof Taxonomy.Type;
export const EdgeInput = Schema.Struct({
  id: Id,
  // Directed claim: source requires target, never the other way around.
  source: Id,
  target: Id,
  relation: Id,
  rationale: ShortText,
});
export const Assertion = Schema.Struct({
  relation: Id,
  rationale: ShortText,
  provenance: Provenance,
});
export const Correction = Schema.Struct({
  ...Assertion.fields,
  state: Schema.Literals(["asserted", "disputed"]),
});
export const Edge = Schema.Struct({
  ...EdgeInput.fields,
  state: Schema.Literals(["asserted", "disputed"]),
  assertion: Assertion,
  correction: Schema.NullOr(Correction),
  updated: Provenance,
  suggestionId: Schema.optionalKey(Id),
});
export type Edge = typeof Edge.Type;
export const CaptureInput = Schema.Struct({
  id: Id,
  text: Schema.String.check(Schema.isMaxLength(8000)),
  sources: Schema.Array(Source).check(Schema.isMaxLength(40)),
  nodeIds: Schema.Array(Id).check(Schema.isMaxLength(100)),
});
export const Capture = Schema.Struct({
  ...CaptureInput.fields,
  provenance: Provenance,
});
export const SuggestionInput = Schema.Struct({
  id: Id,
  source: Id,
  target: Id,
  relation: Id,
  rationale: ShortText,
  confidence: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  evidence: Schema.Array(ShortText).check(Schema.isMaxLength(40)),
  model: Title,
  promptVersion: Title,
  taxonomyVersion: Revision,
  basedOnRevision: Revision,
  evaluationId: Schema.optionalKey(Id),
  inputHash: Schema.optionalKey(Title),
});
export type SuggestionInput = typeof SuggestionInput.Type;
export const Suggestion = Schema.Struct({
  ...SuggestionInput.fields,
  status: Schema.Literals(["pending", "accepted", "rejected", "superseded"]),
  provenance: Provenance,
  decision: Schema.NullOr(Provenance),
});
export const EvaluationInput = Schema.Struct({
  id: Id,
  inputHash: Title,
  basedOnRevision: Revision,
  taxonomyVersion: Revision,
  result: Schema.Json,
});
export const Evaluation = Schema.Struct({
  id: Id,
  inputHash: Title,
  basedOnRevision: Revision,
  taxonomyVersion: Revision,
  status: Schema.Literals(["succeeded", "failed", "unavailable"]),
  provenance: Provenance,
});
export const Graph = Schema.Struct({
  revision: Revision,
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
  captures: Schema.Array(Capture),
  suggestions: Schema.Array(Suggestion),
  evaluations: Schema.Array(Evaluation),
  taxonomy: Taxonomy,
});
export type Graph = typeof Graph.Type;

export const Command = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("capture"),
    capture: CaptureInput,
    nodes: Schema.Array(NodeInput).check(Schema.isMaxLength(100)),
    edges: Schema.Array(EdgeInput).check(Schema.isMaxLength(200)),
  }),
  // The capture record leaves the graph; nodes and edges it created stay.
  // History still holds the original command, so removal loses no provenance.
  Schema.Struct({
    type: Schema.Literal("capture.remove"),
    id: Id,
    rationale: Schema.optionalKey(ShortText),
  }),
  Schema.Struct({ type: Schema.Literal("node.put"), node: NodeInput }),
  // Nodes leave the active graph; the journal still records them and their
  // sources. Incident edges refuse removal unless removeEdges cascades.
  Schema.Struct({
    type: Schema.Literal("node.remove"),
    ids: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    removeEdges: Schema.optionalKey(Schema.Boolean),
    rationale: Schema.optionalKey(ShortText),
  }),
  // New assertions only. An existing pair must be explicitly reframed.
  Schema.Struct({ type: Schema.Literal("edge.put"), edge: EdgeInput }),
  // Resolve by id or by directed source+target pair. suppress decides whether
  // the pair stays rejected for machine inference; corrected or disputed edges
  // keep their suppression by default because it dies with the edge otherwise.
  Schema.Struct({
    type: Schema.Literal("edge.remove"),
    id: Schema.optionalKey(Id),
    source: Schema.optionalKey(Id),
    target: Schema.optionalKey(Id),
    suppress: Schema.optionalKey(Schema.Boolean),
    rationale: Schema.optionalKey(ShortText),
  }),
  Schema.Struct({
    type: Schema.Literal("edge.reframe"),
    id: Id,
    relation: Id,
    rationale: ShortText,
    state: Schema.Literals(["asserted", "disputed"]),
  }),
  Schema.Struct({
    type: Schema.Literal("layout.set"),
    positions: Schema.Array(
      Schema.Union([
        Schema.Struct({ id: Id, ...Position.fields }),
        Schema.Struct({ id: Id, clear: Schema.Literal(true) }),
      ]),
    ).check(Schema.isMaxLength(1000)),
  }),
  Schema.Struct({
    type: Schema.Literal("taxonomy.replace"),
    relations: Taxonomy.fields.relations,
  }),
  Schema.Struct({
    type: Schema.Literal("suggestion.record"),
    suggestion: SuggestionInput,
  }),
  Schema.Struct({
    type: Schema.Literal("evaluation.record"),
    evaluation: EvaluationInput,
    suggestions: Schema.Array(SuggestionInput).check(Schema.isMaxLength(24)),
  }),
  Schema.Struct({
    type: Schema.Literal("suggestion.decide"),
    id: Id,
    decision: Schema.Literals(["accept", "reject"]),
    rationale: ShortText,
  }),
  Schema.Struct({ type: Schema.Literal("undo"), revision: Revision }),
]);
export type Command = typeof Command.Type;
export const CommandRequest = Schema.Struct({
  requestId: Id,
  expectedRevision: Revision,
  command: Command,
});
export type CommandRequest = typeof CommandRequest.Type;
export const Receipt = Schema.Struct({
  requestId: Id,
  revision: Revision,
  type: Schema.String,
  actor: Actor,
  at: Schema.String,
});
export type Receipt = typeof Receipt.Type;
export const CommandResult = Schema.Struct({
  receipt: Receipt,
  replayed: Schema.Boolean,
});
export type CommandResult = typeof CommandResult.Type;
export const EvaluationRequest = Schema.Struct({
  requestId: Id,
  expectedRevision: Revision,
  query: Schema.String.check(Schema.isMaxLength(2000)),
  focusNodeId: Schema.optionalKey(Id),
  includeNodeIds: Schema.optionalKey(
    Schema.Array(Id).check(Schema.isMaxLength(24)),
  ),
});
export type EvaluationRequest = typeof EvaluationRequest.Type;
export const EvaluationResult = Schema.Struct({
  ...CommandResult.fields,
  evaluationId: Id,
});
export const HistoryEntry = Schema.Struct({
  ...Receipt.fields,
  command: Command,
});
export type HistoryEntry = typeof HistoryEntry.Type;
export const Neighborhood = Schema.Struct({
  root: Id,
  revision: Revision,
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
  blockingEdges: Schema.Array(Id),
  cycleDetected: Schema.Boolean,
  interpretation: Schema.String,
});
export type Neighborhood = typeof Neighborhood.Type;
export const ApiError = Schema.Struct({
  error: Schema.Literals([
    "Unauthorized",
    "Forbidden",
    "Invalid",
    "NotFound",
    "Conflict",
    "StorageError",
  ]),
  message: Schema.String,
  currentRevision: Schema.optionalKey(Revision),
});

export const initialTaxonomy: Taxonomy = {
  version: 1,
  relations: [
    {
      id: "requires",
      label: "Requires",
      definition:
        "A necessary prerequisite for the source to achieve its scoped outcome under the stated constraints: without the target, no stated feasible alternative achieves the outcome. An existing dependency claim alone is not proof.",
      blocking: true,
    },
    {
      id: "benefits_from",
      label: "Would benefit from",
      definition:
        "The target offers useful preparation or improvement, but the source can proceed without it. Convenience or repeated usefulness does not make it a necessary prerequisite.",
      blocking: false,
    },
    {
      id: "possible_solution",
      label: "Possible solution to",
      definition:
        "The source is a hypothesis for addressing the target problem.",
      blocking: false,
    },
    {
      id: "related_to",
      label: "Related to",
      definition:
        "Shared context without a prerequisite claim; stored in the asserted direction.",
      blocking: false,
    },
    {
      id: "expands_into",
      label: "Expands into",
      definition:
        "The source opens added scope or exploration represented by the target.",
      blocking: false,
    },
  ],
};

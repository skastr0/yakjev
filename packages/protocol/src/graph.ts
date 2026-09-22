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
const Probability = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
// Present when Jev made the connection. Owner corrections to such edges are
// fed back into later judgments.
export const JevOrigin = Schema.Struct({
  model: Title,
  promptVersion: Title,
  confidence: Schema.NullOr(Probability),
  same: Schema.optionalKey(Schema.Boolean),
});
export type JevOrigin = typeof JevOrigin.Type;
export const EdgeInput = Schema.Struct({
  id: Id,
  // Directed claim: source requires target, never the other way around.
  source: Id,
  target: Id,
  relation: Id,
  rationale: ShortText,
  origin: Schema.optionalKey(JevOrigin),
});
export type EdgeInput = typeof EdgeInput.Type;
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
  confidence: Schema.NullOr(Probability),
  evidence: Schema.Array(ShortText).check(Schema.isMaxLength(40)),
  model: Title,
  promptVersion: Title,
  taxonomyVersion: Revision,
  basedOnRevision: Revision,
  evaluationId: Schema.optionalKey(Id),
  inputHash: Schema.optionalKey(Title),
  // Jev judged the pair to be the same intention restated.
  same: Schema.optionalKey(Schema.Boolean),
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
    // Default true: after commit, Jev connects each new node. Send false when
    // the edges already carry Jev's connections (e.g. from a typing preview).
    autoConnect: Schema.optionalKey(Schema.Boolean),
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
    // true: each suggestion becomes an accepted Jev edge in the same revision.
    connect: Schema.optionalKey(Schema.Boolean),
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
  connect: Schema.optionalKey(Schema.Boolean),
});
export type EvaluationRequest = typeof EvaluationRequest.Type;
// Ephemeral Jev read: nothing is journaled. Give a draft (text being typed)
// or an existing focus node; includeNodeIds forces candidates in.
export const PreviewRequest = Schema.Struct({
  draft: Schema.optionalKey(
    Schema.Struct({
      title: Schema.String.check(Schema.isMaxLength(240)),
      description: Schema.optionalKey(ShortText),
    }),
  ),
  focusNodeId: Schema.optionalKey(Id),
  includeNodeIds: Schema.optionalKey(
    Schema.Array(Id).check(Schema.isMaxLength(24)),
  ),
  // Judge only includeNodeIds, not a full 24-candidate shortlist.
  only: Schema.optionalKey(Schema.Boolean),
  // What asked, for the Jev call log. Not sent to Jev.
  purpose: Schema.optionalKey(Schema.Literals(["typing", "drag", "link"])),
});
export type PreviewRequest = typeof PreviewRequest.Type;
export const PreviewJudgment = Schema.Struct({
  nodeId: Id,
  // 0, 0.5, or 1 in expectation; probability-weighted.
  relatedness: Schema.Finite,
  match: Schema.Boolean,
  // The candidate restates the same intention.
  same: Schema.Boolean,
  relation: Schema.NullOr(Id),
  direction: Schema.NullOr(
    Schema.Literals(["focus_to_candidate", "candidate_to_focus"]),
  ),
  confidence: Schema.NullOr(Schema.Finite),
  // The owner removed or corrected this pair before; never connect it.
  suppressed: Schema.Boolean,
  // Server policy: Jev would connect this pair now. relation is non-null.
  connect: Schema.Boolean,
});
export type PreviewJudgment = typeof PreviewJudgment.Type;
export const Preview = Schema.Struct({
  basedOnRevision: Revision,
  taxonomyVersion: Revision,
  status: Schema.Literals(["succeeded", "failed", "unavailable"]),
  model: Schema.NullOr(Schema.String),
  promptVersion: Schema.String,
  elapsedMs: Schema.Finite,
  judgments: Schema.Array(PreviewJudgment),
});
export type Preview = typeof Preview.Type;
// One provider call, as the in-memory Jev call log records it.
export const JevCall = Schema.Struct({
  at: Schema.String,
  purpose: Schema.Literals([
    "typing",
    "drag",
    "link",
    "preview",
    "auto-connect",
    "evaluate",
  ]),
  status: Schema.Literals(["succeeded", "failed"]),
  candidates: Schema.Int,
  elapsedMs: Schema.Finite,
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  // Estimated from configured rates; null when no rate is configured.
  costUsd: Schema.NullOr(Schema.Finite),
  model: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
});
export type JevCall = typeof JevCall.Type;
export const JevCalls = Schema.Struct({
  since: Schema.String,
  pricing: Schema.NullOr(
    Schema.Struct({
      inputUsdPerMTok: Schema.Finite,
      outputUsdPerMTok: Schema.Finite,
    }),
  ),
  totals: Schema.Struct({
    calls: Schema.Int,
    failed: Schema.Int,
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    elapsedMs: Schema.Finite,
    costUsd: Schema.NullOr(Schema.Finite),
  }),
  // Newest first, at most JEV_CALL_LOG_LIMIT.
  calls: Schema.Array(JevCall),
});
export type JevCalls = typeof JevCalls.Type;
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

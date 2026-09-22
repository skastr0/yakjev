// Machine-readable mirror of packages/protocol/src/graph.ts for agents that
// build payloads without reading docs: `yakjev schema` prints these shapes and
// `yakjev examples` prints the payloads below, each of which decodes against
// the protocol schemas.

interface Field {
  readonly type: string;
  readonly required?: boolean;
  readonly [constraint: string]: unknown;
}

interface ReferenceEntry {
  readonly fields: Record<string, Field>;
  readonly notes: readonly string[];
}

const ID: Field = {
  type: "string",
  required: true,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$",
};
const OPTIONAL_ID: Field = { ...ID, required: false };
const TITLE: Field = {
  type: "string",
  required: true,
  minLength: 1,
  maxLength: 240,
};
const SHORT_TEXT: Field = {
  type: "string",
  required: true,
  maxLength: 2000,
};
const OPTIONAL_SHORT_TEXT: Field = { ...SHORT_TEXT, required: false };
const REVISION: Field = { type: "integer", required: true, minimum: 0 };
const FINITE: Field = { type: "number", required: true };
const FLAG: Field = { type: "boolean", required: true };
const OPTIONAL_FLAG: Field = { ...FLAG, required: false };
const ID_ITEM: Field = { type: "string", pattern: ID.pattern };
const commandType = (name: string): Field => ({
  type: "string",
  required: true,
  const: name,
});

const SOURCE: Field = {
  type: "object",
  required: true,
  fields: {
    uri: { type: "string", required: true, minLength: 1, maxLength: 2048 },
    label: { type: "string", required: true, maxLength: 240 },
  },
};
const SOURCE_LIST: Field = {
  type: "array",
  required: true,
  maxItems: 40,
  items: SOURCE,
};

const NODE_INPUT: Field = {
  type: "object",
  required: true,
  fields: {
    id: ID,
    title: TITLE,
    description: SHORT_TEXT,
    project: { type: "string", required: true, maxLength: 240 },
    status: {
      type: "string",
      required: true,
      enum: ["idea", "active", "done", "archived"],
    },
    sources: SOURCE_LIST,
  },
};
const EDGE_INPUT: Field = {
  type: "object",
  required: true,
  fields: {
    id: ID,
    source: ID,
    target: ID,
    relation: ID,
    rationale: SHORT_TEXT,
  },
};
const CAPTURE_INPUT: Field = {
  type: "object",
  required: true,
  fields: {
    id: ID,
    text: { type: "string", required: true, maxLength: 8000 },
    sources: SOURCE_LIST,
    nodeIds: { type: "array", required: true, maxItems: 100, items: ID_ITEM },
  },
};
const SUGGESTION_INPUT: Field = {
  type: "object",
  required: true,
  fields: {
    id: ID,
    source: ID,
    target: ID,
    relation: ID,
    rationale: SHORT_TEXT,
    confidence: {
      type: "number|null",
      required: true,
      minimum: 0,
      maximum: 1,
    },
    evidence: { type: "array", required: true, maxItems: 40, items: SHORT_TEXT },
    model: TITLE,
    promptVersion: TITLE,
    taxonomyVersion: REVISION,
    basedOnRevision: REVISION,
    evaluationId: OPTIONAL_ID,
    inputHash: { ...TITLE, required: false },
  },
};
const EVALUATION_INPUT: Field = {
  type: "object",
  required: true,
  fields: {
    id: ID,
    inputHash: TITLE,
    basedOnRevision: REVISION,
    taxonomyVersion: REVISION,
    result: { type: "json", required: true },
  },
};
const RELATION_INPUT: Field = {
  type: "object",
  required: true,
  fields: {
    id: ID,
    label: TITLE,
    definition: SHORT_TEXT,
    blocking: FLAG,
  },
};

const ENVELOPE_NOTE =
  'Submit as yakjev command \'{"requestId":"<id>","expectedRevision":<graph.revision>,"command":<this object>}\'. expectedRevision must equal the current graph.revision; omit requestId to mint a fresh one or repeat it for safe replay.';

export const COMMAND_REFERENCE: Record<string, ReferenceEntry> = {
  capture: {
    fields: {
      type: commandType("capture"),
      capture: CAPTURE_INPUT,
      nodes: {
        type: "array",
        required: true,
        maxItems: 100,
        items: NODE_INPUT,
      },
      edges: {
        type: "array",
        required: true,
        maxItems: 200,
        items: EDGE_INPUT,
      },
    },
    notes: [
      ENVELOPE_NOTE,
      "One atomic ingest: the capture record plus the nodes and edges it names. nodeIds links the capture to nodes without creating them.",
    ],
  },
  "capture.remove": {
    fields: {
      type: commandType("capture.remove"),
      id: ID,
      rationale: OPTIONAL_SHORT_TEXT,
    },
    notes: [
      ENVELOPE_NOTE,
      "Removes the capture record only; nodes and edges it created stay. History keeps the original command, so no provenance is lost.",
    ],
  },
  "node.put": {
    fields: {
      type: commandType("node.put"),
      node: NODE_INPUT,
    },
    notes: [
      ENVELOPE_NOTE,
      "Upsert by id. Position is not part of NodeInput; stored coordinates are untouched.",
    ],
  },
  "node.remove": {
    fields: {
      type: commandType("node.remove"),
      ids: {
        type: "array",
        required: true,
        minItems: 1,
        maxItems: 100,
        items: ID_ITEM,
      },
      removeEdges: OPTIONAL_FLAG,
      rationale: OPTIONAL_SHORT_TEXT,
    },
    notes: [
      ENVELOPE_NOTE,
      "Nodes leave the active graph; the journal still records them and their sources. Refuses removal while incident edges exist unless removeEdges:true cascades.",
    ],
  },
  "edge.put": {
    fields: {
      type: commandType("edge.put"),
      edge: EDGE_INPUT,
    },
    notes: [
      ENVELOPE_NOTE,
      "Directed claim: source requires target, never the reverse. New assertions only; an existing directed pair must be explicitly reframed. relation must exist in the taxonomy.",
    ],
  },
  "edge.remove": {
    fields: {
      type: commandType("edge.remove"),
      id: OPTIONAL_ID,
      source: OPTIONAL_ID,
      target: OPTIONAL_ID,
      suppress: OPTIONAL_FLAG,
      rationale: OPTIONAL_SHORT_TEXT,
    },
    notes: [
      ENVELOPE_NOTE,
      "Resolve by id or by directed source+target pair. suppress decides whether the pair stays rejected for machine inference; corrected or disputed edges keep suppression by default because it dies with the edge otherwise.",
    ],
  },
  "edge.reframe": {
    fields: {
      type: commandType("edge.reframe"),
      id: ID,
      relation: ID,
      rationale: SHORT_TEXT,
      state: {
        type: "string",
        required: true,
        enum: ["asserted", "disputed"],
      },
    },
    notes: [
      ENVELOPE_NOTE,
      "Rewrites an edge's relation and state as an explicit correction; relation must exist in the taxonomy.",
    ],
  },
  "layout.set": {
    fields: {
      type: commandType("layout.set"),
      positions: {
        type: "array",
        required: true,
        maxItems: 1000,
        items: {
          type: "union",
          anyOf: [
            {
              type: "object",
              fields: { id: ID, x: FINITE, y: FINITE, pinned: FLAG },
            },
            {
              type: "object",
              fields: {
                id: ID,
                clear: { type: "boolean", required: true, const: true },
              },
            },
          ],
        },
      },
    },
    notes: [
      ENVELOPE_NOTE,
      "Bulk position write or clear; positions are display state, not claims. A {id, clear:true} entry removes a stored position.",
    ],
  },
  "taxonomy.replace": {
    fields: {
      type: commandType("taxonomy.replace"),
      relations: {
        type: "array",
        required: true,
        minItems: 1,
        maxItems: 40,
        items: RELATION_INPUT,
      },
    },
    notes: [
      ENVELOPE_NOTE,
      "Replaces the entire relation list at once; relationship types still referenced by edges or suggestions cannot be removed.",
    ],
  },
  "suggestion.record": {
    fields: {
      type: commandType("suggestion.record"),
      suggestion: SUGGESTION_INPUT,
    },
    notes: [
      ENVELOPE_NOTE,
      "Records a pending machine judgment; decide it with suggestion.decide. basedOnRevision must not be stale.",
    ],
  },
  "suggestion.decide": {
    fields: {
      type: commandType("suggestion.decide"),
      id: ID,
      decision: {
        type: "string",
        required: true,
        enum: ["accept", "reject"],
      },
      rationale: SHORT_TEXT,
    },
    notes: [
      ENVELOPE_NOTE,
      "Accept is an explicit, revision-checked correction on the pair, not inference applying itself.",
    ],
  },
  "evaluation.record": {
    fields: {
      type: commandType("evaluation.record"),
      evaluation: EVALUATION_INPUT,
      suggestions: {
        type: "array",
        required: true,
        maxItems: 24,
        items: SUGGESTION_INPUT,
      },
    },
    notes: [
      ENVELOPE_NOTE,
      "Stores an evaluation result plus the suggestions it produced, atomically.",
    ],
  },
  undo: {
    fields: {
      type: commandType("undo"),
      revision: REVISION,
    },
    notes: [
      ENVELOPE_NOTE,
      "Undoes the latest command: revision must equal the current graph.revision and restores the before-image recorded there. Restored entities count as new edits for freshness checks.",
    ],
  },
};

interface ReadEntry {
  readonly params: Record<string, Field>;
  readonly notes: readonly string[];
}

export const READ_REFERENCE: Record<string, ReadEntry> = {
  graph: {
    params: {},
    notes: [
      "Current graph document. Read graph.revision before submitting a command.",
    ],
  },
  history: {
    params: {
      after: { type: "integer", required: false, minimum: 0, default: 0 },
      limit: { type: "integer", required: false, minimum: 1, default: 100 },
    },
    notes: ["Journal entries with revision greater than after."],
  },
  search: {
    params: { query: { type: "string", required: true } },
    notes: ["Matches title, description, and project."],
  },
  neighborhood: {
    params: {
      id: ID,
      direction: {
        type: "string",
        required: false,
        enum: ["outgoing", "incoming", "both"],
        default: "outgoing",
      },
      blocking: { type: "boolean", required: false, default: false },
    },
    notes: [
      "blocking:true keeps only asserted blocking edges and skips done/archived nodes.",
    ],
  },
  export: {
    params: {},
    notes: ["Graph plus complete journal."],
  },
  evaluation: {
    params: { id: ID },
    notes: ["One recorded evaluation by id."],
  },
  node: {
    params: { id: ID },
    notes: ["Resolved from the graph document; errors on unknown ids."],
  },
  edge: {
    params: { id: OPTIONAL_ID, source: OPTIONAL_ID, target: OPTIONAL_ID },
    notes: [
      "Pass id or a directed source+target pair; if both are given they must agree.",
    ],
  },
};

// Every command payload is a full CommandRequest for `yakjev command`;
// read.* payloads are the params for `yakjev read <view>`; discover is the
// params for `yakjev discover`; evaluate is a full EvaluationRequest.
export const EXAMPLES: Record<string, unknown> = {
  capture: {
    requestId: "req-capture-1",
    expectedRevision: 0,
    command: {
      type: "capture",
      capture: {
        id: "cap-1",
        text: "Launch depends on the pricing page going live.",
        sources: [
          { uri: "https://example.com/notes/launch", label: "Launch notes" },
        ],
        nodeIds: ["n-launch", "n-pricing"],
      },
      nodes: [
        {
          id: "n-launch",
          title: "Ship the launch",
          description: "Public release checklist",
          project: "yakjev",
          status: "active",
          sources: [],
        },
        {
          id: "n-pricing",
          title: "Pricing page",
          description: "",
          project: "yakjev",
          status: "idea",
          sources: [],
        },
      ],
      edges: [
        {
          id: "e-1",
          source: "n-launch",
          target: "n-pricing",
          relation: "requires",
          rationale: "Cannot launch before pricing is published",
        },
      ],
    },
  },
  "capture.remove": {
    requestId: "req-capture-remove-1",
    expectedRevision: 1,
    command: {
      type: "capture.remove",
      id: "cap-1",
      rationale: "Captured twice",
    },
  },
  "node.put": {
    requestId: "req-node-put-1",
    expectedRevision: 1,
    command: {
      type: "node.put",
      node: {
        id: "n-rfc",
        title: "Write the RFC",
        description: "Decide the schema surface",
        project: "yakjev",
        status: "active",
        sources: [{ uri: "https://example.com/rfc", label: "RFC draft" }],
      },
    },
  },
  "node.remove": {
    requestId: "req-node-remove-1",
    expectedRevision: 2,
    command: {
      type: "node.remove",
      ids: ["n-rfc"],
      removeEdges: true,
      rationale: "Superseded by the graph model",
    },
  },
  "edge.put": {
    requestId: "req-edge-put-1",
    expectedRevision: 1,
    command: {
      type: "edge.put",
      edge: {
        id: "e-2",
        source: "n-launch",
        target: "n-rfc",
        relation: "requires",
        rationale: "The schema decision blocks the launch",
      },
    },
  },
  "edge.remove": {
    requestId: "req-edge-remove-1",
    expectedRevision: 2,
    command: {
      type: "edge.remove",
      id: "e-2",
      suppress: true,
      rationale: "Not a real prerequisite",
    },
  },
  "edge.reframe": {
    requestId: "req-edge-reframe-1",
    expectedRevision: 2,
    command: {
      type: "edge.reframe",
      id: "e-1",
      relation: "related_to",
      rationale: "Context, not a prerequisite",
      state: "asserted",
    },
  },
  "layout.set": {
    requestId: "req-layout-set-1",
    expectedRevision: 1,
    command: {
      type: "layout.set",
      positions: [
        { id: "n-launch", x: 140, y: -60, pinned: true },
        { id: "n-pricing", clear: true },
      ],
    },
  },
  "taxonomy.replace": {
    requestId: "req-taxonomy-1",
    expectedRevision: 1,
    command: {
      type: "taxonomy.replace",
      relations: [
        {
          id: "requires",
          label: "Requires",
          definition: "A necessary prerequisite for the source outcome.",
          blocking: true,
        },
        {
          id: "related_to",
          label: "Related to",
          definition: "Shared context without a prerequisite claim.",
          blocking: false,
        },
      ],
    },
  },
  "suggestion.record": {
    requestId: "req-suggestion-record-1",
    expectedRevision: 4,
    command: {
      type: "suggestion.record",
      suggestion: {
        id: "s-1",
        source: "n-launch",
        target: "n-rfc",
        relation: "requires",
        rationale: "The RFC gates the launch",
        confidence: 0.82,
        evidence: ["RFC section 3 lists launch gates"],
        model: "jev-1",
        promptVersion: "2026-09-01",
        taxonomyVersion: 1,
        basedOnRevision: 4,
      },
    },
  },
  "suggestion.decide": {
    requestId: "req-suggestion-decide-1",
    expectedRevision: 4,
    command: {
      type: "suggestion.decide",
      id: "s-1",
      decision: "accept",
      rationale: "Confirmed in the meeting notes",
    },
  },
  "evaluation.record": {
    requestId: "req-evaluation-record-1",
    expectedRevision: 4,
    command: {
      type: "evaluation.record",
      evaluation: {
        id: "ev-1",
        inputHash: "sha256:9f2c",
        basedOnRevision: 4,
        taxonomyVersion: 1,
        result: { verdict: "requires", confidence: 0.82 },
      },
      suggestions: [
        {
          id: "s-1",
          source: "n-launch",
          target: "n-rfc",
          relation: "requires",
          rationale: "The RFC gates the launch",
          confidence: 0.82,
          evidence: ["RFC section 3 lists launch gates"],
          model: "jev-1",
          promptVersion: "2026-09-01",
          taxonomyVersion: 1,
          basedOnRevision: 4,
        },
      ],
    },
  },
  undo: {
    requestId: "req-undo-1",
    expectedRevision: 4,
    command: { type: "undo", revision: 4 },
  },
  "read.graph": {},
  "read.history": { after: 0, limit: 50 },
  "read.search": { query: "pricing" },
  "read.neighborhood": { id: "n-launch", direction: "outgoing", blocking: true },
  "read.export": {},
  "read.evaluation": { id: "ev-1" },
  "read.node": { id: "n-launch" },
  "read.edge": { source: "n-launch", target: "n-pricing" },
  discover: {
    query: "what blocks the launch",
    focusNodeId: "n-launch",
    includeNodeIds: ["n-pricing", "n-rfc"],
  },
  evaluate: {
    requestId: "req-evaluate-1",
    expectedRevision: 4,
    query: "Is the RFC a hard prerequisite for the launch?",
    focusNodeId: "n-launch",
    includeNodeIds: ["n-rfc"],
  },
};

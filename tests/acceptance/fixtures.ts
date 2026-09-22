// Synthetic fixtures for acceptance runs. Disposable local data only.
//
// The tangle mirrors the shape of the user's example (Jev in projects -> Jev
// skill -> skills in projects -> Prism harness installs -> multi-machine skills
// blocker). These are claimed edges in a fixture, not project facts, and every
// source reference is a synthetic identifier.
import type {
  CaptureInput,
  EdgeInput,
  NodeInput,
  Relation,
  Source,
  SuggestionInput,
} from "./contract";

export const FIXTURE_LABEL =
  "Synthetic acceptance fixture. Claimed edges, not verified project facts.";

export const project = "synthetic-project";

function source(label: string, ref: string): Source {
  return { uri: ref, label };
}

export const nodes: readonly NodeInput[] = [
  {
    id: "jev_in_projects",
    title: "Jev in projects",
    description:
      "Use Jev judgments inside project work rather than only in the Yakjev repository.",
    project,
    status: "idea",
    sources: [
      source(
        "Synthetic session capture",
        "synthetic://session/jev-in-projects",
      ),
    ],
  },
  {
    id: "jev_skill",
    title: "Jev skill",
    description:
      "A reusable skill that teaches an agent when and how to call Jev.",
    project,
    status: "active",
    sources: [source("Synthetic skill note", "synthetic://document/jev-skill")],
  },
  {
    id: "skills_in_projects",
    title: "Skills in projects",
    description:
      "Project-scoped skills are available to agents working in that project.",
    project,
    status: "active",
    sources: [
      source(
        "Synthetic repository reference",
        "synthetic://repository/skills-in-projects",
      ),
    ],
  },
  {
    id: "prism_harness_installs",
    title: "Prism harness installs",
    description:
      "Prism harness installation across the machines the owner works from.",
    project,
    status: "active",
    sources: [
      source(
        "Synthetic install log reference",
        "synthetic://session/prism-installs",
      ),
    ],
  },
  {
    id: "multi_machine_skills",
    title: "Multi-machine skills blocker",
    description:
      "Skills are not consistently available across machines, which delays the install work.",
    project,
    status: "idea",
    sources: [
      source(
        "Synthetic blocker note",
        "synthetic://document/multi-machine-skills",
      ),
    ],
  },
];

/** Asserted `requires` chain plus one mutual entanglement the user calls a knot. */
export const edges: readonly EdgeInput[] = [
  {
    id: "jev_projects_requires_jev_skill",
    source: "jev_in_projects",
    target: "jev_skill",
    relation: "requires",
    rationale: "Claimed: Jev is usable in projects only once the skill exists.",
  },
  {
    id: "jev_skill_requires_skills_in_projects",
    source: "jev_skill",
    target: "skills_in_projects",
    relation: "requires",
    rationale: "Claimed: the skill needs project-scoped skill support.",
  },
  {
    id: "skills_in_projects_requires_prism",
    source: "skills_in_projects",
    target: "prism_harness_installs",
    relation: "requires",
    rationale: "Claimed: project skills depend on the harness install.",
  },
  {
    id: "prism_requires_multi_machine",
    source: "prism_harness_installs",
    target: "multi_machine_skills",
    relation: "requires",
    rationale: "Claimed: the install waits on consistent multi-machine skills.",
  },
  {
    id: "skills_in_projects_requires_jev_skill",
    source: "skills_in_projects",
    target: "jev_skill",
    relation: "requires",
    rationale:
      "Claimed mutual entanglement: each is asserted to need the other. Meaningful, not invalid input.",
  },
];

export const capture: CaptureInput = {
  id: "capture_worked_example",
  text: "Synthetic capture of the worked example tangle: Jev in projects -> Jev skill -> skills in projects -> Prism harness installs -> multi-machine skills blocker.",
  sources: [
    source("Synthetic capture session", "synthetic://session/worked-example"),
  ],
  nodeIds: nodes.map((node) => node.id),
};

/** The edge the acceptance scenario reframes from prerequisite to optional. */
export const reframeEdgeId = "prism_requires_multi_machine";
export const optionalRelationId = "benefits_from";

/** Machine-suggested connection, distinct from any asserted edge. */
export const suggestion: SuggestionInput = {
  id: "suggestion_jev_projects_prism",
  source: "jev_in_projects",
  target: "prism_harness_installs",
  relation: "related_to",
  rationale:
    "Suggested: both touch how project work reaches shared tooling. Proposal only, never auto-accepted.",
  confidence: 0.62,
  evidence: ["Synthetic lexical overlap on 'projects' and 'harness'."],
  model: "synthetic-acceptance-model",
  promptVersion: "synthetic-prompt-v1",
  taxonomyVersion: 1,
  basedOnRevision: 0,
};

/** Default taxonomy the user approved, as the acceptance run expects to read it. */
export const expectedTaxonomy: readonly Relation[] = [
  {
    id: "requires",
    label: "Requires",
    definition:
      "A claimed necessary prerequisite: the source requires the target.",
    blocking: true,
  },
  {
    id: "benefits_from",
    label: "Would benefit from",
    definition:
      "The target may help the source, but is not a necessary prerequisite.",
    blocking: false,
  },
  {
    id: "possible_solution",
    label: "Possible solution to",
    definition: "The source is a hypothesis for addressing the target problem.",
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
];

export function nodeByKey(key: string): NodeInput {
  const node = nodes.find((candidate) => candidate.id === key);
  if (!node) throw new Error(`Unknown fixture node: ${key}`);
  return node;
}

export function edgeByKey(key: string): EdgeInput {
  const edge = edges.find((candidate) => candidate.id === key);
  if (!edge) throw new Error(`Unknown fixture edge: ${key}`);
  return edge;
}

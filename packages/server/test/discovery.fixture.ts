import type { Edge, Graph, Node } from "../../protocol/src/graph.ts";
import { initialTaxonomy } from "../../protocol/src/graph.ts";

export const provenance = {
  actor: { id: "synthetic-user", channel: "browser" as const },
  at: "2026-09-22T00:00:00Z",
  revision: 1,
};

export const node = (id: string, title: string, description = ""): Node => ({
  id,
  title,
  description,
  project: "synthetic",
  status: "idea",
  sources: [
    {
      uri: `https://example.com/${id}`,
      label: "Synthetic source pointer; not fetched",
    },
  ],
  position: null,
  created: provenance,
  updated: provenance,
});

export const edge = (
  source: string,
  target: string,
  relation = "requires",
): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
  relation,
  rationale: "Unverified synthetic user claim",
  state: "asserted",
  assertion: {
    relation,
    rationale: "Unverified synthetic user claim",
    provenance,
  },
  correction: null,
  updated: provenance,
});

export const graph = (
  nodes: readonly Node[],
  edges: readonly Edge[] = [],
): Graph => ({
  revision: 1,
  nodes,
  edges,
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
});

export const tangle = graph(
  [
    node(
      "use-jev",
      "Use Jev in projects",
      "Try typed AI judgments in one project. A skill may help but a direct API call can work today.",
    ),
    node(
      "jev-skill",
      "Jev skill",
      "Instructions explaining Jev typed judgments to a coding assistant.",
    ),
    node(
      "project-skills",
      "Skills in projects",
      "Store reusable instructions with each repository.",
    ),
    node(
      "prism",
      "Prism installs skills in harnesses",
      "Distribute repository instructions to different AI coding harnesses.",
    ),
    node(
      "machines",
      "Multi-machine skills blockers",
      "Keeping instructions synchronized between laptops is currently manual.",
    ),
  ],
  [
    edge("use-jev", "jev-skill"),
    edge("jev-skill", "project-skills"),
    edge("project-skills", "prism"),
    edge("prism", "machines"),
  ],
);

export const synonymGraph = graph([
  node(
    "synonym",
    "Distribute reusable instructions",
    "Replicate assistant guidance across computers.",
  ),
  node(
    "word-trap",
    "Multi machine skills",
    "A circus lesson teaching performers to juggle several mechanical props. Unrelated to software, repository instructions, or computers.",
  ),
]);

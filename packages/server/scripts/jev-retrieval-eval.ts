import { initialTaxonomy, type Graph } from "@yakjev/protocol";
import { discover } from "../src/discovery.ts";

// Cheap shortlist check: no provider key, network, or persistent graph needed.
// The distractors deliberately share words with each query while the intended
// node is a paraphrase. This catches a lexical shortlist that hides a valid
// connection before Jev has a chance to judge it.
const cases = [
  {
    query: "Arrange a routine teeth checkup",
    id: "dental_exam",
    title: "Schedule an oral health examination",
    trap: "Arrange a routine code checkup",
  },
  {
    query: "Turn writing notes into a book chapter",
    id: "manuscript_sections",
    title: "Convert research annotations into manuscript sections",
    trap: "Turn writing notes into archive boxes",
  },
  {
    query: "Map dependencies for the service rollout",
    id: "release_prerequisites",
    title: "Chart deployment prerequisites",
    trap: "Map dependencies for the garden service schedule",
  },
] as const;

const provenance = {
  actor: { id: "synthetic", channel: "system" as const },
  at: "2026-01-01T00:00:00.000Z",
  revision: 0,
};
const makeNode = (id: string, title: string): Graph["nodes"][number] => ({
  id,
  title,
  description: "",
  project: "synthetic-retrieval",
  status: "idea",
  sources: [],
  position: null,
  created: provenance,
  updated: provenance,
});

const nodes: Graph["nodes"][number][] = cases.map(({ id, title }) =>
  makeNode(id, title),
);
for (let index = 0; index < 997; index++) {
  const group = cases[index % cases.length]!;
  nodes.push(makeNode(`trap_${index}`, `${group.trap} ${index}`));
}
const graph: Graph = {
  revision: 0,
  nodes,
  edges: [],
  captures: [],
  suggestions: [],
  evaluations: [],
  taxonomy: initialTaxonomy,
};

const results = cases.map(({ query, id }) => {
  const started = performance.now();
  const result = discover(graph, { query });
  const ranked = result.candidates.map((candidate) => candidate.nodeId);
  return {
    query,
    expected: id,
    found: ranked.includes(id),
    rank: ranked.indexOf(id) + 1 || null,
    considered: result.coverage.considered,
    eligible: result.coverage.eligible,
    truncated: result.coverage.truncated,
    strategy: result.coverage.strategy,
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
  };
});
const recall = results.filter((result) => result.found).length / results.length;
console.table(results);
console.log(
  `Large-graph candidate recall: ${recall.toFixed(3)} (${nodes.length} nodes)`,
);
const floorArg = process.argv.find((value) =>
  value.startsWith("--min-recall="),
);
if (floorArg) {
  const floor = Number(floorArg.slice("--min-recall=".length));
  if (!Number.isFinite(floor) || floor < 0 || floor > 1)
    throw new Error("--min-recall must be between 0 and 1");
  if (recall < floor) process.exitCode = 1;
}

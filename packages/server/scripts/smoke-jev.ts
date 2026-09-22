import { Effect } from "effect";
import type { Graph } from "../../protocol/src/graph.ts";
import { Discovery, DiscoveryLive } from "../src/discovery.ts";
import type { DiscoveryRequest, Evaluation } from "../src/discovery.ts";
import { synonymGraph, tangle } from "../test/discovery.fixture.ts";

// Explicit opt-in script, never run by CI. Synthetic source pointers are not fetched.
if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not configured; no provider call made.");
  process.exit(1);
}

const cases: { name: string; graph: Graph; request: DiscoveryRequest }[] =
  process.argv.includes("--ab")
    ? [true, false].flatMap((assertion) =>
        [true, false].map((alternative) => ({
          name: `assertion_${assertion}_alternative_${alternative}`,
          graph: {
            ...tangle,
            nodes: tangle.nodes.map((node) =>
              node.id === "use-jev"
                ? {
                    ...node,
                    description: alternative
                      ? node.description
                      : "Try typed AI judgments in one project.",
                  }
                : node,
            ),
            edges: tangle.edges.filter(
              (edge) => assertion || edge.id !== "use-jev-jev-skill",
            ),
          },
          request: { query: "", focusNodeId: "use-jev" },
        })),
      )
    : [
        {
          name: "tangle",
          graph: tangle,
          request: { query: "", focusNodeId: "use-jev" },
        },
        {
          name: "search",
          graph: synonymGraph,
          request: { query: "multi machine skills" },
        },
      ];

const results = await Effect.runPromise(
  Effect.gen(function* () {
    const discovery = yield* Discovery;
    const results: Record<string, Evaluation> = {};
    for (const item of cases)
      results[item.name] = yield* discovery.evaluate(item.graph, item.request);
    return results;
  }).pipe(Effect.provide(DiscoveryLive)),
);
console.log(
  JSON.stringify(
    {
      synthetic: true,
      actualProviderCalls: true,
      providerAttempts: cases.length,
      cost: "Not returned by the provider; token usage recorded without an inferred price.",
      ...results,
    },
    null,
    2,
  ),
);
if (Object.values(results).some((result) => result.status !== "succeeded"))
  process.exit(1);

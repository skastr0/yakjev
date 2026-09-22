import { afterEach, expect, test } from "bun:test";
import { readGraph } from "./contract";
import { expectedTaxonomy } from "./fixtures";
import { startServer, type ServerHandle } from "./harness";

let server: ServerHandle | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

// The precondition for the first-version acceptance scenario: a real graph
// surface that starts empty and carries the user-approved taxonomy. This fails
// while the scaffold is health-only, which is the honest state.
test("graph surface exists, starts empty, and exposes the approved taxonomy", async () => {
  server = await startServer();
  const graph = await readGraph(server);
  expect(graph.revision).toBe(0);
  expect(graph.nodes).toEqual([]);
  expect(graph.edges).toEqual([]);
  expect(graph.captures).toEqual([]);
  expect(graph.suggestions).toEqual([]);
  expect(graph.taxonomy.version).toBe(1);
  expect(
    graph.taxonomy.relations.map((relation) => ({
      id: relation.id,
      blocking: relation.blocking,
    })),
  ).toEqual(
    expectedTaxonomy.map((relation) => ({
      id: relation.id,
      blocking: relation.blocking,
    })),
  );
  expect(
    graph.taxonomy.relations.find((relation) => relation.id === "requires")
      ?.label,
  ).toBe("Requires");
});

import { afterEach, expect, test } from "bun:test";
import {
  edgeBetween,
  edgeById,
  exportAll,
  history,
  neighborhood,
  nodeById,
  nextRequestId,
  nodeByTitle,
  readGraph,
  search,
  sendCommand,
  sendCommandExpectingFailure,
  type Command,
  type GraphSnapshot,
} from "./contract";
import {
  capture,
  edges,
  expectedTaxonomy,
  nodes,
  optionalRelationId,
  reframeEdgeId,
  suggestion,
} from "./fixtures";
import { acceptanceToken, startServer, type ServerHandle } from "./harness";

let server: ServerHandle | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Start a disposable server seeded with the synthetic worked-example tangle. */
async function seeded(): Promise<{ server: ServerHandle; revision: number }> {
  const started = await startServer();
  server = started;
  const result = await sendCommand(started, 0, {
    type: "capture",
    capture,
    nodes,
    edges,
  });
  return { server: started, revision: result.receipt.revision };
}

test("capture persists nodes, sources, asserted edges, and capture provenance", async () => {
  const { server: active, revision } = await seeded();
  const graph = await readGraph(active);
  expect(graph.revision).toBe(revision);
  expect(graph.nodes.map((node) => node.id).sort()).toEqual(
    nodes.map((node) => node.id).sort(),
  );
  expect(graph.edges.map((edge) => edge.id).sort()).toEqual(
    edges.map((edge) => edge.id).sort(),
  );
  expect(graph.captures.map((entry) => entry.id)).toEqual([capture.id]);
  const captured = graph.captures[0];
  expect(captured?.text).toContain("Synthetic capture");
  expect(captured?.sources[0]?.uri).toBe("synthetic://session/worked-example");
  // Channel is entrypoint-derived: /api/* is the browser channel even for bearer.
  expect(captured?.provenance.actor.channel).toBe("browser");
  expect(captured?.provenance.revision).toBe(revision);

  const node = nodeById(graph, "jev_in_projects");
  expect(node?.title).toBe("Jev in projects");
  expect(node?.sources[0]?.uri).toBe("synthetic://session/jev-in-projects");
  expect(node?.status).toBe("idea");

  const edge = edgeById(graph, reframeEdgeId);
  expect(edge?.source).toBe("prism_harness_installs");
  expect(edge?.target).toBe("multi_machine_skills");
  expect(edge?.relation).toBe("requires");
  expect(edge?.state).toBe("asserted");
  expect(edge?.assertion.relation).toBe("requires");
  expect(edge?.assertion.rationale).toContain("install waits");
  expect(edge?.correction).toBeNull();
});

test("the change stream delivers a receipt another client needs to render live", async () => {
  const { server: active, revision } = await seeded();
  const stream = await active.events({ after: revision });
  const added = await sendCommand(active, revision, {
    type: "node.put",
    node: {
      id: "reframe_optional_step",
      title: "Reframe step",
      description: "Synthetic node added while a second client is connected.",
      project: "synthetic-project",
      status: "idea",
      sources: [
        { uri: "synthetic://document/reframe-step", label: "Synthetic note" },
      ],
    },
  });
  const event = await stream.waitForRevision(added.receipt.revision);
  expect(event.id).toBe(added.receipt.revision);
  const receipt = event.data as {
    requestId?: string;
    revision?: number;
    type?: string;
  };
  expect(receipt.requestId).toBe(added.receipt.requestId);
  expect(receipt.revision).toBe(added.receipt.revision);
  expect(receipt.type).toBe("node.put");
  stream.close();
});

test("idempotent replay returns the original receipt without applying twice", async () => {
  const { server: active, revision } = await seeded();
  const command: Command = {
    type: "node.put",
    node: {
      id: "replayed_node",
      title: "Replayed node",
      description: "Synthetic node used to check idempotent replay.",
      project: "synthetic-project",
      status: "idea",
      sources: [],
    },
  };
  const requestId = "acceptance-replay-1";
  const first = await sendCommand(active, revision, command, requestId);
  const second = await sendCommand(active, revision, command, requestId);
  expect(first.replayed).toBe(false);
  expect(second.replayed).toBe(true);
  expect(second.receipt.revision).toBe(first.receipt.revision);
  expect(second.receipt.requestId).toBe(requestId);
  const graph = await readGraph(active);
  expect(graph.revision).toBe(first.receipt.revision);
  expect(
    graph.nodes.filter((node) => node.id === "replayed_node"),
  ).toHaveLength(1);
  const entries = await history(active);
  expect(entries.filter((entry) => entry.requestId === requestId)).toHaveLength(
    1,
  );
});

test("stale expectedRevision is rejected with a conflict and no partial apply", async () => {
  const { server: active, revision } = await seeded();
  const applied = await sendCommand(active, revision, {
    type: "layout.set",
    positions: [{ id: "prism_harness_installs", x: 120, y: 40, pinned: false }],
  });
  const stale = await sendCommandExpectingFailure(active, revision, {
    type: "node.put",
    node: {
      id: "stale_node",
      title: "Stale node",
      description: "Must never be written at a stale revision.",
      project: "synthetic-project",
      status: "idea",
      sources: [],
    },
  });
  expect(stale.status).toBe(409);
  const body = stale.body as { error?: string; currentRevision?: number };
  expect(body.error).toBe("Conflict");
  expect(body.currentRevision).toBe(applied.receipt.revision);
  const graph = await readGraph(active);
  expect(graph.revision).toBe(applied.receipt.revision);
  expect(nodeById(graph, "stale_node")).toBeUndefined();
});

test("neighborhood reports direction, blocking edges, and an interpretation", async () => {
  const { server: active } = await seeded();
  const outgoing = await neighborhood(active, {
    id: "prism_harness_installs",
    direction: "outgoing",
    blocking: true,
  });
  expect(outgoing.root).toBe("prism_harness_installs");
  expect(outgoing.blockingEdges).toContain(reframeEdgeId);
  expect(outgoing.interpretation.length).toBeGreaterThan(0);

  const incoming = await neighborhood(active, {
    id: "multi_machine_skills",
    direction: "incoming",
  });
  expect(incoming.edges.map((edge) => edge.id)).toContain(reframeEdgeId);
  expect(incoming.nodes.map((node) => node.id)).toContain(
    "prism_harness_installs",
  );
});

test("a mutual entanglement is preserved and reported as a cycle, not rejected", async () => {
  const { server: active } = await seeded();
  const graph = await readGraph(active);
  expect(edgeBetween(graph, "jev_skill", "skills_in_projects")?.relation).toBe(
    "requires",
  );
  expect(edgeBetween(graph, "skills_in_projects", "jev_skill")?.relation).toBe(
    "requires",
  );
  const both = await neighborhood(active, {
    id: "jev_skill",
    direction: "both",
  });
  expect(both.cycleDetected).toBe(true);
  expect(both.nodes.map((node) => node.id)).toContain("skills_in_projects");
});

test("reframe to optional keeps the idea and the original assertion, and changes blocking", async () => {
  const { server: active, revision } = await seeded();
  const before = await readGraph(active);
  expect(edgeById(before, reframeEdgeId)?.relation).toBe("requires");
  const blockedBefore = await neighborhood(active, {
    id: "prism_harness_installs",
    direction: "outgoing",
    blocking: true,
  });
  expect(blockedBefore.blockingEdges).toContain(reframeEdgeId);

  const reframed = await sendCommand(active, revision, {
    type: "edge.reframe",
    id: reframeEdgeId,
    relation: optionalRelationId,
    rationale:
      "Claimed prerequisite was a helpful improvement, not a blocker. Synthetic correction.",
    state: "asserted",
  });
  const after = await readGraph(active);
  const edge = edgeById(after, reframeEdgeId);
  expect(edge?.relation).toBe(optionalRelationId);
  expect(edge?.assertion.relation).toBe("requires");
  expect(edge?.assertion.rationale).toContain("install waits");
  expect(edge?.correction?.relation).toBe(optionalRelationId);
  expect(edge?.correction?.provenance.revision).toBe(reframed.receipt.revision);

  // The idea and its sources survive the reframe.
  const kept = nodeById(after, "multi_machine_skills");
  expect(kept?.sources[0]?.uri).toBe(
    "synthetic://document/multi-machine-skills",
  );

  const blockedAfter = await neighborhood(active, {
    id: "prism_harness_installs",
    direction: "outgoing",
    blocking: true,
  });
  expect(blockedAfter.blockingEdges).not.toContain(reframeEdgeId);

  const entries = await history(active);
  expect(entries.map((entry) => entry.revision)).toContain(
    reframed.receipt.revision,
  );
  expect(entries.map((entry) => entry.type)).toContain("edge.reframe");
});

test("a reframed pair cannot be silently restored by a later edge.put", async () => {
  const { server: active, revision } = await seeded();
  const reframed = await sendCommand(active, revision, {
    type: "edge.reframe",
    id: reframeEdgeId,
    relation: optionalRelationId,
    rationale: "Synthetic correction that must not be silently reverted.",
    state: "asserted",
  });
  const restore = await sendCommandExpectingFailure(
    active,
    reframed.receipt.revision,
    {
      type: "edge.put",
      edge: {
        id: "prism_requires_multi_machine_again",
        source: "prism_harness_installs",
        target: "multi_machine_skills",
        relation: "requires",
        rationale: "Agent attempt to reinstate the superseded prerequisite.",
      },
    },
  );
  expect(restore.status).toBeGreaterThanOrEqual(400);
  expect(restore.status).toBeLessThan(500);
  const graph = await readGraph(active);
  expect(
    edgeBetween(graph, "prism_harness_installs", "multi_machine_skills")
      ?.relation,
  ).toBe(optionalRelationId);
});

test("undo restores the prior relation, and is rejected after an intervening edit", async () => {
  const { server: active, revision } = await seeded();
  const first = await sendCommand(active, revision, {
    type: "edge.reframe",
    id: reframeEdgeId,
    relation: optionalRelationId,
    rationale: "Synthetic first reframe.",
    state: "asserted",
  });
  const second = await sendCommand(active, first.receipt.revision, {
    type: "edge.reframe",
    id: reframeEdgeId,
    relation: "related_to",
    rationale:
      "Synthetic second reframe, which makes the first undo ambiguous.",
    state: "asserted",
  });
  const rejected = await sendCommandExpectingFailure(
    active,
    second.receipt.revision,
    { type: "undo", revision: first.receipt.revision },
  );
  expect(rejected.status).toBe(409);

  const undone = await sendCommand(active, second.receipt.revision, {
    type: "undo",
    revision: second.receipt.revision,
  });
  const graph = await readGraph(active);
  expect(graph.revision).toBe(undone.receipt.revision);
  expect(edgeById(graph, reframeEdgeId)?.relation).toBe(optionalRelationId);
});

test("node edits never mutate captures or sources, and archived nodes keep references", async () => {
  const { server: active, revision } = await seeded();
  const before = await readGraph(active);
  const captureBefore = before.captures[0];
  const sourcesBefore = nodeById(before, "jev_skill")?.sources;

  const edited = await sendCommand(active, revision, {
    type: "node.put",
    node: {
      id: "jev_skill",
      title: "Jev skill",
      description:
        "Edited description that must not touch the capture or sources.",
      project: "synthetic-project",
      status: "archived",
      sources: [
        {
          uri: "synthetic://document/jev-skill",
          label: "Synthetic skill note",
        },
      ],
    },
  });

  const after = await readGraph(active);
  expect(after.captures[0]).toEqual(captureBefore);
  const node = nodeById(after, "jev_skill");
  expect(node?.description).toContain("Edited description");
  expect(node?.status).toBe("archived");
  expect(node?.sources).toEqual(sourcesBefore ?? []);
  expect(node?.created.revision).toBeLessThan(edited.receipt.revision);
  expect(node?.updated.revision).toBe(edited.receipt.revision);

  // References from an archived node stay valid and readable.
  const graph = await readGraph(active);
  expect(edgeBetween(graph, "jev_skill", "skills_in_projects")).toBeDefined();
  expect(edgeBetween(graph, "skills_in_projects", "jev_skill")).toBeDefined();
  const neighborhoodOfArchived = await neighborhood(active, {
    id: "jev_skill",
    direction: "both",
  });
  expect(neighborhoodOfArchived.nodes.map((entry) => entry.id)).toContain(
    "skills_in_projects",
  );
});

test("suggestions stay distinct from assertions and are decided explicitly", async () => {
  const { server: active, revision } = await seeded();
  const recorded = await sendCommand(active, revision, {
    type: "suggestion.record",
    // An evaluation is recorded against the revision it observed.
    suggestion: { ...suggestion, basedOnRevision: revision },
  });
  const withSuggestion = await readGraph(active);
  expect(
    withSuggestion.suggestions.find((entry) => entry.id === suggestion.id)
      ?.status,
  ).toBe("pending");
  expect(
    edgeBetween(withSuggestion, suggestion.source, suggestion.target),
  ).toBeUndefined();
  expect(withSuggestion.nodes).toHaveLength(nodes.length);

  const decided = await sendCommand(active, recorded.receipt.revision, {
    type: "suggestion.decide",
    id: suggestion.id,
    decision: "accept",
    rationale: "Synthetic owner decision to accept the proposal.",
  });
  const after = await readGraph(active);
  const decidedSuggestion = after.suggestions.find(
    (entry) => entry.id === suggestion.id,
  );
  expect(decidedSuggestion?.status).toBe("accepted");
  expect(decidedSuggestion?.decision?.revision).toBe(decided.receipt.revision);
  const edge = edgeBetween(after, suggestion.source, suggestion.target);
  expect(edge?.relation).toBe(suggestion.relation);
});

test("positions, search, and export survive a restart with the correction intact", async () => {
  const { server: active, revision } = await seeded();
  const positioned = await sendCommand(active, revision, {
    type: "layout.set",
    positions: [
      { id: "multi_machine_skills", x: -240.5, y: 88.25, pinned: true },
      { id: "prism_harness_installs", x: 10, y: 12, pinned: false },
    ],
  });
  const reframed = await sendCommand(active, positioned.receipt.revision, {
    type: "edge.reframe",
    id: reframeEdgeId,
    relation: optionalRelationId,
    rationale: "Synthetic correction that must survive a restart.",
    state: "asserted",
  });
  const before = await readGraph(active);
  const beforeHistory = await history(active);

  await active.restart();

  const after = await readGraph(active);
  expect(after.revision).toBe(reframed.receipt.revision);
  expect(after.nodes.map((node) => node.id).sort()).toEqual(
    before.nodes.map((node) => node.id).sort(),
  );
  expect(edgeById(after, reframeEdgeId)?.relation).toBe(optionalRelationId);
  expect(edgeById(after, reframeEdgeId)?.assertion.relation).toBe("requires");
  const position = nodeById(after, "multi_machine_skills")?.position;
  expect(position?.x).toBe(-240.5);
  expect(position?.y).toBe(88.25);
  expect(position?.pinned).toBe(true);
  expect((await history(active)).length).toBe(beforeHistory.length);

  const found = await search(active, "multi-machine");
  expect(found.map((node) => node.id)).toContain("multi_machine_skills");
  const exported = await exportAll(active);
  expect(exported.graph.revision).toBe(after.revision);
  expect(exported.history.length).toBe(beforeHistory.length);
  expect(nodeByTitle(exported.graph, "Jev skill")?.id).toBe("jev_skill");

  const stream = await active.events({ after: after.revision });
  const live = await sendCommand(active, after.revision, {
    type: "node.put",
    node: {
      id: "post_restart_node",
      title: "Post-restart node",
      description: "Synthetic node written after the server restarted.",
      project: "synthetic-project",
      status: "idea",
      sources: [],
    },
  });
  await stream.waitForRevision(live.receipt.revision);
  stream.close();
});

test("taxonomy edits version the definitions without erasing edges or corrections", async () => {
  const { server: active, revision } = await seeded();
  const reframed = await sendCommand(active, revision, {
    type: "edge.reframe",
    id: reframeEdgeId,
    relation: optionalRelationId,
    rationale: "Synthetic correction made under the original definition.",
    state: "asserted",
  });
  const before = await readGraph(active);
  const edited = before.taxonomy.relations.map((relation) =>
    relation.id === optionalRelationId
      ? {
          ...relation,
          definition: `${relation.definition} (edited by a synthetic acceptance run)`,
        }
      : relation,
  );
  const replaced = await sendCommand(active, reframed.receipt.revision, {
    type: "taxonomy.replace",
    relations: edited,
  });
  const after = await readGraph(active);
  expect(after.taxonomy.version).toBeGreaterThan(before.taxonomy.version);
  expect(replaced.receipt.revision).toBe(after.revision);
  expect(
    after.taxonomy.relations.find(
      (relation) => relation.id === optionalRelationId,
    )?.definition,
  ).toContain("edited by a synthetic acceptance run");
  const edge = edgeById(after, reframeEdgeId);
  expect(edge?.relation).toBe(optionalRelationId);
  expect(edge?.assertion.relation).toBe("requires");
  expect(edge?.correction?.rationale).toContain("original definition");

  // Removing a relation that an edge still uses must not silently drop or
  // rewrite the edge: the command fails, or the graph stays internally valid.
  const withoutRequires = after.taxonomy.relations.filter(
    (relation) => relation.id !== "requires",
  );
  const removal = await sendCommandExpectingFailure(active, after.revision, {
    type: "taxonomy.replace",
    relations: withoutRequires,
  });
  const final = await readGraph(active);
  if (removal.status >= 400) {
    expect(final.taxonomy.relations.map((relation) => relation.id)).toContain(
      "requires",
    );
  } else {
    const relationIds = new Set(
      final.taxonomy.relations.map((relation) => relation.id),
    );
    for (const candidate of final.edges) {
      expect(relationIds.has(candidate.relation)).toBe(true);
    }
  }
  expect(edgeById(final, reframeEdgeId)?.assertion.relation).toBe("requires");
  expect((await history(active)).map((entry) => entry.type)).toContain(
    "taxonomy.replace",
  );
});

test("a stale evaluation is refused rather than silently applied", async () => {
  const { server: active, revision } = await seeded();
  const moved = await sendCommand(active, revision, {
    type: "node.put",
    node: {
      id: "post_evaluation_edit",
      title: "Post-evaluation edit",
      description: "Moves the revision after the evaluation observed it.",
      project: "synthetic-project",
      status: "idea",
      sources: [],
    },
  });
  const stale = await sendCommandExpectingFailure(
    active,
    moved.receipt.revision,
    {
      type: "suggestion.record",
      suggestion: { ...suggestion, basedOnRevision: revision },
    },
  );
  expect(stale.status).toBe(409);
  const body = stale.body as { error?: string; message?: string };
  expect(body.error).toBe("Conflict");
  expect(body.message ?? "").toMatch(/older|stale/i);
  const graph = await readGraph(active);
  expect(graph.revision).toBe(moved.receipt.revision);
  expect(graph.suggestions).toHaveLength(0);
  expect(
    edgeBetween(graph, suggestion.source, suggestion.target),
  ).toBeUndefined();
});

test("an evaluation without a provider key is unavailable and changes nothing", async () => {
  const { server: active, revision } = await seeded();
  const before = await readGraph(active);
  const posted = await active.json<{ evaluationId: string }>(
    "/api/evaluations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: nextRequestId("acceptance-eval"),
        expectedRevision: revision,
        query: "synthetic query with no provider key configured",
      }),
    },
  );
  expect(typeof posted.evaluationId).toBe("string");
  expect(posted.evaluationId.length).toBeGreaterThan(0);

  const fetched = await active.json<{
    result: { status?: string; failure?: { code?: string; message?: string } };
  }>(`/api/evaluations/${encodeURIComponent(posted.evaluationId)}`);
  expect(fetched.result.status).toBe("unavailable");
  expect(fetched.result.failure?.code).toBeTruthy();

  const after = await readGraph(active);
  const summary = after.evaluations.find(
    (entry) => entry.id === posted.evaluationId,
  );
  expect(summary?.status).toBe("unavailable");
  // The graph carries a summary, not the raw provider payload.
  expect(Object.keys(summary ?? {}).sort()).toEqual(
    [
      "basedOnRevision",
      "id",
      "inputHash",
      "provenance",
      "status",
      "taxonomyVersion",
    ].sort(),
  );
  expect(JSON.stringify(after.evaluations)).not.toContain("rawResponse");
  // No fabricated judgment: no suggestions, no edges, no node changes.
  expect(after.suggestions).toHaveLength(before.suggestions.length);
  expect(after.edges).toHaveLength(before.edges.length);
  expect(after.nodes).toHaveLength(before.nodes.length);
});

test("graph reads and writes fail closed without a credential", async () => {
  const { server: active } = await seeded();
  const read = await active.fetchAnonymous("/api/graph");
  expect(read.status).toBe(401);
  const body = (await read.json()) as { error?: string };
  expect(body.error).toBe("Unauthorized");
  const wrongToken = await active.fetch("/api/graph", {
    headers: { authorization: `Bearer ${acceptanceToken}-wrong` },
  });
  expect(wrongToken.status).toBe(401);
  const write = await active.fetchAnonymous("/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "acceptance-anonymous",
      expectedRevision: 0,
      command: { type: "undo", revision: 0 },
    }),
  });
  // A credential-less write is unauthenticated: the cookie path short-circuits
  // with 401 before the origin check runs, so the origin requirement only
  // applies once a cookie is present.
  expect(write.status).toBe(401);
  const foreignOrigin = await active.fetchAnonymous("/api/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({
      requestId: "acceptance-anonymous-foreign",
      expectedRevision: 0,
      command: { type: "undo", revision: 0 },
    }),
  });
  expect(foreignOrigin.status).toBe(403);
  const graph: GraphSnapshot = await readGraph(active);
  expect(graph.revision).toBe(1);
});

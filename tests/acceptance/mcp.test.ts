// MCP parity: the agent surface must expose the same graph as HTTP, with the
// actor derived from the credential and the channel from the entrypoint.
import { afterEach, expect, test } from "bun:test";
import {
  history,
  readGraph,
  sendCommand,
  type GraphSnapshot,
} from "./contract";
import {
  capture as captureFixture,
  edges as fixtureEdges,
  nodes as fixtureNodes,
} from "./fixtures";
import { startServer, type ServerHandle } from "./harness";
import { callTool, listTools, openSession, rpc } from "./mcp";

let server: ServerHandle | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test("MCP requires a bearer before JSON-RPC and lists the shared tools", async () => {
  server = await startServer();
  const anonymous = await rpc(
    server,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "anonymous", version: "0" },
      },
    },
    { anonymous: true },
  );
  expect(anonymous.status).toBe(401);

  const session = await openSession(server);
  const tools = (await listTools(server, session)).sort();
  expect(tools).toContain("graph_command");
  expect(tools).toContain("graph_read");
  expect(tools).toContain("graph_discover");
  expect(tools).toContain("graph_evaluate");
  expect(tools).toContain("graph_preview");
  // No provider key in acceptance: an honest unavailable, and nothing written.
  const preview = await callTool(server, session, "graph_preview", {
    draft: { title: "Ship the release" },
  });
  expect(JSON.stringify(preview)).toContain("unavailable");
});

test("an MCP capture is the same graph HTTP and the UI read", async () => {
  server = await startServer();
  const session = await openSession(server);
  const called = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-capture",
    expectedRevision: 0,
    command: {
      type: "capture",
      capture: captureFixture,
      nodes: fixtureNodes,
      edges: fixtureEdges,
    },
  });
  expect(called.isError).toBeFalsy();
  const structured = called.structuredContent as {
    receipt?: { revision?: number; actor?: { id?: string; channel?: string } };
    replayed?: boolean;
  };
  expect(structured.receipt?.revision).toBe(1);
  expect(structured.receipt?.actor?.channel).toBe("mcp");
  expect(structured.replayed).toBe(false);

  const overHttp: GraphSnapshot = await readGraph(server);
  expect(overHttp.revision).toBe(1);
  expect(overHttp.nodes.map((node) => node.id).sort()).toEqual(
    fixtureNodes.map((node) => node.id).sort(),
  );

  const read = await callTool(
    server,
    session,
    "graph_read",
    { view: "graph" },
    3,
  );
  const graph = read.structuredContent as GraphSnapshot;
  expect(graph.revision).toBe(1);
  expect(graph.nodes.map((node) => node.id)).toContain("multi_machine_skills");

  // The reverse direction: an HTTP write is visible to the agent surface.
  const httpWrite = await sendCommand(server, 1, {
    type: "node.put",
    node: {
      id: "http_side_node",
      title: "HTTP side node",
      description: "Written over HTTP, read back through MCP.",
      project: "synthetic-project",
      status: "idea",
      sources: [],
    },
  });
  const readBack = await callTool(
    server,
    session,
    "graph_read",
    { view: "graph" },
    4,
  );
  const after = readBack.structuredContent as GraphSnapshot;
  expect(after.revision).toBe(httpWrite.receipt.revision);
  expect(after.nodes.map((node) => node.id)).toContain("http_side_node");
});

test("MCP replay is idempotent and a stale revision conflicts without writing", async () => {
  server = await startServer();
  const session = await openSession(server);
  const command = {
    type: "capture" as const,
    capture: captureFixture,
    nodes: fixtureNodes,
    edges: fixtureEdges,
  };
  const first = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-replay",
    expectedRevision: 0,
    command,
  });
  const replay = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-replay",
    expectedRevision: 0,
    command,
  });
  const firstStructured = first.structuredContent as {
    receipt?: { revision?: number };
    replayed?: boolean;
  };
  const replayStructured = replay.structuredContent as {
    receipt?: { revision?: number };
    replayed?: boolean;
  };
  expect(firstStructured.replayed).toBe(false);
  expect(replayStructured.replayed).toBe(true);
  expect(replayStructured.receipt?.revision).toBe(
    firstStructured.receipt?.revision,
  );
  const graph = await readGraph(server);
  expect(graph.nodes).toHaveLength(fixtureNodes.length);

  const stale = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-stale",
    expectedRevision: 0,
    command: {
      type: "node.put",
      node: {
        id: "stale_mcp_node",
        title: "Stale MCP node",
        description: "Must never be written at a stale revision.",
        project: "synthetic-project",
        status: "idea",
        sources: [],
      },
    },
  });
  expect(stale.isError).toBe(true);
  const text = (stale.content ?? []).map((part) => part.text ?? "").join(" ");
  expect(text).toMatch(/Conflict/);
  const after = await readGraph(server);
  expect(after.nodes.map((node) => node.id)).not.toContain("stale_mcp_node");
  expect(after.revision).toBe(graph.revision);
});

test("an agent can remove what it captured even after intervening edits", async () => {
  server = await startServer();
  const session = await openSession(server);
  // The reported incident: a capture, then an intervening layout edit, made
  // the capture impossible to undo and there was no delete operation.
  const captured = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-remove-capture",
    expectedRevision: 0,
    command: {
      type: "capture",
      capture: captureFixture,
      nodes: fixtureNodes,
      edges: fixtureEdges,
    },
  });
  expect(captured.isError).toBeFalsy();
  await sendCommand(server, 1, {
    type: "layout.set",
    positions: [{ id: "jev_skill", x: 12, y: 8, pinned: true }],
  });
  const undo = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-undo-stale",
    expectedRevision: 2,
    command: { type: "undo", revision: 1 },
  });
  expect(undo.isError).toBe(true);

  // node.remove cascades one wrong node out of the tangle, edges included.
  const removed = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-remove-node",
    expectedRevision: 2,
    command: {
      type: "node.remove",
      ids: ["multi_machine_skills"],
      removeEdges: true,
      rationale: "captured in error",
    },
  });
  expect(removed.isError).toBeFalsy();
  const graph = await readGraph(server);
  expect(graph.revision).toBe(3);
  expect(graph.nodes.map((node) => node.id)).not.toContain(
    "multi_machine_skills",
  );
  expect(
    graph.edges.find((edge) => edge.id === "prism_requires_multi_machine"),
  ).toBeUndefined();
  expect(graph.nodes.map((node) => node.id)).toContain(
    "prism_harness_installs",
  );

  // MCP sees the same removal and reports the node gone.
  const gone = await callTool(
    server,
    session,
    "graph_read",
    { view: "node", id: "multi_machine_skills" },
    9,
  );
  expect(gone.isError).toBe(true);
  const keeper = await callTool(
    server,
    session,
    "graph_read",
    { view: "node", id: "jev_skill" },
    10,
  );
  expect(keeper.isError).toBeFalsy();
  const kept = await callTool(
    server,
    session,
    "graph_read",
    {
      view: "edge",
      source: "skills_in_projects",
      target: "prism_harness_installs",
    },
    11,
  );
  expect(kept.isError).toBeFalsy();

  // edge.remove by directed pair plus capture.remove finish the cleanup.
  const edgeGone = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-remove-edge",
    expectedRevision: 3,
    command: {
      type: "edge.remove",
      source: "skills_in_projects",
      target: "jev_skill",
      rationale: "mutual claim was wrong",
    },
  });
  expect(edgeGone.isError).toBeFalsy();
  const capGone = await callTool(server, session, "graph_command", {
    requestId: "acceptance-mcp-remove-capture-record",
    expectedRevision: 4,
    command: {
      type: "capture.remove",
      id: "capture_worked_example",
      rationale: "captured in error",
    },
  });
  expect(capGone.isError).toBeFalsy();

  const final = await readGraph(server);
  expect(final.captures).toHaveLength(0);
  expect(final.edges.map((edge) => edge.id)).not.toContain(
    "skills_in_projects_requires_jev_skill",
  );
  // The journal still proves every removal happened and who commanded it.
  const entries = await history(server);
  expect(entries.map((entry) => entry.command.type)).toEqual(
    expect.arrayContaining(["node.remove", "edge.remove", "capture.remove"]),
  );
  expect(
    entries.find((entry) => entry.command.type === "node.remove")?.actor
      ?.channel,
  ).toBe("mcp");
});

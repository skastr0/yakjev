// MCP parity: the agent surface must expose the same graph as HTTP, with the
// actor derived from the credential and the channel from the entrypoint.
import { afterEach, expect, test } from "bun:test";
import { readGraph, sendCommand, type GraphSnapshot } from "./contract";
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

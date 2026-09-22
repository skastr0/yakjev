// CLI acceptance: the real yakjev binary over loopback HTTP against a real
// server, with the minimal env an agent would get. Assertions read the JSON
// envelope on stdout/stderr and the exit code — never server internals.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "bun";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  CommandResult,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  HistoryEntry,
} from "./contract";
import { readGraph } from "./contract";
import {
  capture as captureFixture,
  edges as fixtureEdges,
  nodes as fixtureNodes,
} from "./fixtures";
import { acceptanceToken, startServer, type ServerHandle } from "./harness";

const repoRoot = resolve(import.meta.dir, "../..");
const cliEntry = "packages/cli/src/cli.ts";

let server: ServerHandle | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the committed CLI entrypoint. Env is deliberately minimal: a
 * nonexistent YAKJEV_CONFIG inside the disposable data dir proves env config
 * is honored and keeps the real ~/.config/yakjev out of the run.
 */
async function runCli(
  origin: string,
  args: readonly string[],
  options: { stdin?: string; token?: string } = {},
): Promise<CliRun> {
  const child = spawn({
    cmd: ["bun", "run", cliEntry, ...args],
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      YAKJEV_REMOTE_URL: origin,
      YAKJEV_OWNER_TOKEN: options.token ?? acceptanceToken,
      YAKJEV_CONFIG: join(server!.dataDir, "absent-client-config.json"),
    },
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(
    child.stdout as ReadableStream<Uint8Array>,
  ).text();
  const stderr = new Response(
    child.stderr as ReadableStream<Uint8Array>,
  ).text();
  if (options.stdin !== undefined) {
    const sink = child.stdin;
    if (!sink || typeof sink === "number")
      throw new Error("CLI child stdin was not piped");
    sink.write(options.stdin);
    sink.end();
  }
  const code = await child.exited;
  return { code, stdout: await stdout, stderr: await stderr };
}

async function okJson<T>(origin: string, args: readonly string[]): Promise<T> {
  const run = await runCli(origin, args);
  if (run.code !== 0)
    throw new Error(
      `yakjev ${args.join(" ")} exited ${run.code}\n${run.stderr}`,
    );
  expect(run.stderr).toBe("");
  const envelope = JSON.parse(run.stdout) as {
    ok: boolean;
    command: string;
    data: T;
  };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

test("doctor reports a ready session and capabilities enumerate the surface", async () => {
  server = await startServer();
  const doctor = await okJson<{
    status: string;
    remoteUrl: string;
    token: string;
    health: { status: string; service: string };
    actor: { actor: { id: string; channel: string } };
  }>(server.origin, ["doctor"]);
  expect(doctor.status).toBe("ready");
  expect(doctor.remoteUrl).toBe(server.origin);
  expect(doctor.token).toBe("configured");
  expect(doctor.health.status).toBe("ok");
  // Bearer over /api derives the browser-channel owner actor.
  expect(doctor.actor.actor).toEqual({ id: "owner", channel: "browser" });

  const capabilities = await okJson<{
    commands: string[];
    reads: { view: string }[];
  }>(server.origin, ["capabilities"]);
  expect(capabilities.commands).toEqual(
    expect.arrayContaining(["node.remove", "edge.remove", "capture.remove"]),
  );
  expect(capabilities.reads.map((read) => read.view)).toEqual(
    expect.arrayContaining(["node", "edge", "history"]),
  );
  const schema = await okJson<{
    commands: Record<string, { fields: Record<string, unknown> }>;
    reads: Record<string, unknown>;
  }>(server.origin, ["schema"]);
  expect(Object.keys(schema.commands)).toEqual(
    expect.arrayContaining(["node.remove", "edge.remove", "undo"]),
  );
  expect(Object.keys(schema.reads)).toEqual(
    expect.arrayContaining(["node", "edge"]),
  );

  // A named schema entry and the example payloads are part of the surface.
  const nodeRemove = await okJson<{ notes: string[] }>(server.origin, [
    "schema",
    "node.remove",
  ]);
  expect(nodeRemove.notes.length).toBeGreaterThan(0);
  const example = await okJson<{ command?: { type?: string } }>(server.origin, [
    "examples",
    "capture",
  ]);
  expect(example.command?.type).toBe("capture");

  const unknownEntry = await runCli(server.origin, ["schema", "bogus"]);
  expect(unknownEntry.code).toBe(1);
  expect(
    (JSON.parse(unknownEntry.stderr) as { error: { type: string } }).error.type,
  ).toBe("CliInputError");
}, 30_000);

test("an agent can run the whole graph loop through the CLI", async () => {
  server = await startServer();
  const origin = server.origin;

  const captureRequest = {
    requestId: "cli-acceptance-capture",
    expectedRevision: 0,
    command: {
      type: "capture",
      capture: captureFixture,
      nodes: fixtureNodes,
      edges: fixtureEdges,
    },
  };
  const captured = await okJson<CommandResult>(origin, [
    "command",
    JSON.stringify(captureRequest),
  ]);
  expect(captured.receipt.revision).toBe(1);
  expect(captured.receipt.type).toBe("capture");
  expect(captured.receipt.actor.channel).toBe("browser");
  expect(captured.replayed).toBe(false);

  // Identical requestId replays the original receipt without a new revision.
  const replayed = await okJson<CommandResult>(origin, [
    "command",
    JSON.stringify(captureRequest),
  ]);
  expect(replayed.replayed).toBe(true);
  expect(replayed.receipt.revision).toBe(1);
  expect((await readGraph(server)).revision).toBe(1);

  // Granular reads: node by id, edge by directed pair and by id.
  const node = await okJson<GraphNode>(origin, [
    "read",
    "node",
    JSON.stringify({ id: "jev_skill" }),
  ]);
  expect(node.title).toBe("Jev skill");
  const byPair = await okJson<GraphEdge>(origin, [
    "read",
    "edge",
    JSON.stringify({
      source: "skills_in_projects",
      target: "prism_harness_installs",
    }),
  ]);
  expect(byPair.id).toBe("skills_in_projects_requires_prism");
  const byId = await okJson<GraphEdge>(origin, [
    "read",
    "edge",
    JSON.stringify({ id: "skills_in_projects_requires_jev_skill" }),
  ]);
  expect(byId.source).toBe("skills_in_projects");

  // An id that resolves to a different pair than source/target is a caller
  // error, not a lookup failure.
  const mismatch = await runCli(origin, [
    "read",
    "edge",
    JSON.stringify({
      id: "jev_projects_requires_jev_skill",
      source: "skills_in_projects",
      target: "jev_skill",
    }),
  ]);
  expect(mismatch.code).toBe(1);
  expect(
    (JSON.parse(mismatch.stderr) as { error: { type: string } }).error.type,
  ).toBe("CliInputError");

  // A stale expectedRevision conflicts: ok:false envelope on stderr, exit 1.
  const stale = await runCli(origin, [
    "command",
    JSON.stringify({
      requestId: "cli-acceptance-stale",
      expectedRevision: 0,
      command: { type: "node.put", node: fixtureNodes[0] },
    }),
  ]);
  expect(stale.code).toBe(1);
  expect(stale.stdout).toBe("");
  const failure = JSON.parse(stale.stderr) as {
    ok: boolean;
    command: string;
    error: {
      type: string;
      message: string;
      details?: { error?: string; currentRevision?: number };
    };
  };
  expect(failure.ok).toBe(false);
  expect(failure.command).toBe("yakjev");
  expect(failure.error.type).toBe("ApiError");
  expect(failure.error.details?.error).toBe("Conflict");
  expect(failure.error.details?.currentRevision).toBe(1);
  expect((await readGraph(server)).revision).toBe(1);

  // edge.remove with suppress via stdin: the wrong mutual claim is deleted and
  // the pair stays rejected for machine inference.
  const edgeRemoved = await runCli(origin, ["command", "-"], {
    stdin: JSON.stringify({
      expectedRevision: 1,
      command: {
        type: "edge.remove",
        source: "skills_in_projects",
        target: "jev_skill",
        suppress: true,
        rationale: "mutual claim was wrong; do not re-propose",
      },
    }),
  });
  expect(edgeRemoved.code).toBe(0);
  const removedResult = (
    JSON.parse(edgeRemoved.stdout) as { data: CommandResult }
  ).data;
  expect(removedResult.receipt.revision).toBe(2);
  const afterEdge = await okJson<GraphSnapshot>(origin, ["read", "graph"]);
  expect(afterEdge.revision).toBe(2);
  expect(
    afterEdge.edges.find(
      (edge) =>
        edge.source === "skills_in_projects" && edge.target === "jev_skill",
    ),
  ).toBeUndefined();
  expect(
    afterEdge.suggestions.find(
      (suggestion) =>
        suggestion.status === "rejected" &&
        suggestion.source === "skills_in_projects" &&
        suggestion.target === "jev_skill",
    )?.model,
  ).toBe("actor-suppression");

  // node.remove cascades the blocker and its incident edge via @file payload.
  const nodeRemovePayload = join(server.dataDir, "node-remove.json");
  await writeFile(
    nodeRemovePayload,
    JSON.stringify({
      expectedRevision: 2,
      command: {
        type: "node.remove",
        ids: ["multi_machine_skills"],
        removeEdges: true,
        rationale: "captured in error",
      },
    }),
  );
  const nodeRemoved = await okJson<CommandResult>(origin, [
    "command",
    `@${nodeRemovePayload}`,
  ]);
  expect(nodeRemoved.receipt.revision).toBe(3);

  const gone = await runCli(origin, [
    "read",
    "node",
    JSON.stringify({ id: "multi_machine_skills" }),
  ]);
  expect(gone.code).toBe(1);
  expect(
    (JSON.parse(gone.stderr) as { error: { type: string } }).error.type,
  ).toBe("ApiError");
  const finalGraph = await readGraph(server);
  expect(finalGraph.nodes.map((item) => item.id)).not.toContain(
    "multi_machine_skills",
  );
  expect(
    finalGraph.edges.find((edge) => edge.id === "prism_requires_multi_machine"),
  ).toBeUndefined();

  // History is the same journal HTTP sees, receipts attributed to the CLI actor.
  const entries = await okJson<HistoryEntry[]>(origin, [
    "read",
    "history",
    JSON.stringify({ after: 0, limit: 50 }),
  ]);
  expect(entries.map((entry) => entry.command.type)).toEqual([
    "capture",
    "edge.remove",
    "node.remove",
  ]);
  expect(entries.every((entry) => entry.actor.channel === "browser")).toBe(
    true,
  );
}, 60_000);

test("input errors report ok:false on stderr with exit 1", async () => {
  server = await startServer();
  const badJson = await runCli(server.origin, ["command", "{ not json"]);
  expect(badJson.code).toBe(1);
  const parsed = JSON.parse(badJson.stderr) as {
    ok: boolean;
    error: { type: string };
  };
  expect(parsed.ok).toBe(false);
  expect(parsed.error.type).toBe("CliInputError");

  const unknownEdge = await runCli(server.origin, [
    "read",
    "edge",
    JSON.stringify({ id: "ghost" }),
  ]);
  expect(unknownEdge.code).toBe(1);
  expect(
    (JSON.parse(unknownEdge.stderr) as { error: { type: string } }).error.type,
  ).toBe("ApiError");

  const unknownView = await runCli(server.origin, [
    "read",
    "bogus",
    JSON.stringify({}),
  ]);
  expect(unknownView.code).toBe(1);
  expect(
    (JSON.parse(unknownView.stderr) as { error: { type: string } }).error.type,
  ).toBe("CliInputError");
}, 30_000);

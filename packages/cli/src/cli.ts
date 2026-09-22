#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import {
  CommandRequest,
  EvaluationRequest,
  type Graph,
} from "@yakjev/protocol";
import { Effect, Schema } from "effect";
import { parseCliArguments } from "./argv";
import { ApiError, CliConfigError, CliInputError, request } from "./client";
import {
  configuredOwnerToken,
  configuredRemoteUrl,
  defaultClientConfigPath,
} from "./config";
import { fail, ok, writeJson } from "./json";

const valueOptionNames = new Set(["--server", "--token", "--timeout-ms"]);
const booleanOptionNames = new Set(["--help", "--version", "-h", "-v"]);

const usage = `yakjev — agent CLI for the yakjev graph (HTTP mirror of the MCP tools)

Usage:
  yakjev read <view> [json|@file|-]   graph | history | search | neighborhood |
                                      export | evaluation | node | edge
  yakjev command <json|@file|->       submit a CommandRequest {requestId,
                                      expectedRevision, command}
  yakjev discover [json|@file|-]      {query, focusNodeId?, includeNodeIds?}
  yakjev evaluate <json|@file|->      EvaluationRequest {requestId,
                                      expectedRevision, query, focusNodeId?,
                                      includeNodeIds?}
  yakjev doctor                       resolve config, check health and auth
  yakjev capabilities                 list commands and read views
  yakjev schema                       command and view reference

Config: YAKJEV_REMOTE_URL + YAKJEV_OWNER_TOKEN, or
${defaultClientConfigPath()} with {"remoteUrl": "...", "ownerToken": "..."}.
Flags: --server, --token, --timeout-ms. Domain payloads are JSON; pass inline,
@file, or "-" for stdin. Output is a JSON envelope on stdout (errors: stderr,
exit 1). Omit requestId to mint a fresh one; supply it for safe replay.
`;

const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown): A =>
  Effect.runSync(Schema.decodeUnknownEffect(schema)(input));

const readJsonArg = async (source: string | undefined): Promise<unknown> => {
  if (source === undefined) return {};
  const text =
    source === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : source.startsWith("@")
        ? readFileSync(source.slice(1), "utf8")
        : source;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliInputError(
      "Payload is not valid JSON",
      source === "-" ? "stdin" : source,
    );
  }
};

const requireServer = (args: ReturnType<typeof parseCliArguments>) => {
  const remoteUrl = args.first("--server") ?? configuredRemoteUrl();
  if (remoteUrl === undefined)
    throw new CliConfigError(
      "No remote configured: set YAKJEV_REMOTE_URL or remoteUrl in " +
        defaultClientConfigPath(),
    );
  const token = args.first("--token") ?? configuredOwnerToken();
  if (token === undefined)
    throw new CliConfigError(
      "No owner token: set YAKJEV_OWNER_TOKEN or ownerToken in " +
        defaultClientConfigPath(),
    );
  const timeout = Number(args.first("--timeout-ms") ?? 30000);
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new CliInputError("--timeout-ms must be a positive number");
  return { remoteUrl, token, timeoutMs: timeout };
};

const requireParam = <T>(value: T | undefined, name: string): T => {
  if (value === undefined)
    throw new CliInputError(`Missing required parameter ${name}`, {
      hint: "Pass view parameters as a JSON object",
    });
  return value;
};

const notFound = (message: string) =>
  new ApiError(404, "NotFound", message, undefined);

const runRead = async (
  client: ReturnType<typeof requireServer>,
  view: string,
  params: Record<string, unknown>,
): Promise<unknown> => {
  switch (view) {
    case "graph":
      return request(client, "GET", "/api/graph");
    case "export":
      return request(client, "GET", "/api/export");
    case "history":
      return request(client, "GET", "/api/history", undefined, {
        after: Number(params.after ?? 0),
        limit: Number(params.limit ?? 100),
      });
    case "search":
      return request(client, "GET", "/api/search", undefined, {
        q: String(requireParam(params.query, "query")),
      });
    case "neighborhood":
      return request(client, "GET", "/api/neighborhood", undefined, {
        id: String(requireParam(params.id, "id")),
        direction: String(params.direction ?? "outgoing"),
        blocking: params.blocking === true ? "true" : "false",
      });
    case "evaluation":
      return request(
        client,
        "GET",
        `/api/evaluations/${encodeURIComponent(String(requireParam(params.id, "id")))}`,
      );
    case "node": {
      const id = String(requireParam(params.id, "id"));
      const graph = (await request(client, "GET", "/api/graph")) as Graph;
      const node = graph.nodes.find((item) => item.id === id);
      if (!node) throw notFound(`Unknown node: ${id}`);
      return node;
    }
    case "edge": {
      const graph = (await request(client, "GET", "/api/graph")) as Graph;
      const byId =
        typeof params.id === "string"
          ? graph.edges.find((item) => item.id === params.id)
          : undefined;
      const byPair =
        typeof params.source === "string" && typeof params.target === "string"
          ? graph.edges.find(
              (item) =>
                item.source === params.source && item.target === params.target,
            )
          : undefined;
      if (byId && byPair && byId.id !== byPair.id)
        throw new CliInputError("id disagrees with the given source or target");
      const edge = byId ?? byPair;
      if (!edge)
        throw params.id === undefined &&
          (params.source === undefined || params.target === undefined)
          ? new CliInputError(
              "edge requires an id or a directed source and target",
            )
          : notFound("Unknown edge");
      return edge;
    }
    default:
      throw new CliInputError(`Unknown read view: ${view}`, {
        views: [
          "graph",
          "history",
          "search",
          "neighborhood",
          "export",
          "evaluation",
          "node",
          "edge",
        ],
      });
  }
};

const capabilities = {
  service: "yakjev",
  transport: "https",
  auth: "Authorization: Bearer <YAKJEV_OWNER_TOKEN>",
  actorChannel: "server-derived: bearer over /api records channel 'browser'",
  reads: [
    { view: "graph", description: "Current graph document" },
    { view: "history", params: "{after?, limit?}" },
    { view: "search", params: "{query}" },
    {
      view: "neighborhood",
      params: "{id, direction?: outgoing|incoming|both, blocking?}",
    },
    { view: "export", description: "Graph plus complete journal" },
    { view: "evaluation", params: "{id}" },
    { view: "node", params: "{id}" },
    { view: "edge", params: "{id} or {source, target} directed" },
  ],
  commands: [
    "capture",
    "capture.remove",
    "node.put",
    "node.remove",
    "edge.put",
    "edge.remove",
    "edge.reframe",
    "layout.set",
    "taxonomy.replace",
    "suggestion.record",
    "suggestion.decide",
    "evaluation.record",
    "undo",
  ],
  discovery: "yakjev discover {query, focusNodeId?, includeNodeIds?}",
  evaluation: "yakjev evaluate {requestId, expectedRevision, query, ...}",
  notes: [
    "Commands are revision-checked; read graph.revision first.",
    "Re-sending an identical requestId replays its receipt; a changed payload conflicts.",
    "node.remove needs removeEdges:true to cascade incident edges.",
    "edge.remove suppress defaults on for corrected or disputed edges.",
  ],
};

const doctor = async (args: ReturnType<typeof parseCliArguments>) => {
  const remoteUrl = args.first("--server") ?? configuredRemoteUrl();
  const token = args.first("--token") ?? configuredOwnerToken();
  const report: Record<string, unknown> = {
    remoteUrl: remoteUrl ?? null,
    token: token === undefined ? "missing" : "configured",
    configPath: defaultClientConfigPath(),
  };
  if (remoteUrl === undefined) {
    report.status = "unconfigured";
    return report;
  }
  try {
    report.health = await request(
      { remoteUrl, timeoutMs: 10_000 },
      "GET",
      "/healthz",
    );
  } catch (error) {
    report.status = "unreachable";
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  }
  if (token === undefined) {
    report.status = "unauthenticated";
    return report;
  }
  try {
    report.actor = await request(
      { remoteUrl, token, timeoutMs: 10_000 },
      "GET",
      "/api/session",
    );
    report.status = "ready";
  } catch (error) {
    report.status = "rejected";
    report.error =
      error instanceof ApiError
        ? { status: error.status, code: error.code, message: error.message }
        : String(error);
  }
  return report;
};

const main = async (): Promise<void> => {
  const args = parseCliArguments(process.argv.slice(2), valueOptionNames);
  const unknown = args.optionNames.filter(
    (name) => !valueOptionNames.has(name) && !booleanOptionNames.has(name),
  );
  if (unknown.length > 0)
    throw new CliInputError(`Unknown options: ${unknown.join(", ")}`, {
      hint: "Domain parameters belong in the JSON payload",
    });
  if (args.missingValueOptions.length > 0)
    throw new CliInputError(
      `Missing values for: ${args.missingValueOptions.join(", ")}`,
    );

  const [head, ...rest] = args.positionals;
  if (args.has("--version") || args.has("-v")) {
    writeJson(ok("version", { version: "0.0.1" }));
    return;
  }
  if (head === undefined || args.has("--help") || args.has("-h")) {
    process.stdout.write(usage);
    return;
  }

  switch (head) {
    case "read": {
      const view = requireParam(rest[0], "view");
      const params = (await readJsonArg(rest[1])) as Record<string, unknown>;
      writeJson(
        ok(`read ${view}`, await runRead(requireServer(args), view, params)),
      );
      return;
    }
    case "command": {
      const raw = (await readJsonArg(rest[0])) as Record<string, unknown>;
      const request_ = decode(CommandRequest, {
        requestId: crypto.randomUUID(),
        ...raw,
      });
      const result = await request(
        requireServer(args),
        "POST",
        "/api/commands",
        request_,
      );
      writeJson(ok("command", result));
      return;
    }
    case "discover": {
      const params = (await readJsonArg(rest[0])) as Record<string, unknown>;
      const query: Record<string, string | number> = {
        query: String(params.query ?? ""),
      };
      if (params.focusNodeId !== undefined)
        query.focusNodeId = String(params.focusNodeId);
      if (Array.isArray(params.includeNodeIds))
        query.includeNodeIds = params.includeNodeIds.join(",");
      writeJson(
        ok(
          "discover",
          await request(
            requireServer(args),
            "GET",
            "/api/discovery",
            undefined,
            query,
          ),
        ),
      );
      return;
    }
    case "evaluate": {
      const raw = (await readJsonArg(rest[0])) as Record<string, unknown>;
      const body = decode(EvaluationRequest, {
        requestId: crypto.randomUUID(),
        ...raw,
      });
      writeJson(
        ok(
          "evaluate",
          await request(requireServer(args), "POST", "/api/evaluations", body),
        ),
      );
      return;
    }
    case "doctor":
      writeJson(ok("doctor", await doctor(args)));
      return;
    case "capabilities":
      writeJson(ok("capabilities", capabilities));
      return;
    case "schema":
      writeJson(ok("schema", capabilities));
      return;
    default:
      throw new CliInputError(`Unknown command: ${head}`, {
        hint: "yakjev --help",
      });
  }
};

main().catch((error: unknown) => {
  writeJson(fail("yakjev", error), process.stderr);
  process.exit(1);
});

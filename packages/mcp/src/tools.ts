import {
  CommandRequest,
  CommandResult,
  EvaluationRequest,
  Preview,
  PreviewRequest,
  EvaluationResult,
  type Actor,
  type Edge,
} from "@yakjev/protocol";
import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { neighborhood, searchNodes } from "@yakjev/server/domain";
import {
  discover,
  DiscoveryError,
  DiscoveryRequest,
} from "@yakjev/server/discovery";
import { Evaluations } from "@yakjev/server/evaluation";
import { Store } from "@yakjev/server/store";
import { ToolFailure, invalid, mapFailure } from "./failure.ts";

const forbidden = ["actor", "user", "role", "channel"] as const;

export const rejectActorClaims = (input: unknown) =>
  Effect.gen(function* () {
    if (typeof input !== "object" || input === null) return;
    const record = input as Record<string, unknown>;
    for (const key of forbidden) {
      if (key in record) {
        return yield* Effect.fail(
          invalid(
            "Actor, user, role, and channel are server-derived. Do not send them.",
          ),
        );
      }
    }
  });

const IdParam = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
);
const ReadInput = Schema.Struct({
  view: Schema.Literals([
    "graph",
    "history",
    "search",
    "neighborhood",
    "export",
    "evaluation",
    "node",
    "edge",
  ]),
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  ),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  id: Schema.optionalKey(IdParam),
  source: Schema.optionalKey(IdParam),
  target: Schema.optionalKey(IdParam),
  direction: Schema.optionalKey(
    Schema.Literals(["outgoing", "incoming", "both"]),
  ),
  blocking: Schema.optionalKey(Schema.Boolean),
});

export const YakjevToolkit = Toolkit.make(
  Tool.make("graph_read", {
    description:
      "Read the authoritative Yakjev graph. view is graph (whole snapshot), history (journal entries after/limit), search (query), neighborhood (id, direction, blocking), export (graph + full journal), evaluation (id), node (id), or edge (id, or directed source+target). Do not send actor, user, role, or channel.",
    parameters: ReadInput,
    success: Schema.Unknown,
    failure: ToolFailure,
    failureMode: "return",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true),
  Tool.make("graph_command", {
    description:
      "Apply one graph command through the same envelope as POST /api/commands. Commands: capture (nodes+edges+capture atomically; Jev then connects each new node to related intentions in the background unless autoConnect:false), capture.remove, node.put (set status archived to retire a node without deleting it), node.remove (ids[]; incident edges refuse unless removeEdges:true cascades), edge.put (new pairs only), edge.reframe (correct an existing edge), edge.remove (id or directed source+target; suppress keeps the pair rejected for machine inference and defaults on for corrected or disputed edges), layout.set (positions or {id,clear:true}), taxonomy.replace, suggestion.record, suggestion.decide, evaluation.record, undo (reverts only the current revision; to remove earlier work use the remove commands). Exact requestId replay returns the original receipt; a changed payload for that requestId conflicts. expectedRevision must equal the current graph revision — read it first. Do not send actor, user, role, or channel.",
    parameters: CommandRequest,
    success: CommandResult,
    failure: ToolFailure,
    failureMode: "return",
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true),
  Tool.make("graph_discover", {
    description:
      "Bounded lexical and neighborhood candidate retrieval. Same function as discover(). Not semantic search. Does not write.",
    parameters: DiscoveryRequest,
    success: Schema.Unknown,
    failure: ToolFailure,
    failureMode: "return",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true),
  Tool.make("graph_evaluate", {
    description:
      "Run Evaluations.evaluate. Same operation as POST /api/evaluations. Replay is checked before the provider call. Do not send actor, user, role, or channel.",
    parameters: EvaluationRequest,
    success: EvaluationResult,
    failure: ToolFailure,
    failureMode: "return",
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Strict, true),
  Tool.make("graph_preview", {
    description:
      "Ask Jev how an intention relates to the graph before or after capturing it. Give draft {title, description?} for text not yet captured, or focusNodeId for an existing node; includeNodeIds forces candidates in. Returns per-candidate relatedness, match, same (a restatement), relation, direction, and connect (what Jev would connect). Writes nothing. Captures are auto-connected anyway; use this to avoid duplicating an existing intention.",
    parameters: PreviewRequest,
    success: Preview,
    failure: ToolFailure,
    failureMode: "return",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Strict, true),
);

const runDiscover = (
  graph: import("@yakjev/protocol").Graph,
  input: DiscoveryRequest,
) =>
  Effect.try({
    try: () => discover(graph, input),
    catch: (cause) =>
      cause instanceof DiscoveryError
        ? new ToolFailure({ error: "Invalid", message: cause.message })
        : invalid("Invalid discovery request"),
  });

export const toolkitLayer = (actor: () => Effect.Effect<Actor, ToolFailure>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* Store;
      const evaluations = yield* Evaluations;
      return YakjevToolkit.toLayer({
        graph_read: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            const who = yield* actor();
            if (who.channel !== "mcp") {
              return yield* Effect.fail(
                invalid("MCP tools require an mcp actor."),
              );
            }
            const graph = yield* store.read.pipe(Effect.mapError(mapFailure));
            switch (input.view) {
              case "graph":
                return graph;
              case "history":
                return yield* store
                  .history(input.after ?? 0, input.limit ?? 100)
                  .pipe(Effect.mapError(mapFailure));
              case "search":
                return searchNodes(graph, input.query ?? "");
              case "neighborhood":
                if (input.id === undefined)
                  return yield* Effect.fail(
                    invalid("neighborhood requires id."),
                  );
                return yield* neighborhood(
                  graph,
                  input.id,
                  input.direction ?? "outgoing",
                  input.blocking ?? false,
                ).pipe(Effect.mapError(mapFailure));
              case "export":
                return yield* store.exportGraph.pipe(
                  Effect.mapError(mapFailure),
                );
              case "evaluation": {
                if (input.id === undefined)
                  return yield* Effect.fail(invalid("evaluation requires id."));
                return yield* store
                  .evaluation(input.id)
                  .pipe(Effect.mapError(mapFailure));
              }
              case "node": {
                if (input.id === undefined)
                  return yield* Effect.fail(invalid("node requires id."));
                const node = graph.nodes.find((item) => item.id === input.id);
                if (!node)
                  return yield* Effect.fail(
                    new ToolFailure({
                      error: "NotFound",
                      message: "Unknown node",
                    }),
                  );
                return node;
              }
              case "edge": {
                let edge: Edge | undefined;
                if (input.id !== undefined) {
                  edge = graph.edges.find((item) => item.id === input.id);
                  if (
                    edge &&
                    ((input.source !== undefined &&
                      edge.source !== input.source) ||
                      (input.target !== undefined &&
                        edge.target !== input.target))
                  )
                    return yield* Effect.fail(
                      invalid("id disagrees with the given source or target."),
                    );
                } else if (
                  input.source !== undefined &&
                  input.target !== undefined
                ) {
                  edge = graph.edges.find(
                    (item) =>
                      item.source === input.source &&
                      item.target === input.target,
                  );
                } else {
                  return yield* Effect.fail(
                    invalid(
                      "edge requires id or a directed source and target.",
                    ),
                  );
                }
                if (!edge)
                  return yield* Effect.fail(
                    new ToolFailure({
                      error: "NotFound",
                      message: "Unknown edge",
                    }),
                  );
                return edge;
              }
            }
          }),
        graph_command: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            yield* rejectActorClaims(input.command);
            const who = yield* actor();
            if (who.channel !== "mcp") {
              return yield* Effect.fail(
                invalid("MCP tools require an mcp actor."),
              );
            }
            return yield* evaluations
              .command(who, input)
              .pipe(Effect.mapError(mapFailure));
          }),
        graph_discover: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            const who = yield* actor();
            if (who.channel !== "mcp") {
              return yield* Effect.fail(
                invalid("MCP tools require an mcp actor."),
              );
            }
            return yield* runDiscover(
              yield* store.read.pipe(Effect.mapError(mapFailure)),
              input,
            );
          }),
        graph_preview: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            const who = yield* actor();
            if (who.channel !== "mcp") {
              return yield* Effect.fail(
                invalid("MCP tools require an mcp actor."),
              );
            }
            return yield* evaluations
              .preview(input)
              .pipe(Effect.mapError(mapFailure));
          }),
        graph_evaluate: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            const who = yield* actor();
            if (who.channel !== "mcp") {
              return yield* Effect.fail(
                invalid("MCP tools require an mcp actor."),
              );
            }
            return yield* evaluations
              .evaluate(who, input)
              .pipe(Effect.mapError(mapFailure));
          }),
      });
    }),
  );

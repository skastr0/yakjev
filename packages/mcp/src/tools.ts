import { CommandRequest, CommandResult } from "@yakjev/protocol";
import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { Actor } from "@yakjev/protocol";
import { neighborhood, searchNodes } from "@yakjev/server/domain";
import {
  discover,
  DiscoveryError,
  DiscoveryRequest,
} from "@yakjev/server/discovery";
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

const ReadInput = Schema.Struct({
  view: Schema.Literals([
    "graph",
    "history",
    "search",
    "neighborhood",
    "export",
    "evaluation",
  ]),
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  id: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
    ),
  ),
  direction: Schema.optionalKey(
    Schema.Literals(["outgoing", "incoming", "both"]),
  ),
  blocking: Schema.optionalKey(Schema.Boolean),
});

export const YakjevToolkit = Toolkit.make(
  Tool.make("graph_read", {
    description:
      "Read the authoritative Yakjev graph. view is graph, history, search, neighborhood, export, or evaluation. Do not send actor, user, role, or channel.",
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
      "Apply one graph command through the same envelope as POST /api/commands. Exact requestId replay returns the original receipt. A changed payload for that requestId conflicts. Do not send actor, user, role, or channel.",
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
      return YakjevToolkit.toLayer({
        graph_read: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            yield* actor();
            const graph = yield* store.read.pipe(Effect.mapError(mapFailure));
            switch (input.view) {
              case "graph":
                return graph;
              case "history":
                return yield* store
                  .history(input.after ?? 0, 100)
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
                  input.direction ?? "both",
                  input.blocking ?? false,
                ).pipe(Effect.mapError(mapFailure));
              case "export":
                return yield* store.exportGraph.pipe(
                  Effect.mapError(mapFailure),
                );
              case "evaluation": {
                if (input.id === undefined)
                  return yield* Effect.fail(invalid("evaluation requires id."));
                const found = graph.evaluations.find(
                  (item) => item.id === input.id,
                );
                if (!found)
                  return yield* Effect.fail(
                    new ToolFailure({
                      error: "NotFound",
                      message: "Unknown evaluation",
                    }),
                  );
                return found;
              }
            }
          }),
        graph_command: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            yield* rejectActorClaims(input.command);
            return yield* store
              .execute(yield* actor(), input)
              .pipe(Effect.mapError(mapFailure));
          }),
        graph_discover: (input) =>
          Effect.gen(function* () {
            yield* rejectActorClaims(input);
            yield* actor();
            return yield* runDiscover(
              yield* store.read.pipe(Effect.mapError(mapFailure)),
              input,
            );
          }),
      });
    }),
  );

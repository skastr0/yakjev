import { Context, Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { Auth } from "@yakjev/server/auth";
import { invalid } from "./failure.ts";
import { YakjevToolkit, toolkitLayer } from "./tools.ts";

const ActorRef = Context.Reference<
  import("@yakjev/protocol").Actor | undefined
>("@yakjev/mcp/Actor", {
  defaultValue: () => undefined,
});

const actorForRequest = () =>
  Effect.gen(function* () {
    const actor = yield* ActorRef;
    if (!actor || actor.channel !== "mcp") {
      return yield* Effect.fail(
        invalid("MCP tools require an authenticated mcp actor."),
      );
    }
    return actor;
  });

/**
 * Streamable HTTP POST /mcp on the shared router.
 * Requires HttpRouter, Auth, Store, and Evaluations. Does not open SQLite.
 */
export const mcpLayer = (options: { readonly origin: string }) =>
  McpServer.toolkit(YakjevToolkit).pipe(
    Layer.provide(toolkitLayer(actorForRequest)),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "yakjev",
        version: "0.0.1",
        instructions:
          "Yakjev graph. Tools: graph_read, graph_command, graph_discover, graph_evaluate. graph_command carries every mutation, including node.remove, edge.remove, and capture.remove for deleting current-state entities. Actor is the authenticated owner on the mcp channel. Do not send actor, user, role, or channel.",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
        allowedOrigins: [options.origin],
      }),
    ),
  );

export const provideActor = (actor: import("@yakjev/protocol").Actor) =>
  Context.make(ActorRef, actor);

export const requireBearer = (
  headers: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    return yield* auth.bearer(headers);
  });

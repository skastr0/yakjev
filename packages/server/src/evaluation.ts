import {
  type Actor,
  CommandRequest,
  EvaluationRequest,
  EvaluationResult,
  type Preview,
  PreviewRequest,
} from "@yakjev/protocol";
import { createHash } from "node:crypto";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { Discovery, DiscoveryError, PROMPT_VERSION } from "./discovery";
import { DomainError } from "./domain";
import { Store } from "./store";

// Jev acts as its own actor when it connects new nodes in the background.
export const JEV_ACTOR: Actor = { id: "jev", channel: "system" };

// Both HTTP and MCP use this operation, including its durable retry behavior.
export class Evaluations extends Context.Service<Evaluations>()(
  "@yakjev/Evaluations",
  {
    make: Effect.gen(function* () {
      const store = yield* Store;
      const discovery = yield* Discovery;
      const permit = yield* Semaphore.make(1);
      const scope = yield* Effect.scope;
      const evaluate = Effect.fn("Evaluations.evaluate")(function* (
        actor: Actor,
        input: unknown,
      ) {
        const request = yield* Schema.decodeUnknownEffect(EvaluationRequest)(
          input,
          { onExcessProperty: "error" },
        ).pipe(
          Effect.mapError(
            () =>
              new DomainError({
                code: "Invalid",
                message: "Invalid evaluation request",
              }),
          ),
        );
        return yield* permit.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* store.findRequest(actor, request.requestId);
            if (previous) {
              if (previous.command.type !== "evaluation.record")
                return yield* new DomainError({
                  code: "Conflict",
                  message: "requestId already used for another operation",
                });
              const recorded = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ request: EvaluationRequest }),
              )(previous.command.evaluation.result).pipe(
                Effect.mapError(
                  () =>
                    new DomainError({
                      code: "Conflict",
                      message: "requestId already used for another operation",
                    }),
                ),
              );
              if (JSON.stringify(recorded.request) !== JSON.stringify(request))
                return yield* new DomainError({
                  code: "Conflict",
                  message: "requestId was used with a different payload",
                });
              const { command: _, ...receipt } = previous;
              return {
                receipt,
                replayed: true,
                evaluationId: previous.command.evaluation.id,
              } satisfies typeof EvaluationResult.Type;
            }
            const graph = yield* store.read;
            if (request.expectedRevision !== graph.revision)
              return yield* new DomainError({
                code: "Conflict",
                message: "Graph revision changed; refresh before evaluating",
                currentRevision: graph.revision,
              });
            const evaluated = yield* discovery.evaluate(graph, request);
            const result = yield* Schema.decodeUnknownEffect(Schema.Json)({
              ...evaluated,
              request,
            }).pipe(
              Effect.mapError(
                () =>
                  new DomainError({
                    code: "Invalid",
                    message: "Invalid evaluation result",
                  }),
              ),
            );
            // A concurrent graph edit makes this commit fail; it must never silently apply stale inference.
            const committed = yield* store.execute(actor, {
              requestId: request.requestId,
              expectedRevision: request.expectedRevision,
              command: {
                type: "evaluation.record",
                evaluation: {
                  id: evaluated.id,
                  inputHash: evaluated.inputHash,
                  basedOnRevision: evaluated.basedOnRevision,
                  taxonomyVersion: evaluated.taxonomyVersion,
                  result,
                },
                suggestions: request.connect
                  ? evaluated.connections
                  : evaluated.suggestions,
                ...(request.connect ? { connect: true } : {}),
              },
            });
            return {
              ...committed,
              evaluationId: evaluated.id,
            } satisfies typeof EvaluationResult.Type;
          }),
        );
      });

      // Ephemeral: judged against the live graph, never journaled.
      const preview = Effect.fn("Evaluations.preview")(function* (
        input: unknown,
      ) {
        const request = yield* Schema.decodeUnknownEffect(PreviewRequest)(
          input,
          { onExcessProperty: "error" },
        ).pipe(
          Effect.mapError(
            () =>
              new DomainError({
                code: "Invalid",
                message: "Invalid preview request",
              }),
          ),
        );
        const graph = yield* store.read;
        const empty: Preview = {
          basedOnRevision: graph.revision,
          taxonomyVersion: graph.taxonomy.version,
          status: "succeeded",
          model: null,
          promptVersion: PROMPT_VERSION,
          elapsedMs: 0,
          judgments: [],
        };
        if (!request.focusNodeId && !request.draft?.title.trim()) return empty;
        const evaluated = yield* discovery
          .evaluate(graph, {
            query: "",
            ...(request.draft ? { draft: request.draft } : {}),
            ...(request.focusNodeId
              ? { focusNodeId: request.focusNodeId }
              : {}),
            ...(request.includeNodeIds
              ? { includeNodeIds: request.includeNodeIds }
              : {}),
          })
          .pipe(
            Effect.mapError(
              (error: DiscoveryError) =>
                new DomainError({ code: "Invalid", message: error.message }),
            ),
          );
        return {
          ...empty,
          status: evaluated.status,
          model: evaluated.resolvedModel,
          elapsedMs: evaluated.elapsedMs,
          judgments: evaluated.judgments,
        } satisfies Preview;
      });

      // Connect one node: judge it against the graph and commit Jev's chosen
      // edges with the evaluation audit in one revision. Failures and empty
      // results leave no trace; a concurrent edit retries against the new graph.
      const connectNode = (nodeId: string, requestId: string) =>
        permit
          .withPermits(1)(
            Effect.gen(function* () {
              const graph = yield* store.read;
              const node = graph.nodes.find((item) => item.id === nodeId);
              if (!node || node.status === "archived") return 0;
              const request = {
                requestId,
                expectedRevision: graph.revision,
                query: node.title,
                focusNodeId: nodeId,
                connect: true,
              };
              const evaluated = yield* discovery.evaluate(graph, request);
              if (
                evaluated.status !== "succeeded" ||
                evaluated.connections.length === 0
              )
                return 0;
              const result = yield* Schema.decodeUnknownEffect(Schema.Json)({
                ...evaluated,
                request,
              });
              yield* store.execute(JEV_ACTOR, {
                requestId,
                expectedRevision: graph.revision,
                command: {
                  type: "evaluation.record",
                  evaluation: {
                    id: evaluated.id,
                    inputHash: evaluated.inputHash,
                    basedOnRevision: evaluated.basedOnRevision,
                    taxonomyVersion: evaluated.taxonomyVersion,
                    result,
                  },
                  suggestions: evaluated.connections,
                  connect: true,
                },
              });
              return evaluated.connections.length;
            }),
          )
          .pipe(
            Effect.retry({
              times: 3,
              while: (error) =>
                error instanceof DomainError && error.code === "Conflict",
            }),
            Effect.catch((error) =>
              Effect.logWarning("Jev auto-connect skipped", nodeId, error).pipe(
                Effect.as(0),
              ),
            ),
          );

      // Every write path goes through here so captures from the browser, MCP,
      // and the CLI all get connected. The HTTP response does not wait for Jev.
      const command = Effect.fn("Evaluations.command")(function* (
        actor: Actor,
        input: unknown,
      ) {
        const request = Schema.decodeUnknownOption(CommandRequest)(input);
        const put =
          request._tag === "Some" && request.value.command.type === "node.put"
            ? request.value.command.node
            : null;
        const before = put
          ? (yield* store.read).nodes.find((node) => node.id === put.id)
          : undefined;
        const result = yield* store.execute(actor, input);
        if (result.replayed || request._tag === "None") return result;
        const command = request.value.command;
        // New captures, and intentions whose words changed, get connected.
        const nodes =
          command.type === "capture" && command.autoConnect !== false
            ? command.nodes.map((node) => node.id)
            : put &&
                put.status !== "archived" &&
                (!before ||
                  before.title !== put.title ||
                  before.description !== put.description)
              ? [put.id]
              : [];
        if (nodes.length > 0) {
          yield* Effect.forEach(
            nodes,
            (id) =>
              connectNode(
                id,
                `connect-${createHash("sha256").update(`${result.receipt.revision}:${id}`).digest("hex").slice(0, 32)}`,
              ),
            { discard: true },
          ).pipe(Effect.forkIn(scope));
        }
        return result;
      });
      return { evaluate, preview, command, connectNode };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

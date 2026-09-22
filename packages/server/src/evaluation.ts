import {
  type Actor,
  EvaluationRequest,
  EvaluationResult,
} from "@yakjev/protocol";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { Discovery } from "./discovery";
import { DomainError } from "./domain";
import { Store } from "./store";

// Both HTTP and MCP use this operation, including its durable retry behavior.
export class Evaluations extends Context.Service<Evaluations>()(
  "@yakjev/Evaluations",
  {
    make: Effect.gen(function* () {
      const store = yield* Store;
      const discovery = yield* Discovery;
      const permit = yield* Semaphore.make(1);
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
                suggestions: evaluated.suggestions,
              },
            });
            return {
              ...committed,
              evaluationId: evaluated.id,
            } satisfies typeof EvaluationResult.Type;
          }),
        );
      });
      return { evaluate };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

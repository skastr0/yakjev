import {
  type Actor,
  CommandRequest,
  EvaluationRequest,
  EvaluationResult,
  type JevCall,
  type JevCalls,
  type Preview,
  PreviewRequest,
} from "@yakjev/protocol";
import { createHash } from "node:crypto";
import {
  Config,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";
import {
  Discovery,
  DiscoveryError,
  PROMPT_VERSION,
  type CoarseCall,
  type Evaluation,
} from "./discovery";
import { DomainError } from "./domain";
import { Store } from "./store";

// Jev acts as its own actor when it connects new nodes in the background.
export const JEV_ACTOR: Actor = { id: "jev", channel: "system" };
export const JEV_CALL_LOG_LIMIT = 300;

// Both HTTP and MCP use this operation, including its durable retry behavior.
export class Evaluations extends Context.Service<Evaluations>()(
  "@yakjev/Evaluations",
  {
    make: Effect.gen(function* () {
      const store = yield* Store;
      const discovery = yield* Discovery;
      const permit = yield* Semaphore.make(1);
      const scope = yield* Effect.scope;
      // In-memory Jev call log for the dev panel: resets when the server
      // restarts. Cost uses the configured rates (jev-1.13: $0.042 per
      // million input tokens, output free).
      const inputRate = yield* Config.option(
        Config.Number("YAKJEV_JEV_USD_PER_MTOK_INPUT"),
      );
      const outputRate = yield* Config.option(
        Config.Number("YAKJEV_JEV_USD_PER_MTOK_OUTPUT"),
      );
      const pricing =
        Option.isSome(inputRate) && Option.isSome(outputRate)
          ? {
              inputUsdPerMTok: inputRate.value,
              outputUsdPerMTok: outputRate.value,
            }
          : null;
      const since = DateTime.formatIso(yield* DateTime.now);
      const log: JevCall[] = [];
      const totals = {
        calls: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: 0,
        costUsd: pricing ? 0 : null,
      };
      const record = (entry: Omit<JevCall, "at" | "costUsd">) =>
        Effect.gen(function* () {
          const costUsd = pricing
            ? ((entry.inputTokens ?? 0) * pricing.inputUsdPerMTok +
                (entry.outputTokens ?? 0) * pricing.outputUsdPerMTok) /
              1_000_000
            : null;
          log.unshift({
            ...entry,
            at: DateTime.formatIso(yield* DateTime.now),
            costUsd,
          });
          log.length = Math.min(log.length, JEV_CALL_LOG_LIMIT);
          totals.calls += 1;
          if (entry.status === "failed") totals.failed += 1;
          totals.inputTokens += entry.inputTokens ?? 0;
          totals.outputTokens += entry.outputTokens ?? 0;
          totals.elapsedMs += entry.elapsedMs;
          if (totals.costUsd !== null && costUsd !== null)
            totals.costUsd += costUsd;
        });
      const trackCoarse = (calls: readonly CoarseCall[]) =>
        Effect.forEach(
          calls,
          (call) => record({ purpose: "rerank", ...call }),
          {
            discard: true,
          },
        );
      const track = (purpose: JevCall["purpose"], evaluated: Evaluation) =>
        Effect.gen(function* () {
          yield* trackCoarse(evaluated.coarse);
          // Only calls that reached the provider: no key and empty candidate
          // sets never leave the server.
          const called =
            evaluated.status === "failed" || evaluated.rawResponse !== null;
          if (!called) return;
          yield* record({
            purpose,
            status: evaluated.status === "failed" ? "failed" : "succeeded",
            candidates: evaluated.coverage.considered,
            elapsedMs: evaluated.elapsedMs,
            inputTokens: evaluated.usage.inputTokens,
            outputTokens: evaluated.usage.outputTokens,
            model: evaluated.resolvedModel,
            failure: evaluated.failure?.code ?? null,
          });
        });
      const calls = Effect.sync(
        (): JevCalls => ({
          since,
          pricing,
          totals: { ...totals },
          calls: [...log],
        }),
      );
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
            yield* track("evaluate", evaluated);
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
            ...(request.only ? { only: true } : {}),
          })
          .pipe(
            Effect.mapError(
              (error: DiscoveryError) =>
                new DomainError({ code: "Invalid", message: error.message }),
            ),
          );
        yield* track(request.purpose ?? "preview", evaluated);
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
              yield* track("auto-connect", evaluated);
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
      // The exact candidates a Jev call would judge right now.
      const shortlist = Effect.fn("Evaluations.shortlist")(function* (
        input: unknown,
      ) {
        const graph = yield* store.read;
        const listed = yield* discovery
          .shortlist(graph, input)
          .pipe(
            Effect.mapError(
              (error: DiscoveryError) =>
                new DomainError({ code: "Invalid", message: error.message }),
            ),
          );
        yield* trackCoarse(listed.coarse);
        return listed;
      });
      return { evaluate, preview, command, connectNode, calls, shortlist };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

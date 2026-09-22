import { BunServices } from "@effect/platform-bun";
import { Health, Id, Revision } from "@yakjev/protocol";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { mcpLayer, provideActor } from "../../mcp/src/index";
import { Auth, type AuthOptions } from "./auth";
import {
  discover,
  Discovery,
  DiscoveryError,
  DiscoveryLive,
} from "./discovery";
import { DomainError, neighborhood, searchNodes } from "./domain";
import { Evaluations } from "./evaluation";
import { Store, storeLayer } from "./store";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status });
const statusFor = {
  Invalid: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
};
const invalid = () =>
  new DomainError({ code: "Invalid", message: "Invalid request" });
const numberParam = (value: string | null, fallback: number) =>
  value === null
    ? Effect.succeed(fallback)
    : Schema.decodeUnknownEffect(Revision)(
        /^\d+$/.test(value) ? Number(value) : NaN,
      ).pipe(Effect.mapError(invalid));
const bodyJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return yield* invalid();
  const text = yield* request.text;
  if (text.length > 1024 * 1024) return yield* invalid();
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    text,
  );
});

export interface AppOptions extends AuthOptions {
  readonly databasePath: string;
  readonly webRoot: string;
  readonly listenPort?: number;
}

export function createApp(
  options: AppOptions,
  discoveryLayer: Layer.Layer<Discovery, unknown> = DiscoveryLive,
) {
  const origin = new URL(options.origin);
  const routes = HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const store = yield* Store;
      const auth = yield* Auth;
      const evaluations = yield* Evaluations;
      const handle = Effect.fn("Http.handle")(
        function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = yield* Effect.try(
            () => new URL(request.url, origin),
          ).pipe(Effect.mapError(invalid));
          if (url.pathname === "/healthz") {
            if (request.method !== "GET" && request.method !== "HEAD")
              return json(
                { error: "Invalid", message: "Method not allowed" },
                405,
              );
            yield* store.check;
            return json({
              service: "yakjev",
              status: "ok",
              stage: "graph",
              storage: "sqlite",
            } satisfies Health);
          }
          if (url.pathname === "/api/session" && request.method === "POST") {
            const body = yield* bodyJson.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    token: Schema.String.check(Schema.isMaxLength(4096)),
                  }),
                ),
              ),
            );
            const cookie = yield* auth.login(request.headers, body.token);
            return HttpServerResponse.setHeader(
              json({ authenticated: true }),
              "set-cookie",
              cookie,
            );
          }
          if (url.pathname === "/api/session" && request.method === "DELETE") {
            const cookie = yield* auth.logout(request.headers);
            return HttpServerResponse.setHeader(
              json({ authenticated: false }),
              "set-cookie",
              cookie,
            );
          }
          const actor = yield* auth.browser(
            request.headers,
            request.method !== "GET" && request.method !== "HEAD",
          );
          if (url.pathname === "/api/session" && request.method === "GET")
            return json({ actor });
          if (url.pathname === "/api/commands" && request.method === "POST")
            return json(yield* store.execute(actor, yield* bodyJson));
          if (url.pathname === "/api/evaluations" && request.method === "POST")
            return json(yield* evaluations.evaluate(actor, yield* bodyJson));
          if (request.method !== "GET")
            return json(
              { error: "Invalid", message: "Method not allowed" },
              405,
            );
          if (url.pathname === "/api/graph") return json(yield* store.read);
          if (url.pathname === "/api/export")
            return json(yield* store.exportGraph);
          if (url.pathname === "/api/discovery") {
            const graph = yield* store.read;
            const request = {
              query: url.searchParams.get("query") ?? "",
              ...(url.searchParams.has("focusNodeId")
                ? { focusNodeId: url.searchParams.get("focusNodeId")! }
                : {}),
              ...(url.searchParams.has("includeNodeIds")
                ? {
                    includeNodeIds: url.searchParams
                      .get("includeNodeIds")!
                      .split(","),
                  }
                : {}),
            };
            return json(
              yield* Effect.try({
                try: () => discover(graph, request),
                catch: () =>
                  new DiscoveryError({ message: "Invalid discovery request" }),
              }),
            );
          }
          if (url.pathname.startsWith("/api/evaluations/")) {
            const segment = yield* Effect.try(() =>
              decodeURIComponent(
                url.pathname.slice("/api/evaluations/".length),
              ),
            ).pipe(Effect.mapError(invalid));
            const id = yield* Schema.decodeUnknownEffect(Id)(segment);
            return json(yield* store.evaluation(id));
          }
          if (url.pathname === "/api/search")
            return json(
              searchNodes(yield* store.read, url.searchParams.get("q") ?? ""),
            );
          if (url.pathname === "/api/history") {
            const after = yield* numberParam(url.searchParams.get("after"), 0);
            const limit = yield* numberParam(
              url.searchParams.get("limit"),
              100,
            );
            return json(yield* store.history(after, limit));
          }
          if (url.pathname === "/api/neighborhood") {
            const id = yield* Schema.decodeUnknownEffect(Id)(
              url.searchParams.get("id"),
            );
            const direction = yield* Schema.decodeUnknownEffect(
              Schema.Literals(["outgoing", "incoming", "both"]),
            )(url.searchParams.get("direction") ?? "outgoing");
            const blocking = yield* Schema.decodeUnknownEffect(
              Schema.Literals(["true", "false"]),
            )(url.searchParams.get("blocking") ?? "false");
            return json(
              yield* neighborhood(
                yield* store.read,
                id,
                direction,
                blocking === "true",
              ),
            );
          }
          if (url.pathname === "/api/events") {
            const after = yield* numberParam(
              request.headers["last-event-id"] ?? url.searchParams.get("after"),
              0,
            );
            const graph = yield* store.read;
            if (after > graph.revision)
              return yield* new DomainError({
                code: "Conflict",
                message: "Event cursor is ahead of this graph; reload snapshot",
                currentRevision: graph.revision,
              });
            const events = Stream.unfold(
              after,
              Effect.fnUntraced(function* (cursor) {
                // Recheck expiry while streaming. Durable bounded polling has no subscribe/read gap.
                yield* auth.browser(request.headers, false);
                const entries = yield* store.events(cursor);
                if (entries.length === 0) {
                  yield* Effect.sleep("1 second");
                  return [": keepalive\n\n", cursor] as const;
                }
                const messages = entries
                  .map(
                    (receipt) =>
                      `id: ${receipt.revision}\nevent: change\ndata: ${JSON.stringify(receipt)}\n\n`,
                  )
                  .join("");
                return [
                  messages,
                  entries[entries.length - 1]!.revision,
                ] as const;
              }),
            );
            return HttpServerResponse.stream(
              Stream.concat(Stream.make(": connected\n\n"), events).pipe(
                Stream.encodeText,
              ),
              {
                contentType: "text/event-stream",
                headers: {
                  "cache-control": "no-cache, no-transform",
                  "x-accel-buffering": "no",
                },
              },
            );
          }
          return json({ error: "NotFound", message: "Not found" }, 404);
        },
        Effect.catchTags({
          DomainError: (error) =>
            Effect.succeed(
              json(
                {
                  error: error.code,
                  message: error.message,
                  ...(error.currentRevision === undefined
                    ? {}
                    : { currentRevision: error.currentRevision }),
                },
                statusFor[error.code],
              ),
            ),
          AuthError: (error) =>
            Effect.succeed(
              json(
                { error: error.code, message: error.message },
                statusFor[error.code],
              ),
            ),
          StorageError: () =>
            Effect.succeed(
              json(
                { error: "StorageError", message: "Storage unavailable" },
                503,
              ),
            ),
          DiscoveryError: () =>
            Effect.succeed(
              json(
                { error: "Invalid", message: "Invalid discovery request" },
                400,
              ),
            ),
          SchemaError: () =>
            Effect.succeed(
              json({ error: "Invalid", message: "Invalid request" }, 400),
            ),
          HttpServerError: () =>
            Effect.succeed(
              json({ error: "Invalid", message: "Invalid request" }, 400),
            ),
        }),
      );
      yield* router.add("*", "/api/*", handle());
      yield* router.add("*", "/healthz", handle());
    }),
  );
  const mcp = Layer.unwrap(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const authenticate = HttpRouter.middleware((httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorized = yield* auth
            .bearer(request.headers)
            .pipe(Effect.result);
          if (authorized._tag === "Failure")
            return json(
              {
                error: authorized.failure.code,
                message: authorized.failure.message,
              },
              statusFor[authorized.failure.code],
            );
          return yield* httpEffect.pipe(
            Effect.provide(provideActor(authorized.success)),
          );
        }),
      ).layer;
      return mcpLayer({ origin: origin.origin }).pipe(
        Layer.provide(authenticate),
      );
    }),
  );
  const app = HttpRouter.toWebHandler(
    Layer.mergeAll(routes, mcp).pipe(
      Layer.provide(
        Layer.mergeAll(
          Auth.layer(options),
          Evaluations.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(storeLayer(options.databasePath), discoveryLayer),
            ),
          ),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(BunServices.layer),
    ),
    { disableLogger: true },
  );
  const error = (message: string, status: number) =>
    Response.json(
      { error: status === 400 ? "Invalid" : "Forbidden", message },
      { status, headers },
    );
  const fetch = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? url.host;
      const port = options.listenPort ?? 3210;
      const loopbackProbe =
        url.pathname === "/healthz" &&
        (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
      if (host !== origin.host && !loopbackProbe)
        return error("Forbidden host", 403);
      if (
        request.headers.has("origin") &&
        request.headers.get("origin") !== origin.origin
      )
        return error("Forbidden origin", 403);
      if (
        url.pathname === "/healthz" ||
        url.pathname === "/mcp" ||
        url.pathname.startsWith("/api/")
      ) {
        const response = await app.handler(request);
        const secured = new Headers(response.headers);
        for (const [key, value] of Object.entries(headers))
          if (!secured.has(key)) secured.set(key, value);
        return new Response(response.body, {
          status: response.status,
          headers: secured,
        });
      }
      // Only built UI assets are public. Every data read and stream requires auth.
      const relative =
        url.pathname === "/"
          ? "index.html"
          : /^\/assets\/[a-zA-Z0-9_-]+\.(js|css|svg|woff2)$/.test(url.pathname)
            ? url.pathname.slice(1)
            : undefined;
      if (relative && (request.method === "GET" || request.method === "HEAD")) {
        const file = Bun.file(`${options.webRoot}/${relative}`);
        if (await file.exists())
          return new Response(request.method === "HEAD" ? null : file, {
            headers,
          });
      }
      return new Response("Not found", { status: 404, headers });
    } catch {
      // Never let Bun's fallback page expose stack traces or source snippets.
      return error("Invalid request", 400);
    }
  };
  return {
    fetch,
    close: app.dispose,
    ready: async () => {
      const response = await fetch(new Request(`${origin.origin}/healthz`));
      if (response.status !== 200)
        throw new Error("Yakjev initialization failed");
      return Schema.decodeUnknownSync(Health)(await response.json());
    },
  };
}

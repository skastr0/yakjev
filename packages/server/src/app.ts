import { Health } from "@yakjev/protocol";
import { Effect, ManagedRuntime, Schema } from "effect";
import { Store, storeLayer } from "./store";

const health = Effect.gen(function* () {
  const store = yield* Store;
  yield* store.check;
  return Schema.decodeUnknownSync(Health)({
    service: "yakjev",
    status: "ok",
    stage: "scaffold",
    storage: "sqlite",
  });
});

export function createApp(options: {
  databasePath: string;
  origin: string;
  webRoot: string;
}) {
  const runtime = ManagedRuntime.make(storeLayer(options.databasePath));
  const origin = new URL(options.origin);
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };

  return {
    ready: () => runtime.runPromise(health),
    close: () => runtime.dispose(),
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      // Reject DNS rebinding. Loopback health probes carry no application data.
      const host = request.headers.get("host") ?? url.host;
      const loopbackProbe =
        url.pathname === "/healthz" &&
        (host === "127.0.0.1:3210" || host === "localhost:3210");
      if (host !== origin.host && !loopbackProbe) {
        return new Response("Forbidden host", { status: 403, headers });
      }
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin && requestOrigin !== origin.origin) {
        return new Response("Forbidden origin", { status: 403, headers });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { ...headers, Allow: "GET, HEAD" },
        });
      }
      if (url.pathname === "/healthz") {
        return runtime.runPromise(
          health.pipe(
            Effect.map((body) => Response.json(body, { headers })),
            Effect.catchTag("StorageError", () =>
              Effect.succeed(
                Response.json(
                  { status: "unavailable" },
                  { status: 503, headers },
                ),
              ),
            ),
          ),
        );
      }
      // Serve only the built entrypoint and flat Vite assets; never repo files or data.
      const relative =
        url.pathname === "/"
          ? "index.html"
          : /^\/assets\/[a-zA-Z0-9_-]+\.(js|css|svg|woff2)$/.test(url.pathname)
            ? url.pathname.slice(1)
            : undefined;
      if (relative) {
        const file = Bun.file(`${options.webRoot}/${relative}`);
        if (await file.exists()) return new Response(file, { headers });
      }
      return new Response("Not found", { status: 404, headers });
    },
  };
}

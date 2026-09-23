import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { Session } from "electron";
import { assetName, DesktopError, isApiPath, rendererPolicy } from "./config";

export interface RendererTransport {
  readonly session: Session;
  readonly origin: string;
  readonly root: string;
  readonly developmentUrl: string | undefined;
  readonly shutdown: AbortSignal;
}

const failure = (message: string, status: number) =>
  Response.json({ message }, { status });

/** Stream bytes through Chromium's session. No graph copies, JSON IPC, local
 * API listener, retries of mutations, or second authentication implementation. */
export const serveRenderer = Effect.fn("desktop.serveRenderer")(function* (
  request: Request & { readonly initiatorOrigin?: string },
  transport: RendererTransport,
) {
  const url = new URL(request.url);
  if (
    url.origin !== transport.origin ||
    (request.initiatorOrigin !== undefined &&
      request.initiatorOrigin !== transport.origin)
  )
    return failure("Forbidden origin", 403);

  if (isApiPath(url.pathname)) {
    const suppliedOrigin = request.headers.get("origin");
    if (suppliedOrigin && suppliedOrigin !== transport.origin)
      return failure("Forbidden origin", 403);
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const headers = new Headers(request.headers);
        // The native request is same-origin. Supply the server's required CSRF
        // origin explicitly because this leg is initiated in Electron main.
        headers.set("Origin", transport.origin);
        const response = await transport.session.fetch(
          new Request(request, {
            headers,
            signal: AbortSignal.any([
              request.signal,
              signal,
              transport.shutdown,
            ]),
            redirect: "manual",
          }),
          { bypassCustomProtocolHandlers: true },
        );
        // An API redirect must never turn the local renderer into remote code
        // or move an authenticated request to another host.
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return failure(
            "The server redirected an API request. Check the server URL.",
            502,
          );
        }
        return response;
      },
      catch: () =>
        new DesktopError({
          message: "The Yakjev server could not be reached.",
        }),
    }).pipe(
      Effect.catchTag("DesktopError", (error) =>
        Effect.succeed(failure(error.message, 502)),
      ),
    );
  }

  if (request.method !== "GET" && request.method !== "HEAD")
    return failure("Method not allowed", 405);

  const name = assetName(url.pathname);
  if (!transport.developmentUrl && !name) return failure("Not found", 404);

  return yield* Effect.tryPromise({
    try: async (signal) => {
      // Dev assets may include Vite's /@fs module paths; Vite enforces its own
      // filesystem allowlist. This branch is disabled in packaged applications.
      const target = transport.developmentUrl
        ? new URL(url.pathname + url.search, transport.developmentUrl).href
        : pathToFileURL(join(transport.root, name!)).href;
      const response = await transport.session.fetch(target, {
        bypassCustomProtocolHandlers: true,
        signal: AbortSignal.any([request.signal, signal, transport.shutdown]),
        redirect: "error",
        credentials: "omit",
      });
      const headers = new Headers(response.headers);
      headers.set(
        "Content-Security-Policy",
        rendererPolicy(!!transport.developmentUrl),
      );
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set(
        "Cache-Control",
        transport.developmentUrl || name === "index.html"
          ? "no-store"
          : "private, max-age=31536000, immutable",
      );
      if (request.method === "HEAD") await response.body?.cancel();
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers,
      });
    },
    catch: () =>
      new DesktopError({
        message: "The desktop renderer asset could not be loaded.",
      }),
  }).pipe(
    Effect.catchTag("DesktopError", (error) =>
      Effect.succeed(failure(error.message, 404)),
    ),
  );
});

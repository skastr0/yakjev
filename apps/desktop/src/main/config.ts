import { createHash } from "node:crypto";
import { Data, Effect } from "effect";

export class DesktopError extends Data.TaggedError("DesktopError")<{
  readonly message: string;
}> {}

export function serverOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new DesktopError({ message: "Enter the server URL." });
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DesktopError({ message: "Enter a valid server URL." });
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new DesktopError({
      message:
        "Use an HTTPS server URL without a path, query, or credentials. HTTP is allowed only on loopback for local development.",
    });
  return url.origin;
}

export const decodeOrigin = (value: unknown) =>
  Effect.try({
    try: () => serverOrigin(value),
    catch: (cause) =>
      cause instanceof DesktopError
        ? cause
        : new DesktopError({ message: "Invalid server URL." }),
  });

export const sessionPartition = (origin: string, development: boolean) =>
  `persist:yakjev-${development ? "dev-" : ""}${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;

export function assetName(pathname: string): string | undefined {
  if (pathname === "/" || pathname === "/index.html") return "index.html";
  // The build has flat, content-hashed assets. Never turn a URL into a general
  // filesystem path, including percent-encoded separators and dot segments.
  if (/^\/assets\/[a-zA-Z0-9_-]+\.(js|css|svg|woff2)$/.test(pathname))
    return pathname.slice(1);
  return undefined;
}

export const isApiPath = (pathname: string) =>
  pathname.startsWith("/api/") || pathname === "/healthz";

export function rendererPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    `connect-src 'self'${development ? " ws://127.0.0.1:5174" : ""}`,
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

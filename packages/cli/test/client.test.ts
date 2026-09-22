import { expect, test } from "bun:test";
import { ApiError, request, TransportError } from "../src/client";

type Seen = { url: string; init: RequestInit | undefined };
const stubFetch = (
  responder: (seen: Seen) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; seen: () => Seen[] } => {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responder(calls[calls.length - 1]!);
  }) as typeof fetch;
  return { fetchImpl, seen: () => calls };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("builds the URL with query params and bearer header", async () => {
  const { fetchImpl, seen } = stubFetch(() => jsonResponse({ ok: 1 }));
  const result = await request(
    { remoteUrl: "http://srv:9000", token: "tok", fetchImpl },
    "GET",
    "/api/history",
    undefined,
    { after: 0, limit: 50 },
  );
  expect(result).toEqual({ ok: 1 });
  const call = seen()[0]!;
  expect(call.url).toBe("http://srv:9000/api/history?after=0&limit=50");
  expect(call.init?.method).toBe("GET");
  const headers = call.init?.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer tok");
  expect(headers["content-type"]).toBeUndefined();
  expect(call.init?.body).toBeNull();
});

test("POST serializes a JSON body and sets content-type", async () => {
  const { fetchImpl, seen } = stubFetch(() => jsonResponse({ ok: true }));
  await request(
    { remoteUrl: "http://srv", token: "t", fetchImpl },
    "POST",
    "/api/commands",
    { requestId: "r1" },
  );
  const call = seen()[0]!;
  const headers = call.init?.headers as Record<string, string>;
  expect(headers["content-type"]).toBe("application/json");
  expect(call.init?.body).toBe(JSON.stringify({ requestId: "r1" }));
});

test("no token means no authorization header", async () => {
  const { fetchImpl, seen } = stubFetch(() => jsonResponse({}));
  await request({ remoteUrl: "http://srv", fetchImpl }, "GET", "/healthz");
  const headers = seen()[0]!.init?.headers as Record<string, string>;
  expect("authorization" in headers).toBe(false);
});

test("an absolute path replaces any path component of remoteUrl", async () => {
  const { fetchImpl, seen } = stubFetch(() => jsonResponse({}));
  await request(
    { remoteUrl: "http://srv/base/", fetchImpl },
    "GET",
    "/api/graph",
  );
  expect(seen()[0]!.url).toBe("http://srv/api/graph");
});

test("a non-OK JSON body maps to ApiError with code, message and details", async () => {
  const { fetchImpl } = stubFetch(() =>
    jsonResponse(
      { error: "Conflict", message: "stale", currentRevision: 7 },
      409,
    ),
  );
  const error = await request(
    { remoteUrl: "http://srv", fetchImpl },
    "POST",
    "/api/commands",
    {},
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  const api = error as ApiError;
  expect(api.status).toBe(409);
  expect(api.code).toBe("Conflict");
  expect(api.message).toBe("stale");
  expect(api.details).toEqual({
    error: "Conflict",
    message: "stale",
    currentRevision: 7,
  });
});

test("a non-OK non-JSON body maps to ApiError with an HTTP status message", async () => {
  const { fetchImpl } = stubFetch(
    () => new Response("upstream exploded", { status: 502 }),
  );
  const api = (await request(
    { remoteUrl: "http://srv", fetchImpl },
    "GET",
    "/api/graph",
  ).catch((caught: unknown) => caught)) as ApiError;
  expect(api).toBeInstanceOf(ApiError);
  expect(api.status).toBe(502);
  expect(api.code).toBeUndefined();
  expect(api.message).toBe("HTTP 502");
  expect(api.details).toBeUndefined();
});

test("a non-OK JSON body without string fields still reports the status", async () => {
  const { fetchImpl } = stubFetch(() =>
    jsonResponse({ unexpected: true }, 400),
  );
  const api = (await request(
    { remoteUrl: "http://srv", fetchImpl },
    "GET",
    "/api/graph",
  ).catch((caught: unknown) => caught)) as ApiError;
  expect(api.code).toBeUndefined();
  expect(api.message).toBe("HTTP 400");
  expect(api.details).toEqual({ unexpected: true });
});

test("a rejected fetch maps to TransportError with url and cause", async () => {
  const cause = new Error("connection refused");
  const { fetchImpl } = stubFetch(() => Promise.reject(cause));
  const error = (await request(
    { remoteUrl: "http://srv:1", fetchImpl },
    "GET",
    "/api/graph",
  ).catch((caught: unknown) => caught)) as TransportError;
  expect(error).toBeInstanceOf(TransportError);
  expect(error.name).toBe("TransportError");
  expect(error.url).toBe("http://srv:1/api/graph");
  expect(error.cause).toBe(cause);
  expect(error.message).toBe("request failed: connection refused");
});

test("an OK empty or non-JSON body resolves to undefined", async () => {
  const { fetchImpl } = stubFetch(() => new Response("", { status: 200 }));
  await expect(
    request({ remoteUrl: "http://srv", fetchImpl }, "GET", "/healthz"),
  ).resolves.toBeUndefined();
  const plain = stubFetch(() => new Response("pong", { status: 200 }));
  await expect(
    request({ remoteUrl: "http://srv", fetchImpl: plain.fetchImpl }, "GET", "/x"),
  ).resolves.toBeUndefined();
});

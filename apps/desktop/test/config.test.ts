import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  assetName,
  decodeOrigin,
  DesktopError,
  externalUrl,
  serverOrigin,
  sessionPartition,
} from "../src/main/config";

describe("desktop server origins", () => {
  test.each([
    ["  HTTPS://Yakjev.Example:443/  ", "https://yakjev.example"],
    ["https://yakjev.example:8443/", "https://yakjev.example:8443"],
    ["http://localhost:7345/", "http://localhost:7345"],
    ["http://127.0.0.1:7345/", "http://127.0.0.1:7345"],
    ["http://[::1]:7345/", "http://[::1]:7345"],
  ])("canonicalizes an allowed server %s", (input, expected) => {
    expect(serverOrigin(input)).toBe(expected);
  });

  test.each([
    undefined,
    null,
    7345,
    {},
    "",
    "yakjev.example",
    "http://yakjev.example",
    "http://192.168.1.1:7345",
    "http://0.0.0.0:7345",
    "http://localhost.evil.example:7345",
    "http://127.0.0.1.evil.example:7345",
    "http://[::ffff:127.0.0.1]:7345",
    "https://owner:token@yakjev.example",
    "https://owner@yakjev.example",
    "https://yakjev.example/api",
    "https://yakjev.example//",
    "https://yakjev.example/%2fapi",
    "https://yakjev.example?token=secret",
    "https://yakjev.example#token=secret",
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "ws://localhost:7345",
  ])("refuses an untrusted or ambiguous server %p", (input) => {
    expect(() => serverOrigin(input)).toThrow(DesktopError);
  });

  test("rejects oversized server input", () => {
    expect(() => serverOrigin("https://" + "a".repeat(2048))).toThrow(
      DesktopError,
    );
  });

  test("origin decoding reports a typed recoverable failure", async () => {
    const result = await Effect.runPromise(
      decodeOrigin("http://public.example").pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        }),
      ),
    );
    expect(result).toBeInstanceOf(DesktopError);
    expect(result?._tag).toBe("DesktopError");
  });
});

describe("external source links", () => {
  test.each([
    [
      "https://sources.example/research/paper?q=graph#section-2",
      "https://sources.example/research/paper?q=graph#section-2",
    ],
    [
      "http://sources.example/reference?q=graph#details",
      "http://sources.example/reference?q=graph#details",
    ],
    ["HTTPS://Sources.Example:443/paper", "https://sources.example/paper"],
  ])("preserves a source destination %s", (input, expected) => {
    expect(externalUrl(input)).toBe(expected);
  });

  test.each([
    "javascript:alert(1)",
    "file:///tmp/reference.pdf",
    "yakjev://sources/reference",
    "mailto:owner@example.com",
    "data:text/html,<script>alert(1)</script>",
    "https://owner:token@sources.example/paper",
    "https://owner@sources.example/paper",
    "https://:token@sources.example/paper",
    "/relative/source",
    "not a URL",
  ])("refuses unsafe system-browser destinations %s", (input) => {
    expect(externalUrl(input)).toBeUndefined();
  });

  test("rejects oversized source URLs", () => {
    expect(
      externalUrl(`https://sources.example/${"x".repeat(8192)}`),
    ).toBeUndefined();
  });
});

test("persistent sessions isolate servers and development from production", () => {
  const primary = serverOrigin("HTTPS://Yakjev.Example:443/");
  const partition = sessionPartition(primary, false);
  expect(partition).toStartWith("persist:");
  expect(partition).toBe(
    sessionPartition(serverOrigin("https://yakjev.example"), false),
  );
  expect(partition).not.toBe(sessionPartition(primary, true));
  expect(partition).not.toBe(
    sessionPartition("https://another.example", false),
  );
  expect(partition).not.toBe(
    sessionPartition("https://yakjev.example:8443", false),
  );
  expect(partition).not.toContain("yakjev.example");
});

describe("bundled renderer assets", () => {
  test.each([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/assets/index-Ab12_3.js", "assets/index-Ab12_3.js"],
    ["/assets/index-Ab12_3.css", "assets/index-Ab12_3.css"],
    ["/assets/logo-Ab12_3.svg", "assets/logo-Ab12_3.svg"],
    ["/assets/font-Ab12_3.woff2", "assets/font-Ab12_3.woff2"],
  ])("allows a bundled asset %s", (input, expected) => {
    expect(assetName(input)).toBe(expected);
  });

  test.each([
    "/etc/passwd",
    "/assets/../index.html",
    "/assets/../../package.json",
    "/assets/%2e%2e/index.html",
    "/assets/%2E%2E%2Fpackage.json",
    "/assets/%252e%252e%252fpackage.json",
    "/assets/a%2fb.js",
    "/assets/a%5cb.js",
    "/assets/a\\b.js",
    "/assets/a/b.js",
    "/assets//app.js",
    "//assets/app.js",
    "/assets/app.js.map",
    "/assets/app.html",
    "/assets/app.js?token=secret",
    "/assets/app.js\0",
  ])("does not resolve an arbitrary path %s", (input) => {
    expect(assetName(input)).toBeUndefined();
  });
});

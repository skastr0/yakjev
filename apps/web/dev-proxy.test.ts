import { describe, expect, test } from "bun:test";
import { allowDevRequest } from "./dev-proxy";

describe("Vite development origin boundary", () => {
  const portal = "https://synthetic.onamp.dev";
  const request = {
    host: "synthetic.onamp.dev",
    origin: portal,
    method: "POST",
    authorization: undefined,
  };
  test("allows the explicit portal and matching loopback origin", () => {
    expect(allowDevRequest(request, portal)).toBe(true);
    expect(
      allowDevRequest(
        { ...request, host: "localhost:5173", origin: "http://localhost:5173" },
        portal,
      ),
    ).toBe(true);
  });
  test("never upgrades an attacker origin into a trusted backend origin", () => {
    expect(
      allowDevRequest({ ...request, origin: "https://attacker.test" }, portal),
    ).toBe(false);
    expect(
      allowDevRequest(
        { ...request, host: "attacker.test", origin: "https://attacker.test" },
        portal,
      ),
    ).toBe(false);
    expect(
      allowDevRequest(
        { ...request, origin: "http://synthetic.onamp.dev" },
        portal,
      ),
    ).toBe(false);
    expect(allowDevRequest({ ...request, origin: "null" }, portal)).toBe(false);
  });
  test("rejects cookie mutation without Origin; bearer can omit it", () => {
    expect(allowDevRequest({ ...request, origin: undefined }, portal)).toBe(
      false,
    );
    expect(
      allowDevRequest(
        { ...request, origin: undefined, authorization: "Bearer synthetic" },
        portal,
      ),
    ).toBe(true);
    expect(
      allowDevRequest(
        {
          ...request,
          origin: "https://attacker.test",
          authorization: "Bearer synthetic",
        },
        portal,
      ),
    ).toBe(false);
    expect(
      allowDevRequest({ ...request, origin: undefined, method: "GET" }, portal),
    ).toBe(true);
  });
  test("rejects cross-port origins and malformed host", () => {
    expect(
      allowDevRequest({
        ...request,
        host: "localhost:5173",
        origin: "http://localhost:4000",
      }),
    ).toBe(false);
    expect(allowDevRequest({ ...request, host: undefined }, portal)).toBe(
      false,
    );
  });
});

import { expect, test } from "bun:test";
import { fail, ok, writeJson } from "../src/json";
import { CliInputError } from "../src/client";

const capture = (isTTY?: boolean) => {
  let text = "";
  const stream: { write: (chunk: string) => boolean; isTTY?: boolean } = {
    write: (chunk: string) => {
      text += chunk;
      return true;
    },
  };
  if (isTTY !== undefined) stream.isTTY = isTTY;
  return { stream, text: () => text };
};

test("ok wraps data in the success envelope", () => {
  expect(ok("read graph", { revision: 3 })).toEqual({
    ok: true,
    command: "read graph",
    data: { revision: 3 },
  });
});

test("fail maps an Error to type, message and details", () => {
  const envelope = fail("yakjev", new CliInputError("bad", { hint: "x" }));
  expect(envelope).toEqual({
    ok: false,
    command: "yakjev",
    error: {
      type: "CliInputError",
      message: "bad",
      details: { hint: "x" },
    },
  });
});

test("fail on a non-Error reports type Error and stringifies", () => {
  const envelope = fail("yakjev", "oops");
  expect(envelope.error.type).toBe("Error");
  expect(envelope.error.message).toBe("oops");
  expect(envelope.error.details).toBeUndefined();
});

test("an Error without details serializes without a details key", () => {
  const envelope = fail("yakjev", new Error("plain"));
  expect(envelope.error.details).toBeUndefined();
  expect(Object.keys(JSON.parse(JSON.stringify(envelope)).error)).not.toContain(
    "details",
  );
});

test("writeJson emits single-line JSON plus newline when piped", () => {
  const out = capture(false);
  writeJson(ok("command", { a: 1 }), out.stream);
  expect(out.text()).toBe('{"ok":true,"command":"command","data":{"a":1}}\n');
});

test("writeJson pretty-prints when the stream is a TTY", () => {
  const out = capture(true);
  writeJson(ok("command", { a: 1 }), out.stream);
  expect(out.text()).toBe('{\n  "ok": true,\n  "command": "command",\n  "data": {\n    "a": 1\n  }\n}\n');
});

test("writeJson defaults to compact when isTTY is unset", () => {
  const out = capture(undefined);
  writeJson(fail("yakjev", new Error("x")), out.stream);
  expect(out.text().trim().startsWith("{")).toBe(true);
  expect(out.text()).not.toContain("\n  ");
});

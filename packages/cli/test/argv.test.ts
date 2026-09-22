import { expect, test } from "bun:test";
import { parseCliArguments } from "../src/argv";

const valueOptions = new Set(["--server", "--token", "--timeout-ms"]);

test("positionals and options are separated in order", () => {
  const args = parseCliArguments(
    ["read", "graph", "--server", "http://x", "--help"],
    valueOptions,
  );
  expect(args.positionals).toEqual(["read", "graph"]);
  expect(args.optionNames).toEqual(["--server", "--help"]);
  expect(args.first("--server")).toBe("http://x");
  expect(args.has("--help")).toBe(true);
  expect(args.has("--version")).toBe(false);
  expect(args.missingValueOptions).toEqual([]);
});

test("a value option at the end reports a missing value", () => {
  const args = parseCliArguments(["read", "graph", "--server"], valueOptions);
  expect(args.positionals).toEqual(["read", "graph"]);
  expect(args.missingValueOptions).toEqual(["--server"]);
  expect(args.first("--server")).toBeUndefined();
});

test("a value option consumes the next token even when it looks like an option", () => {
  const args = parseCliArguments(
    ["--server", "--token", "abc"],
    valueOptions,
  );
  expect(args.first("--server")).toBe("--token");
  expect(args.optionNames).toEqual(["--server"]);
  expect(args.positionals).toEqual(["abc"]);
  expect(args.missingValueOptions).toEqual([]);
});

test("a bare dash is a positional (stdin marker), not an option", () => {
  const args = parseCliArguments(["command", "-"], valueOptions);
  expect(args.positionals).toEqual(["command", "-"]);
  expect(args.optionNames).toEqual([]);
});

test("equals syntax is not split: --server=x is one unknown option", () => {
  const args = parseCliArguments(["read", "graph", "--server=http://x"], valueOptions);
  expect(args.optionNames).toEqual(["--server=http://x"]);
  expect(args.first("--server")).toBeUndefined();
  expect(args.positionals).toEqual(["read", "graph"]);
});

test("first() returns the first occurrence of a repeated option", () => {
  const args = parseCliArguments(
    ["--server", "a", "--server", "b"],
    valueOptions,
  );
  expect(args.first("--server")).toBe("a");
  expect(args.optionNames).toEqual(["--server", "--server"]);
});

test("double dash is not special and becomes an unknown option", () => {
  const args = parseCliArguments(["read", "graph", "--", "{}"], valueOptions);
  expect(args.optionNames).toEqual(["--"]);
  expect(args.positionals).toEqual(["read", "graph", "{}"]);
});

test("single-letter booleans are options, not positionals", () => {
  const args = parseCliArguments(["-h"], valueOptions);
  expect(args.positionals).toEqual([]);
  expect(args.has("-h")).toBe(true);
});

test("missing values accumulate across several value options", () => {
  const args = parseCliArguments(["--server", "--token"], valueOptions);
  // --server consumed --token as its value; nothing left to be missing.
  expect(args.missingValueOptions).toEqual([]);
  const trailing = parseCliArguments(
    ["read", "graph", "--server", "x", "--token"],
    valueOptions,
  );
  expect(trailing.missingValueOptions).toEqual(["--token"]);
});

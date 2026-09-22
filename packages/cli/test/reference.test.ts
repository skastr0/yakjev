import { expect, test } from "bun:test";
import { CommandRequest, EvaluationRequest } from "@yakjev/protocol";
import { Effect, Schema } from "effect";
import {
  COMMAND_REFERENCE,
  EXAMPLES,
  READ_REFERENCE,
} from "../src/reference";

const COMMAND_TYPES = [
  "capture",
  "capture.remove",
  "node.put",
  "node.remove",
  "edge.put",
  "edge.remove",
  "edge.reframe",
  "layout.set",
  "taxonomy.replace",
  "suggestion.record",
  "suggestion.decide",
  "evaluation.record",
  "undo",
] as const;

const READ_VIEWS = [
  "graph",
  "history",
  "search",
  "neighborhood",
  "export",
  "evaluation",
  "node",
  "edge",
] as const;

test("the command reference covers every Command union member", () => {
  expect(Object.keys(COMMAND_REFERENCE).sort()).toEqual(
    [...COMMAND_TYPES].sort(),
  );
});

test("the read reference covers every read view", () => {
  expect(Object.keys(READ_REFERENCE).sort()).toEqual([...READ_VIEWS].sort());
});

test("every reference entry declares fields and notes", () => {
  for (const entry of Object.values(COMMAND_REFERENCE)) {
    expect(Object.keys(entry.fields).length).toBeGreaterThan(0);
    expect(entry.notes.length).toBeGreaterThan(0);
  }
  for (const entry of Object.values(READ_REFERENCE)) {
    expect(entry.notes.length).toBeGreaterThan(0);
  }
});

const decodes = <A, I>(schema: Schema.Codec<A, I>, input: unknown): boolean =>
  Effect.runSync(
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    ),
  );

test("every command example decodes against the protocol CommandRequest", () => {
  for (const name of COMMAND_TYPES) {
    expect({ name, decoded: decodes(CommandRequest, EXAMPLES[name]) }).toEqual({
      name,
      decoded: true,
    });
  }
});

test("examples cover every command, every read view, discover and evaluate", () => {
  expect(Object.keys(EXAMPLES).sort()).toEqual(
    [
      ...COMMAND_TYPES,
      ...READ_VIEWS.map((view) => `read.${view}`),
      "discover",
      "evaluate",
    ].sort(),
  );
});

test("the evaluate example decodes against EvaluationRequest", () => {
  expect(decodes(EvaluationRequest, EXAMPLES.evaluate)).toBe(true);
});

test("the discover example carries a query string", () => {
  const example = EXAMPLES.discover as { query?: unknown };
  expect(typeof example.query).toBe("string");
});

import { expect, test } from "bun:test";
import { createEventParser, type ServerEvent } from "../src/events";

test("SSE frames survive every chunk boundary, CRLF, comments, and multiline data", () => {
  const input =
    "\uFEFF: connected\r\nid: 4\r\nevent: change\r\ndata: first\r\ndata: second\r\n\r\n: keepalive\n\ndata: next\n\n";
  for (let split = 0; split <= input.length; split++) {
    const events: ServerEvent[] = [];
    const parser = createEventParser((event) => events.push(event));
    parser.feed(input.slice(0, split));
    parser.feed(input.slice(split));
    parser.end();
    expect(events).toEqual([
      { event: "change", data: "first\nsecond", id: "4" },
      { event: "message", data: "next", id: "4" },
    ]);
  }
});

test("SSE ignores incomplete receipts, accepts CR line endings, and resets event ids", () => {
  const events: ServerEvent[] = [];
  const parser = createEventParser((event) => events.push(event));
  for (const character of "id: 1\rdata: a\r\rid: invalid\0id\ndata: b\n\nid:\ndata:\n\ndata: interrupted")
    parser.feed(character);
  parser.end();
  expect(events).toEqual([
    { event: "message", data: "a", id: "1" },
    { event: "message", data: "b", id: "1" },
    { event: "message", data: "", id: "" },
  ]);
});

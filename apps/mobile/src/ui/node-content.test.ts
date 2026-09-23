import { describe, expect, test } from "bun:test";
import type { Node } from "@yakjev/protocol";
import { sameNodeContent } from "./node-content";

const original: Node = {
  id: "intention",
  title: "Build Yakjev",
  description: "Keep the graph alive.",
  project: "Yakjev",
  status: "active",
  sources: [{ uri: "https://example.com/brief", label: "Brief" }],
  color: "#ed4968",
  position: null,
  created: {
    actor: { id: "owner", channel: "browser" },
    at: "2026-09-23T00:00:00Z",
    revision: 1,
  },
  updated: {
    actor: { id: "owner", channel: "browser" },
    at: "2026-09-23T00:00:00Z",
    revision: 1,
  },
};

describe("open intention draft conflict detection", () => {
  test("paint and layout changes preserve the editable draft, even with a new revision", () => {
    const painted: Node = {
      ...original,
      color: null,
      position: { x: 10, y: -20, pinned: false },
      updated: { ...original.updated, revision: 2 },
    };
    expect(sameNodeContent(original, painted)).toBe(true);
  });

  test("remote edits to any saved field still require reviewing the latest content", () => {
    const changes: Partial<Node>[] = [
      { title: "Ship Yakjev" },
      { description: "Changed remotely" },
      { project: "Another project" },
      { status: "done" },
      { sources: [] },
      { sources: [{ uri: "https://example.com/other", label: "Brief" }] },
      { sources: [{ uri: "https://example.com/brief", label: "New label" }] },
    ];
    for (const change of changes)
      expect(sameNodeContent(original, { ...original, ...change })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Command,
  initialTaxonomy,
  type Preview,
  type PreviewJudgment,
} from "@yakjev/protocol";
import {
  captureWithJev,
  confidenceText,
  connections,
  jevEdge,
  typingGhosts,
} from "./jev";

const graph = {
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
  taxonomy: initialTaxonomy,
} as never;
const relation = initialTaxonomy.relations[0]!.id;

const judgment = (patch: Partial<PreviewJudgment>): PreviewJudgment => ({
  nodeId: "a",
  relatedness: 1,
  match: true,
  same: false,
  relation,
  direction: "focus_to_candidate",
  confidence: 0.82,
  suppressed: false,
  connect: true,
  ...patch,
});

const preview = (judgments: PreviewJudgment[]): Preview => ({
  basedOnRevision: 4,
  taxonomyVersion: 1,
  status: "succeeded",
  model: "jev-test",
  promptVersion: "p1",
  elapsedMs: 120,
  judgments,
});

describe("connections", () => {
  test("keeps only visible judgments the server would connect", () => {
    const result = connections(
      preview([
        judgment({ nodeId: "a" }),
        judgment({ nodeId: "b", connect: false }),
        judgment({ nodeId: "gone" }),
      ]),
      graph,
    );
    expect(result.map((item) => item.nodeId)).toEqual(["a"]);
  });

  test("an unavailable preview connects nothing", () => {
    expect(
      connections({ ...preview([judgment({})]), status: "unavailable" }, graph),
    ).toEqual([]);
  });
});

describe("jevEdge", () => {
  test("follows the judged direction and carries the origin", () => {
    const p = preview([]);
    const forward = jevEdge("new", p, judgment({ nodeId: "a" }));
    expect(forward).toMatchObject({
      source: "new",
      target: "a",
      relation,
      rationale: "Connected by Jev.",
      origin: {
        model: "jev-test",
        promptVersion: "p1",
        confidence: 0.82,
        same: false,
      },
    });
    const backward = jevEdge(
      "new",
      p,
      judgment({ nodeId: "a", direction: "candidate_to_focus" }),
    );
    expect(backward).toMatchObject({ source: "a", target: "new" });
  });
});

describe("captureWithJev", () => {
  const draft = {
    text: "Ship the preview",
    preview: preview([
      judgment({ nodeId: "a" }),
      judgment({ nodeId: "b", direction: "candidate_to_focus", same: true }),
    ]),
  };

  test("a preview for the exact text becomes the capture's edges", () => {
    const built = captureWithJev(" Ship the preview ", draft, graph);
    if (built?.command.type !== "capture") throw new Error("no capture");
    expect(built.command.autoConnect).toBe(false);
    expect(built.connected).toBe(2);
    expect(
      built.command.edges.map((edge) => [edge.source, edge.target]),
    ).toEqual([
      [built.nodeId, "a"],
      ["b", built.nodeId],
    ]);
    expect(() =>
      Schema.decodeUnknownSync(Command)(built.command),
    ).not.toThrow();
  });

  test("stale or failed previews leave connecting to the server", () => {
    for (const next of [
      captureWithJev("Ship the preview now", draft, graph),
      captureWithJev(
        "Ship the preview",
        { ...draft, preview: { ...draft.preview, status: "failed" } },
        graph,
      ),
      captureWithJev("Ship the preview", null, graph),
    ]) {
      if (next?.command.type !== "capture") throw new Error("no capture");
      expect(next.command.autoConnect).toBe(true);
      expect(next.command.edges).toEqual([]);
    }
  });

  test("an empty title captures nothing", () => {
    expect(captureWithJev("   ", draft, graph)).toBeNull();
  });
});

test("typing ghosts start at the create point and label the relation", () => {
  const ghosts = typingGhosts(
    [judgment({ nodeId: "a", relatedness: 1.4 }), judgment({ same: true })],
    graph,
    { x: 10, y: 20 },
  );
  expect(ghosts[0]).toEqual({
    from: { x: 10, y: 20 },
    to: "a",
    strength: 1,
    label: initialTaxonomy.relations[0]!.label,
    kind: "typing",
  });
  expect(ghosts[1]?.label).toBe("same");
});

test("confidence reads as a whole percent", () => {
  expect(confidenceText(0.824)).toBe("82%");
  expect(confidenceText(null)).toBe("");
});

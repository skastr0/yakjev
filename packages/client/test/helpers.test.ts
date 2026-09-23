import { expect, test } from "bun:test";
import { type Graph, type Preview } from "@yakjev/protocol";
import { captureWithJev } from "../src/jev";
import { assertEdge } from "../src/graph-commands";

test("native UUID injection covers every capture and Jev edge identifier", () => {
  let id = 0;
  const newId = () => `native-${++id}`;
  const preview: Preview = {
    basedOnRevision: 0,
    taxonomyVersion: 1,
    status: "succeeded",
    model: "server-model",
    promptVersion: "p1",
    elapsedMs: 1,
    judgments: [
      {
        nodeId: "a",
        relatedness: 0.9,
        match: true,
        same: false,
        relation: "requires",
        direction: "focus_to_candidate",
        confidence: 0.8,
        suppressed: false,
        connect: true,
      },
    ],
  };
  const provenance = {
    actor: { id: "owner", channel: "browser" as const },
    at: "2026-09-22T00:00:00Z",
    revision: 0,
  };
  const graph: Pick<Graph, "nodes"> = {
    nodes: [
      {
        id: "a",
        title: "Existing",
        description: "",
        project: "",
        status: "idea",
        sources: [],
        position: null,
        created: provenance,
        updated: provenance,
      },
    ],
  };
  const captured = captureWithJev(
    "new",
    { text: "new", preview },
    graph,
    newId,
  );
  expect(captured).toMatchObject({
    nodeId: "native-1",
    connected: 1,
    command: {
      capture: { id: "native-2" },
      edges: [{ id: "native-3", source: "native-1", target: "a" }],
      autoConnect: false,
    },
  });
  expect(assertEdge("a", "b", "requires", undefined, newId).edgeId).toBe(
    "native-4",
  );
});

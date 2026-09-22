import { describe, expect, test } from "bun:test";
import {
  Command,
  initialTaxonomy,
  type Edge,
  type Node,
  type Taxonomy,
} from "@yakjev/protocol";
import { Schema } from "effect";
import {
  addRelation,
  assertEdge,
  captureIntention,
  decideSuggestion,
  reframeEdge,
  removeEdge,
  removeNode,
  updateNode,
} from "./graph-commands";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

const sampleProvenance = {
  actor: { id: "test-user", channel: "browser" as const },
  at: "2026-09-22T00:00:00.000Z",
  revision: 1,
};

const sampleNode: Node = {
  id: "node-123",
  title: "Existing Title",
  description: "Existing Description",
  project: "Project Alpha",
  status: "active",
  sources: [{ uri: "https://example.com/spec", label: "Spec" }],
  position: { x: 10, y: 20, pinned: true },
  created: sampleProvenance,
  updated: sampleProvenance,
};

const sampleEdge: Edge = {
  id: "edge-456",
  source: "node-1",
  target: "node-2",
  relation: "requires",
  rationale: "Initial edge rationale",
  state: "asserted",
  assertion: {
    relation: "requires",
    rationale: "Initial edge rationale",
    provenance: sampleProvenance,
  },
  correction: null,
  updated: sampleProvenance,
};

describe("graph-commands", () => {
  describe("captureIntention", () => {
    test("returns null for empty or whitespace titles", () => {
      expect(captureIntention("")).toBeNull();
      expect(captureIntention("   ")).toBeNull();
      expect(captureIntention("\t\n  ")).toBeNull();
    });

    test("builds capture command with trimmed title and fresh UUIDs", () => {
      const result = captureIntention("  Ship v1 launch  ");
      expect(result).not.toBeNull();
      if (!result) return;

      const { command, nodeId } = result;
      expect(nodeId).toMatch(uuidRegex);
      expect(command.type).toBe("capture");

      if (command.type === "capture") {
        expect(command.capture.id).toMatch(uuidRegex);
        expect(command.capture.text).toBe("Ship v1 launch");
        expect(command.capture.sources).toEqual([]);
        expect(command.capture.nodeIds).toEqual([nodeId]);

        expect(command.nodes).toHaveLength(1);
        const node = command.nodes[0]!;
        expect(node.id).toBe(nodeId);
        expect(node.title).toBe("Ship v1 launch");
        expect(node.description).toBe("");
        expect(node.project).toBe("");
        expect(node.status).toBe("idea");
        expect(node.sources).toEqual([]);

        expect(command.edges).toEqual([]);
      }

      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command);
    });
  });

  describe("updateNode", () => {
    test("returns null if patched title is blank or whitespace", () => {
      expect(updateNode(sampleNode, { title: "" })).toBeNull();
      expect(updateNode(sampleNode, { title: "   " })).toBeNull();
      expect(updateNode(sampleNode, { title: "\n\t " })).toBeNull();
    });

    test("returns null if node has blank title and patch does not supply one", () => {
      const blankNode = { ...sampleNode, title: "   " };
      expect(updateNode(blankNode, {})).toBeNull();
    });

    test("overlays patch onto node, trimming title and sending node.put", () => {
      const command = updateNode(sampleNode, {
        title: "  Updated Intention  ",
        description: "New context",
        status: "done",
      });

      expect(command).not.toBeNull();
      expect(command?.type).toBe("node.put");

      if (command?.type === "node.put") {
        expect(command.node).toEqual({
          id: sampleNode.id,
          title: "Updated Intention",
          description: "New context",
          project: sampleNode.project,
          status: "done",
          sources: sampleNode.sources,
        });
      }

      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command!);
    });

    test("keeps existing title when patch updates other fields", () => {
      const command = updateNode(sampleNode, {
        project: "Project Beta",
      });

      expect(command).not.toBeNull();
      if (command?.type === "node.put") {
        expect(command.node.title).toBe(sampleNode.title);
        expect(command.node.project).toBe("Project Beta");
      }
    });
  });

  describe("assertEdge", () => {
    test("sends edge.put with default rationale when omitted or whitespace", () => {
      const res1 = assertEdge("node-a", "node-b", "requires");
      expect(res1.edgeId).toMatch(uuidRegex);
      expect(res1.command.type).toBe("edge.put");
      if (res1.command.type === "edge.put") {
        expect(res1.command.edge).toEqual({
          id: res1.edgeId,
          source: "node-a",
          target: "node-b",
          relation: "requires",
          rationale: "Claimed on the graph.",
        });
      }

      const res2 = assertEdge("node-a", "node-b", "requires", "   ");
      if (res2.command.type === "edge.put") {
        expect(res2.command.edge.rationale).toBe("Claimed on the graph.");
      }

      expect(Schema.decodeUnknownSync(Command)(res1.command)).toEqual(
        res1.command,
      );
    });

    test("trimmed user rationale wins when non-empty", () => {
      const res = assertEdge(
        "node-a",
        "node-b",
        "requires",
        "  Hard architectural dependency  ",
      );
      if (res.command.type === "edge.put") {
        expect(res.command.edge.rationale).toBe(
          "Hard architectural dependency",
        );
      }
      expect(Schema.decodeUnknownSync(Command)(res.command)).toEqual(
        res.command,
      );
    });
  });

  describe("reframeEdge", () => {
    test("sends edge.reframe with patched relation, state, and trimmed rationale", () => {
      const command = reframeEdge(sampleEdge, {
        relation: "benefits_from",
        state: "disputed",
        rationale: "  Not actually blocking  ",
      });

      expect(command.type).toBe("edge.reframe");
      if (command.type === "edge.reframe") {
        expect(command).toEqual({
          type: "edge.reframe",
          id: sampleEdge.id,
          relation: "benefits_from",
          state: "disputed",
          rationale: "Not actually blocking",
        });
      }

      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command);
    });

    test("defaults relation and state to existing edge values when omitted", () => {
      const command = reframeEdge(sampleEdge, {});
      if (command.type === "edge.reframe") {
        expect(command.relation).toBe(sampleEdge.relation);
        expect(command.state).toBe(sampleEdge.state);
        expect(command.rationale).toBe(sampleEdge.rationale);
      }
    });

    test("falls back to Reframed on the graph when neither patch nor edge has rationale", () => {
      const edgeWithoutRationale = { ...sampleEdge, rationale: "" };
      const command = reframeEdge(edgeWithoutRationale, { rationale: "   " });
      if (command.type === "edge.reframe") {
        expect(command.rationale).toBe("Reframed on the graph.");
      }
    });
  });

  describe("decideSuggestion", () => {
    test("sends suggestion.decide with accept rationale", () => {
      const command = decideSuggestion("sugg-1", "accept");
      expect(command).toEqual({
        type: "suggestion.decide",
        id: "sugg-1",
        decision: "accept",
        rationale: "Accepted on the graph.",
      });
      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command);
    });

    test("sends suggestion.decide with reject rationale", () => {
      const command = decideSuggestion("sugg-2", "reject");
      expect(command).toEqual({
        type: "suggestion.decide",
        id: "sugg-2",
        decision: "reject",
        rationale: "Rejected on the graph.",
      });
      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command);
    });
  });

  describe("removeNode", () => {
    test("sends node.remove with ids: [id], removeEdges: true, and honest rationale", () => {
      const command = removeNode("node-to-delete");
      expect(command).toEqual({
        type: "node.remove",
        ids: ["node-to-delete"],
        removeEdges: true,
        rationale: "Removed on the graph.",
      });
      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command);
    });
  });

  describe("removeEdge", () => {
    test("sends edge.remove with id and honest rationale", () => {
      const command = removeEdge("edge-to-delete");
      expect(command).toEqual({
        type: "edge.remove",
        id: "edge-to-delete",
        rationale: "Removed on the graph.",
      });
      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command);
    });
  });

  describe("addRelation", () => {
    test("sends taxonomy.replace with existing relations plus one", () => {
      const command = addRelation(initialTaxonomy, "Blocks release");
      expect(command.type).toBe("taxonomy.replace");

      if (command.type === "taxonomy.replace") {
        expect(command.relations).toHaveLength(
          initialTaxonomy.relations.length + 1,
        );
        const added = command.relations[command.relations.length - 1]!;
        expect(added).toEqual({
          id: "blocks_release",
          label: "Blocks release",
          definition: "Blocks release",
          blocking: false,
        });
        expect(added.id).toMatch(idPattern);
        // Explicitly verify the contract expected by editor.tsx: command.relations.at(-1)
        expect(command.relations.at(-1)?.id).toBe("blocks_release");
      }

      expect(Schema.decodeUnknownSync(Command)(command)).toEqual(command);
    });

    test("prefixes r_ if slug does not start with alphanumeric", () => {
      const command1 = addRelation(initialTaxonomy, "-special-case");
      if (command1.type === "taxonomy.replace") {
        const added = command1.relations[command1.relations.length - 1]!;
        expect(added.id).toBe("r_special-case");
        expect(added.id).toMatch(idPattern);
      }

      const command2 = addRelation(initialTaxonomy, "---");
      if (command2.type === "taxonomy.replace") {
        const added = command2.relations[command2.relations.length - 1]!;
        expect(added.id).toBe("r_");
        expect(added.id).toMatch(idPattern);
      }
    });

    test("suffixes _2, _3 on collision with existing relation ids", () => {
      const taxonomyWithRequires: Taxonomy = {
        version: 1,
        relations: [
          {
            id: "requires",
            label: "Requires",
            definition: "Prerequisite",
            blocking: true,
          },
        ],
      };

      const cmd1 = addRelation(taxonomyWithRequires, "Requires");
      if (cmd1.type === "taxonomy.replace") {
        const added1 = cmd1.relations[cmd1.relations.length - 1]!;
        expect(added1.id).toBe("requires_2");
        expect(added1.id).toMatch(idPattern);
      }

      const taxonomyWithRequires2: Taxonomy = {
        version: 1,
        relations: [
          {
            id: "requires",
            label: "Requires",
            definition: "Prerequisite",
            blocking: true,
          },
          {
            id: "requires_2",
            label: "Requires (2)",
            definition: "Prerequisite",
            blocking: true,
          },
        ],
      };

      const cmd2 = addRelation(taxonomyWithRequires2, "Requires");
      if (cmd2.type === "taxonomy.replace") {
        const added2 = cmd2.relations[cmd2.relations.length - 1]!;
        expect(added2.id).toBe("requires_3");
        expect(added2.id).toMatch(idPattern);
      }
    });
  });
});

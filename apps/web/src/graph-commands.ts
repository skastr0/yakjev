import type { Command, Edge, Node, Taxonomy } from "@yakjev/protocol";

export function captureIntention(
  title: string,
): { command: Command; nodeId: string } | null {
  const trimmed = title.trim();
  if (!trimmed) {
    return null;
  }
  const nodeId = crypto.randomUUID();
  const captureId = crypto.randomUUID();
  const command: Command = {
    type: "capture",
    capture: {
      id: captureId,
      text: trimmed,
      sources: [],
      nodeIds: [nodeId],
    },
    nodes: [
      {
        id: nodeId,
        title: trimmed,
        description: "",
        project: "",
        status: "idea",
        sources: [],
      },
    ],
    edges: [],
  };
  return { command, nodeId };
}

export function updateNode(
  node: Node,
  patch: Partial<
    Pick<Node, "title" | "description" | "project" | "status" | "sources">
  >,
): Command | null {
  const title = (patch.title !== undefined ? patch.title : node.title).trim();
  if (!title) {
    return null;
  }
  return {
    type: "node.put",
    node: {
      id: node.id,
      title,
      description:
        patch.description !== undefined ? patch.description : node.description,
      project: patch.project !== undefined ? patch.project : node.project,
      status: patch.status !== undefined ? patch.status : node.status,
      sources: patch.sources !== undefined ? patch.sources : node.sources,
    },
  };
}

export function assertEdge(
  source: string,
  target: string,
  relation: string,
  rationale?: string,
): { command: Command; edgeId: string } {
  const edgeId = crypto.randomUUID();
  const trimmedRationale = rationale?.trim();
  return {
    command: {
      type: "edge.put",
      edge: {
        id: edgeId,
        source,
        target,
        relation,
        rationale:
          trimmedRationale && trimmedRationale.length > 0
            ? trimmedRationale
            : "Claimed on the graph.",
      },
    },
    edgeId,
  };
}

export function reframeEdge(
  edge: Edge,
  patch: {
    relation?: string;
    rationale?: string;
    state?: "asserted" | "disputed";
  },
): Command {
  const trimmedPatch = patch.rationale?.trim();
  const trimmedEdge = edge.rationale?.trim();
  const rationale =
    trimmedPatch && trimmedPatch.length > 0
      ? trimmedPatch
      : trimmedEdge && trimmedEdge.length > 0
        ? trimmedEdge
        : "Reframed on the graph.";

  return {
    type: "edge.reframe",
    id: edge.id,
    relation: patch.relation ?? edge.relation,
    rationale,
    state: patch.state ?? edge.state,
  };
}

export function decideSuggestion(
  id: string,
  decision: "accept" | "reject",
): Command {
  return {
    type: "suggestion.decide",
    id,
    decision,
    rationale:
      decision === "accept"
        ? "Accepted on the graph."
        : "Rejected on the graph.",
  };
}

export function removeNode(id: string): Command {
  return {
    type: "node.remove",
    ids: [id],
    removeEdges: true,
    rationale: "Removed on the graph.",
  };
}

export function removeEdge(id: string): Command {
  return {
    type: "edge.remove",
    id,
    rationale: "Removed on the graph.",
  };
}

function toRelationSlug(label: string): string {
  const trimmed = label.trim().toLowerCase();
  let slug = trimmed
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/_+$/, "");

  if (!slug || !/^[a-zA-Z0-9]/.test(slug)) {
    const clean = slug.replace(/^[^a-zA-Z0-9]+/, "");
    slug = clean ? `r_${clean}` : "r_";
  }
  return slug.slice(0, 128);
}

export function addRelation(taxonomy: Taxonomy, label: string): Command {
  const trimmed = label.trim();
  const baseId = toRelationSlug(label);
  const existingIds = new Set(
    taxonomy.relations.map((relation) => relation.id),
  );

  let id = baseId;
  if (existingIds.has(id)) {
    let counter = 2;
    while (true) {
      const suffix = `_${counter}`;
      const candidate = `${baseId.slice(0, 128 - suffix.length)}${suffix}`;
      if (!existingIds.has(candidate)) {
        id = candidate;
        break;
      }
      counter++;
    }
  }

  return {
    type: "taxonomy.replace",
    relations: [
      ...taxonomy.relations,
      {
        id,
        label: trimmed,
        definition: trimmed,
        blocking: false,
      },
    ],
  };
}

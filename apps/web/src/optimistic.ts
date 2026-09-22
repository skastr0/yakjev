import type { Command, Edge, EdgeInput, Graph, Node } from "@yakjev/protocol";

// Show an edit before the server confirms it. The result is display-only: the
// next snapshot replaces it, and an edit already in that snapshot applies as a
// no-op, so a confirmed edit never shows twice. Commands whose outcome only the
// server can decide (taxonomy, suggestions, evaluations, undo) wait for it.
export function applyOptimistic(graph: Graph, command: Command): Graph {
  const provenance = {
    actor: { id: "pending", channel: "browser" as const },
    at: "",
    revision: graph.revision + 1,
  };
  const nodeOf = (input: Omit<Node, "position" | "created" | "updated">) => ({
    ...input,
    position: null,
    created: provenance,
    updated: provenance,
  });
  const edgeOf = ({ origin, ...input }: EdgeInput): Edge => ({
    ...input,
    ...(origin ? { origin } : {}),
    state: "asserted",
    assertion: {
      relation: input.relation,
      rationale: input.rationale,
      provenance,
    },
    correction: null,
    updated: provenance,
  });
  const hasNode = (id: string) => graph.nodes.some((node) => node.id === id);
  const hasPair = (source: string, target: string) =>
    graph.edges.some(
      (edge) => edge.source === source && edge.target === target,
    );
  switch (command.type) {
    case "capture": {
      const nodes = command.nodes.filter((node) => !hasNode(node.id));
      const known = new Set([
        ...graph.nodes.map((node) => node.id),
        ...nodes.map((node) => node.id),
      ]);
      const edges = command.edges.filter(
        (edge) =>
          known.has(edge.source) &&
          known.has(edge.target) &&
          !graph.edges.some((item) => item.id === edge.id) &&
          !hasPair(edge.source, edge.target),
      );
      if (nodes.length === 0 && edges.length === 0) return graph;
      return {
        ...graph,
        nodes: [...graph.nodes, ...nodes.map(nodeOf)],
        edges: [...graph.edges, ...edges.map(edgeOf)],
      };
    }
    case "node.put": {
      const old = graph.nodes.find((node) => node.id === command.node.id);
      const node: Node = old
        ? { ...old, ...command.node }
        : nodeOf(command.node);
      return {
        ...graph,
        nodes: old
          ? graph.nodes.map((item) => (item.id === node.id ? node : item))
          : [...graph.nodes, node],
      };
    }
    case "node.remove": {
      const removed = new Set(command.ids);
      return {
        ...graph,
        nodes: graph.nodes.filter((node) => !removed.has(node.id)),
        edges: graph.edges.filter(
          (edge) => !removed.has(edge.source) && !removed.has(edge.target),
        ),
      };
    }
    case "edge.put": {
      const { edge } = command;
      if (
        !hasNode(edge.source) ||
        !hasNode(edge.target) ||
        graph.edges.some((item) => item.id === edge.id) ||
        hasPair(edge.source, edge.target)
      )
        return graph;
      return { ...graph, edges: [...graph.edges, edgeOf(edge)] };
    }
    case "edge.remove":
      return {
        ...graph,
        edges: graph.edges.filter((edge) =>
          command.id !== undefined
            ? edge.id !== command.id
            : !(
                edge.source === command.source && edge.target === command.target
              ),
        ),
      };
    case "edge.reframe":
      return {
        ...graph,
        edges: graph.edges.map((edge) =>
          edge.id === command.id
            ? {
                ...edge,
                relation: command.relation,
                rationale: command.rationale,
                state: command.state,
                correction: {
                  relation: command.relation,
                  rationale: command.rationale,
                  state: command.state,
                  provenance,
                },
              }
            : edge,
        ),
      };
    default:
      return graph;
  }
}

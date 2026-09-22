import { useEffect, useRef, useState } from "react";
import { MultiDirectedGraph } from "graphology";
import Sigma, { DEFAULT_STYLES } from "sigma";
import {
  extremityArrow,
  layerPlain,
  pathCurved,
  pathLine,
  pathLoop,
} from "sigma/rendering";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import type { Graph } from "@yakjev/protocol";
import {
  layoutBounds,
  syncGraph,
  type LayoutPosition,
  type Selection,
} from "./graph-model";

type Props = {
  data: Graph;
  selection: Selection;
  visible: ReadonlySet<string> | null;
  select: (selection: Selection) => void;
  save: (positions: LayoutPosition[], revision: number) => Promise<boolean>;
  report: (message: string) => void;
  pending: boolean;
};

export function GraphCanvas(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef(new MultiDirectedGraph());
  const renderer = useRef<Sigma | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const layout = useRef<FA2Layout | null>(null);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queued = useRef(new Map<string, LayoutPosition>());
  const dragRevision = useRef(0);
  const [renderError, setRenderError] = useState("");
  const [arranging, setArranging] = useState(false);

  function fitGraph(sigma: Sigma) {
    const positions = graph.current.nodes().map((id) => ({
      x: graph.current.getNodeAttribute(id, "x") as number,
      y: graph.current.getNodeAttribute(id, "y") as number,
    }));
    // A nonempty, fixed coordinate frame also works before the first capture.
    // Sigma v4 otherwise freezes the empty extent with autoRescale: "once".
    sigma.setCustomBBox(layoutBounds(positions));
    void sigma.getCamera().reset();
  }

  useEffect(() => {
    if (!container.current) return;
    syncGraph(graph.current, latest.current.data);
    try {
      const sigma = new Sigma(graph.current, container.current, {
        primitives: {
          edges: {
            paths: [pathLine(), pathCurved(), pathLoop()],
            extremities: [extremityArrow()],
            layers: [layerPlain()],
          },
        },
        styles: {
          nodes: [
            DEFAULT_STYLES.nodes,
            {
              size: 9,
              labelColor: "#203d35",
              labelSize: 13,
              labelPosition: (attributes) => {
                const width = container.current?.clientWidth ?? 0;
                if (width < 500) return "above";
                const point = renderer.current?.graphToViewport({
                  x: attributes.x as number,
                  y: attributes.y as number,
                });
                return point &&
                  point.x + String(attributes.label).length * 8 + 20 > width
                  ? "left"
                  : "right";
              },
              labelVisibility: (_attributes, _state, _graphState, graph) =>
                graph.order <= 24 &&
                (container.current?.clientWidth ?? 0) >= 500
                  ? "visible"
                  : "auto",
              labelBackgroundColor: "#f5f2e9",
              labelBackgroundPadding: 4,
              cursor: "grab",
            },
            {
              whenState: "isHighlighted",
              then: {
                labelVisibility: "visible",
                backdropVisibility: "visible",
                backdropColor: "#e7eedf",
                backdropBorderColor: "#668477",
                backdropBorderWidth: 1,
                backdropShadowBlur: 0,
              },
            },
          ],
          edges: [
            DEFAULT_STYLES.edges,
            {
              path: "straight",
              parallelPath: "curved",
              parallelSpread: (attributes) => {
                const sigma = renderer.current;
                if (!sigma) return 0.6;
                const source = sigma.graphToViewport(
                  graph.current.getNodeAttributes(attributes.source) as {
                    x: number;
                    y: number;
                  },
                );
                const target = sigma.graphToViewport(
                  graph.current.getNodeAttributes(attributes.target) as {
                    x: number;
                    y: number;
                  },
                );
                // Short reciprocal edges need room for two labels. Long ones
                // must not bow out beyond the node extent and clip offscreen.
                const length = Math.hypot(
                  source.x - target.x,
                  source.y - target.y,
                );
                return Math.min(1.4, Math.max(0.6, 160 / Math.max(1, length)));
              },
              selfLoopPath: "loop",
              head: "arrow",
              labelColor: "#526459",
              labelSize: 10,
              labelPosition: "auto",
              labelVisibility: (_attributes, _state, _graphState, graph) =>
                graph.order <= 24 &&
                (container.current?.clientWidth ?? 0) >= 500
                  ? "visible"
                  : "auto",
              labelBackgroundColor: "#f5f2e9",
              labelBackgroundPadding: 3,
              cursor: "pointer",
            },
          ],
        },
        settings: {
          autoRescale: "once",
          itemSizesReference: "screen",
          enableNodeDrag: true,
          enableEdgeEvents: true,
          renderEdgeLabels: true,
          nodeLabelEvents: "extend",
          edgeLabelEvents: "extend",
          stagePadding: container.current.clientWidth < 500 ? 90 : 40,
          labelDensity: 0.9,
          minCameraRatio: 0.05,
          maxCameraRatio: 15,
          enableCameraRotation: false,
          gestureTarget: "shared",
        },
      });
      renderer.current = sigma;
      fitGraph(sigma);
      sigma.on("clickNode", ({ node }) =>
        latest.current.select({ kind: "node", id: node }),
      );
      sigma.on("clickEdge", ({ edge }) =>
        latest.current.select(
          edge.startsWith("suggestion:")
            ? { kind: "suggestion", id: edge.slice(11) }
            : { kind: "edge", id: edge },
        ),
      );
      sigma.on("clickStage", () => latest.current.select(null));
      sigma.on("nodeDragStart", (event) => {
        if (latest.current.pending || layout.current?.isRunning()) {
          event.preventSigmaDefault();
          return;
        }
        if (queued.current.size === 0)
          dragRevision.current = latest.current.data.revision;
      });
      sigma.on("nodeDragEnd", ({ node }) => {
        queued.current.set(node, {
          id: node,
          x: graph.current.getNodeAttribute(node, "x"),
          y: graph.current.getNodeAttribute(node, "y"),
          pinned: true,
        });
        if (dragTimer.current) clearTimeout(dragTimer.current);
        dragTimer.current = setTimeout(() => {
          const positions = [...queued.current.values()];
          queued.current.clear();
          void latest.current.save(positions, dragRevision.current);
        }, 500);
      });
      const resize = new ResizeObserver(() => {
        sigma.setSetting(
          "stagePadding",
          (container.current?.clientWidth ?? 0) < 500 ? 90 : 40,
        );
        sigma.resize();
        sigma.refresh();
      });
      resize.observe(container.current);
      return () => {
        resize.disconnect();
        if (dragTimer.current) clearTimeout(dragTimer.current);
        if (layoutTimer.current) clearTimeout(layoutTimer.current);
        layout.current?.kill();
        sigma.kill();
        renderer.current = null;
      };
    } catch (cause) {
      setRenderError(
        cause instanceof Error ? cause.message : "Renderer unavailable",
      );
    }
  }, []);

  useEffect(() => {
    if (layout.current?.isRunning()) {
      layout.current.kill();
      layout.current = null;
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
      setArranging(false);
      latest.current.report(
        "Layout stopped because the graph changed. No positions were overwritten.",
      );
    }
    const wasEmpty = graph.current.order === 0;
    syncGraph(graph.current, props.data);
    // The first capture has no existing mental map. Later live edits must never
    // change the camera, even when they add nodes outside the current viewport.
    if (wasEmpty && graph.current.order > 0 && renderer.current)
      fitGraph(renderer.current);
  }, [props.data]);

  useEffect(() => {
    const sigma = renderer.current;
    if (!sigma) return;
    graph.current.forEachNode((id) =>
      sigma.setNodeState(id, {
        isHighlighted:
          props.selection?.kind === "node" && props.selection.id === id,
        isHidden: props.visible !== null && !props.visible.has(id),
      }),
    );
    graph.current.forEachEdge((id, _attributes, source, target) =>
      sigma.setEdgeState(id, {
        isHighlighted:
          props.selection !== null &&
          (props.selection.kind === "edge"
            ? props.selection.id === id
            : props.selection.kind === "suggestion" &&
              `suggestion:${props.selection.id}` === id),
        isHidden:
          props.visible !== null &&
          (!props.visible.has(source) || !props.visible.has(target)),
      }),
    );
  }, [props.selection, props.visible, props.data]);

  async function saveAll() {
    const positions = graph.current.nodes().map((id) => ({
      id,
      x: graph.current.getNodeAttribute(id, "x") as number,
      y: graph.current.getNodeAttribute(id, "y") as number,
      pinned: graph.current.getNodeAttribute(id, "fixed") === true,
    }));
    if (positions.length > 1000) {
      props.report(
        "Save layout supports 1,000 positions per command. Drag individual nodes to save larger graphs incrementally.",
      );
      return;
    }
    await props.save(positions, props.data.revision);
  }

  function arrange() {
    if (props.data.nodes.length > 1000) {
      props.report(
        "Arrange is limited to 1,000 nodes. Focus a smaller graph and drag nodes individually.",
      );
      return;
    }
    const revision = props.data.revision;
    setArranging(true);
    layout.current?.kill();
    layout.current = new FA2Layout(graph.current, {
      settings: {
        barnesHutOptimize: true,
        gravity: 0.2,
        scalingRatio: 80,
        slowDown: 8,
      },
    });
    layout.current.start();
    layoutTimer.current = setTimeout(() => {
      layout.current?.kill();
      layout.current = null;
      setArranging(false);
      const positions = graph.current
        .nodes()
        .filter((id) => !graph.current.getNodeAttribute(id, "fixed"))
        .map((id) => ({
          id,
          x: graph.current.getNodeAttribute(id, "x") as number,
          y: graph.current.getNodeAttribute(id, "y") as number,
          pinned: false,
        }));
      if (positions.length) void latest.current.save(positions, revision);
      if (renderer.current) fitGraph(renderer.current);
    }, 900);
  }

  const selectedEdge =
    props.selection?.kind === "edge"
      ? props.data.edges.find((edge) => edge.id === props.selection?.id)
      : null;
  return (
    <div className="graph-shell">
      <div
        className="graph-actions"
        role="group"
        aria-label="Graph view controls"
      >
        <button
          aria-label="Zoom in"
          onClick={() => void renderer.current?.getCamera().zoomIn()}
        >
          +
        </button>
        <button
          aria-label="Zoom out"
          onClick={() => void renderer.current?.getCamera().zoomOut()}
        >
          −
        </button>
        <button
          onClick={() => {
            if (renderer.current) fitGraph(renderer.current);
          }}
        >
          Fit graph
        </button>
        <button
          disabled={props.pending || arranging || !props.data.nodes.length}
          onClick={arrange}
        >
          {arranging ? "Arranging…" : "Arrange unpinned"}
        </button>
        <button
          disabled={props.pending || arranging || !props.data.nodes.length}
          onClick={() => void saveAll()}
        >
          Save layout
        </button>
      </div>
      <div className="selection-caption" aria-live="polite">
        {selectedEdge ? (
          <>
            <strong>
              {selectedEdge.correction
                ? "Corrected"
                : selectedEdge.state === "disputed"
                  ? "Disputed"
                  : "Asserted"}
            </strong>{" "}
            ·{" "}
            {
              props.data.nodes.find((node) => node.id === selectedEdge.source)
                ?.title
            }{" "}
            →{" "}
            <strong>
              {
                props.data.taxonomy.relations.find(
                  (relation) => relation.id === selectedEdge.relation,
                )?.label
              }
            </strong>{" "}
            →{" "}
            {
              props.data.nodes.find((node) => node.id === selectedEdge.target)
                ?.title
            }
          </>
        ) : (
          "Select a node or arrow to inspect its context and rationale."
        )}
      </div>
      <div
        ref={container}
        className="graph-canvas"
        role="img"
        aria-label={`Directed intention graph: ${props.data.nodes.length} nodes. Use the node list and relationship inspector for keyboard access.`}
        data-revision={props.data.revision}
      />
      {renderError && (
        <div className="canvas-message" role="alert">
          <h2>Graph renderer unavailable</h2>
          <p>{renderError}</p>
          <p>The node list and inspector remain available.</p>
        </div>
      )}
      {!props.data.nodes.length && !renderError && (
        <div className="canvas-message">
          <p className="eyebrow">A PLACE FOR THE WHOLE TANGLE</p>
          <h2>
            Keep the idea.
            <br />
            Question the dependency.
          </h2>
          <p>
            Capture an intention to begin. Add context and a route back to its
            source; connect it when you are ready.
          </p>
        </div>
      )}
      <div className="graph-legend">
        <span>→ claimed direction</span>
        <span className="blocking-dot">Requires</span>
        <span className="optional-dot">Optional connection</span>
        <span className="suggestion-dot">Suggestion ≠ assertion</span>
      </div>
      <p className="graph-hint">
        Drag to place &amp; pin · scroll to zoom · size and proximity are not
        priority
      </p>
    </div>
  );
}

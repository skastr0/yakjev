import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { MultiDirectedGraph } from "graphology";
import Sigma, { DEFAULT_STYLES } from "sigma";
import {
  extremityArrow,
  layerPlain,
  pathCurved,
  pathLine,
  pathLoop,
} from "sigma/rendering";
import type { Graph } from "@yakjev/protocol";
import { rememberLayout } from "./layout";
import { nodeColor, syncGraph, type Selection } from "./graph-model";

export type Point = { x: number; y: number };
export type CanvasHandle = {
  anchorNode: (id: string) => Point | null;
  anchorBetween: (source: string, target: string) => Point | null;
  fit: () => void;
};

type Props = {
  data: Graph;
  selection: Selection;
  hidden: ReadonlySet<string> | null;
  matches: ReadonlySet<string> | null;
  focusId: string | null;
  onSelect: (selection: Selection) => void;
  onCreate: (at: Point) => void;
  onLink: (source: string, target: string) => void;
  onFocusNode: (id: string) => void;
  onView: () => void;
};

const FRAME = {
  x: [-800, 800] as [number, number],
  y: [-800, 800] as [number, number],
};

export const GraphCanvas = forwardRef<CanvasHandle, Props>(
  function GraphCanvas(props, ref) {
    const container = useRef<HTMLDivElement>(null);
    const graph = useRef(new MultiDirectedGraph());
    const renderer = useRef<Sigma | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const band = useRef<SVGLineElement>(null);
    const link = useRef<{
      source: string;
      x: number;
      y: number;
      moved: boolean;
    } | null>(null);
    const suppressClick = useRef(false);
    const positions = useRef(new Map<string, { x: number; y: number }>());
    const [renderError, setRenderError] = useState("");

    function clientAnchor(id: string): Point | null {
      const sigma = renderer.current;
      const box = container.current?.getBoundingClientRect();
      if (!sigma || !box || !graph.current.hasNode(id)) return null;
      const point = sigma.graphToViewport({
        x: graph.current.getNodeAttribute(id, "x") as number,
        y: graph.current.getNodeAttribute(id, "y") as number,
      });
      return { x: box.left + point.x, y: box.top + point.y };
    }

    function fit() {
      const sigma = renderer.current;
      if (!sigma) return;
      sigma.setCustomBBox(FRAME);
      void sigma.getCamera().reset({ duration: 180 });
    }

    useImperativeHandle(ref, () => ({
      anchorNode: clientAnchor,
      anchorBetween: (source, target) => {
        const from = clientAnchor(source);
        const to = clientAnchor(target);
        if (!from || !to) return null;
        return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      },
      fit,
    }));

    function hideBand() {
      band.current?.setAttribute("visibility", "hidden");
    }

    function hitNode(x: number, y: number) {
      const sigma = renderer.current;
      if (!sigma) return null;
      const best = { id: "", distance: Number.POSITIVE_INFINITY };
      graph.current.forEachNode((id) => {
        const point = sigma.graphToViewport({
          x: graph.current.getNodeAttribute(id, "x") as number,
          y: graph.current.getNodeAttribute(id, "y") as number,
        });
        const size =
          (graph.current.getNodeAttribute(id, "size") as number) || 9;
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance <= size + 14 && distance < best.distance) {
          best.id = id;
          best.distance = distance;
        }
      });
      return best.id || null;
    }

    useEffect(() => {
      if (!container.current) return;
      positions.current = rememberLayout(
        positions.current,
        latest.current.data,
      );
      syncGraph(graph.current, latest.current.data, positions.current);
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
                labelVisibility: (_attributes, _state, _graphState, drawn) =>
                  drawn.order <= 40 ? "visible" : "auto",
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
                },
              },
            ],
            edges: [
              DEFAULT_STYLES.edges,
              {
                size: 1.6,
                labelColor: "#526459",
                labelSize: 11,
                labelVisibility: (_attributes, _state, _graphState, drawn) =>
                  drawn.order <= 40 ? "visible" : "auto",
                labelBackgroundColor: "#f5f2e9",
                labelBackgroundPadding: 3,
                cursor: "pointer",
              },
            ],
          },
          settings: {
            autoRescale: false,
            itemSizesReference: "screen",
            enableNodeDrag: true,
            enableEdgeEvents: true,
            renderEdgeLabels: true,
            nodeLabelEvents: "extend",
            edgeLabelEvents: "extend",
            stagePadding: 48,
            labelDensity: 0.9,
            minCameraRatio: 0.05,
            maxCameraRatio: 8,
            enableCameraRotation: false,
            doubleClickZoomingRatio: 1,
            gestureTarget: "shared",
          },
        });
        renderer.current = sigma;
        sigma.setCustomBBox(FRAME);
        void sigma.getCamera().reset({ duration: 0 });
        let frame = 0;
        sigma.getCamera().on("updated", () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => latest.current.onView());
        });
        sigma.on("clickNode", ({ node }) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          latest.current.onSelect({ kind: "node", id: node });
        });
        sigma.on("clickEdge", ({ edge }) => {
          latest.current.onSelect(
            edge.startsWith("suggestion:")
              ? { kind: "suggestion", id: edge.slice("suggestion:".length) }
              : { kind: "edge", id: edge },
          );
        });
        sigma.on("clickStage", () => latest.current.onSelect(null));
        sigma.on("doubleClickNode", ({ node, event }) => {
          event.preventSigmaDefault();
          latest.current.onFocusNode(node);
        });
        sigma.on("doubleClickStage", ({ event }) => {
          event.preventSigmaDefault();
          const original = event.original;
          if (!(original instanceof MouseEvent)) return;
          latest.current.onCreate({ x: original.clientX, y: original.clientY });
        });
        sigma.on("nodeDragStart", (payload) => {
          const shift =
            payload.event.original instanceof MouseEvent &&
            payload.event.original.shiftKey;
          if (!shift) return;
          payload.preventSigmaDefault();
          link.current = {
            source: payload.node,
            x: payload.event.x,
            y: payload.event.y,
            moved: false,
          };
        });
        sigma.on("nodeDrag", ({ node }) => {
          if (link.current) return;
          positions.current.set(node, {
            x: graph.current.getNodeAttribute(node, "x") as number,
            y: graph.current.getNodeAttribute(node, "y") as number,
          });
        });
        sigma.on("nodeDragEnd", ({ node }) => {
          if (link.current) return;
          positions.current.set(node, {
            x: graph.current.getNodeAttribute(node, "x") as number,
            y: graph.current.getNodeAttribute(node, "y") as number,
          });
        });
        sigma.on("moveBody", ({ event }) => {
          const current = link.current;
          if (!current) return;
          if (Math.hypot(event.x - current.x, event.y - current.y) > 6) {
            current.moved = true;
            event.preventSigmaDefault();
          }
          const line = band.current;
          if (!line || !current.moved) return;
          line.setAttribute("x1", String(current.x));
          line.setAttribute("y1", String(current.y));
          line.setAttribute("x2", String(event.x));
          line.setAttribute("y2", String(event.y));
          line.setAttribute("visibility", "visible");
        });
        const finish = (point: { x: number; y: number }) => {
          const current = link.current;
          link.current = null;
          hideBand();
          if (!current?.moved) return;
          const target = hitNode(point.x, point.y);
          if (!target || target === current.source) return;
          suppressClick.current = true;
          latest.current.onLink(current.source, target);
        };
        sigma.on("upNode", ({ event }) => finish(event));
        sigma.on("upEdge", ({ event }) => finish(event));
        sigma.on("upStage", ({ event }) => finish(event));
        const resize = new ResizeObserver(() => {
          sigma.resize();
          sigma.refresh();
        });
        resize.observe(container.current);
        return () => {
          cancelAnimationFrame(frame);
          resize.disconnect();
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
      const sigma = renderer.current;
      if (!sigma) return;
      graph.current.forEachNode((id) => {
        const dimmed = props.matches !== null && !props.matches.has(id);
        const status = graph.current.getNodeAttribute(id, "status");
        graph.current.setNodeAttribute(
          id,
          "color",
          dimmed ? "#c5ccc0" : nodeColor(status),
        );
        sigma.setNodeState(id, {
          isHighlighted:
            (props.selection?.kind === "node" && props.selection.id === id) ||
            (props.matches?.has(id) ?? false),
          isHidden: props.hidden !== null && !props.hidden.has(id),
        });
      });
      graph.current.forEachEdge((id, _attributes, source, target) =>
        sigma.setEdgeState(id, {
          isHighlighted:
            props.selection !== null &&
            (props.selection.kind === "edge"
              ? props.selection.id === id
              : props.selection.kind === "suggestion" &&
                `suggestion:${props.selection.id}` === id),
          isHidden:
            props.hidden !== null &&
            (!props.hidden.has(source) || !props.hidden.has(target)),
        }),
      );
    }, [props.selection, props.hidden, props.matches, props.data]);

    useEffect(() => {
      const wasEmpty = graph.current.order === 0;
      positions.current = rememberLayout(positions.current, props.data);
      syncGraph(graph.current, props.data, positions.current);
      if (wasEmpty && graph.current.order > 0 && renderer.current) fit();
    }, [props.data]);

    return (
      <div className="graph-shell">
        <div
          ref={container}
          className="graph-canvas"
          role="application"
          aria-label="Intention graph. Double-click to capture. Drag a node to move it. Shift-drag between nodes to connect. Click an arrow to reframe it."
          data-revision={props.data.revision}
        />
        <svg className="link-band" aria-hidden="true">
          <line ref={band} visibility="hidden" />
        </svg>
        <button className="graph-fit" type="button" onClick={fit}>
          Fit
        </button>
        {renderError && (
          <div className="canvas-message" role="alert">
            <h2>Graph renderer unavailable</h2>
            <p>{renderError}</p>
          </div>
        )}
        {!props.data.nodes.length && !renderError && (
          <div className="canvas-message">
            <h2>Capture an intention.</h2>
            <p>
              Double-click the canvas. Drag a node to move it. Shift-drag to
              connect.
            </p>
            <button
              className="primary"
              type="button"
              onClick={() =>
                props.onCreate({
                  x: window.innerWidth / 2,
                  y: window.innerHeight / 2,
                })
              }
            >
              Capture intention
            </button>
          </div>
        )}
        <p className="graph-hint">
          Drag moves · shift-drag connects · double-click captures · click an
          arrow reframes · / finds · ⌘Z undoes
        </p>
      </div>
    );
  },
);

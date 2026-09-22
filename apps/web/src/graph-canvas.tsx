import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
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
import { blendedColors } from "./blend";
import {
  DRAG_REACH,
  idsWithinReach,
  layoutBounds,
  settlePoint,
  syncGraph,
  visibleSettleDistance,
  type Selection,
} from "./graph-model";
import { ASSERTED_DISTANCE, BLOCKING_DISTANCE } from "./layout";
import { backgroundArrivals, type Ghost } from "./jev";

export type Point = { x: number; y: number };
export type CanvasHandle = {
  anchorNode: (id: string) => Point | null;
  anchorBetween: (source: string, target: string) => Point | null;
  fit: () => void;
};

declare global {
  interface Window {
    __yakjevCanvas?: CanvasHandle;
  }
}

type Props = {
  data: Graph;
  selection: Selection;
  hidden: ReadonlySet<string> | null;
  matches: ReadonlySet<string> | null;
  focusId: string | null;
  paint: Readonly<Record<string, string>>;
  ghosts: readonly Ghost[];
  onSelect: (selection: Selection) => void;
  onCreate: (at: Point) => void;
  onLink: (source: string, target: string) => void;
  onDragStart: (id: string, nearby: readonly string[]) => void;
  onDragMove: (id: string, nearby: readonly string[]) => void;
  onDragEnd: (id: string, nearby: readonly string[]) => void;
  onDragCancel: () => void;
  onFocusNode: (id: string) => void;
  onView: () => void;
};

const DRAG_COMMIT_PX = 8;
const ARRIVE_MS = 900;

type Arrival = {
  id: string;
  source: string;
  target: string;
  born: number;
};

export const GraphCanvas = forwardRef<CanvasHandle, Props>(
  function GraphCanvas(props, ref) {
    const shell = useRef<HTMLDivElement>(null);
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
    const dragGesture = useRef<{ x: number; y: number; peak: number } | null>(
      null,
    );
    const dragHome = useRef<Point | null>(null);
    const settleFrame = useRef(0);
    const reachOf = useRef<(id: string) => string[]>(() => []);
    reachOf.current = (focusId: string) => {
      const sigma = renderer.current;
      if (!sigma || !graph.current.hasNode(focusId)) return [];
      const hidden = latest.current.hidden;
      const points: { id: string; x: number; y: number }[] = [];
      graph.current.forEachNode((id) => {
        if (hidden && !hidden.has(id)) return;
        const point = sigma.graphToViewport({
          x: graph.current.getNodeAttribute(id, "x") as number,
          y: graph.current.getNodeAttribute(id, "y") as number,
        });
        points.push({ id, x: point.x, y: point.y });
      });
      return idsWithinReach(focusId, points, DRAG_REACH);
    };
    const [renderError, setRenderError] = useState("");
    const [overlayTick, setOverlayTick] = useState(0);
    const [arrivals, setArrivals] = useState<Arrival[]>([]);
    const seenRevision = useRef<number | null>(null);
    const arrivingRef = useRef(false);
    arrivingRef.current = arrivals.length > 0;
    const reduceMotion = useRef(
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    );

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
      const points = graph.current.nodes().map((id) => ({
        x: graph.current.getNodeAttribute(id, "x") as number,
        y: graph.current.getNodeAttribute(id, "y") as number,
      }));
      const bounds = layoutBounds(points);
      const padX = Math.max(120, (bounds.x[1] - bounds.x[0]) * 0.45);
      const padY = Math.max(120, (bounds.y[1] - bounds.y[0]) * 0.45);
      sigma.setCustomBBox({
        x: [bounds.x[0] - padX, bounds.x[1] + padX],
        y: [bounds.y[0] - padY, bounds.y[1] + padY],
      });
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      void sigma.getCamera().reset({ duration: reduced ? 0 : 180 });
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

    // Acceptance aims a trusted shift-drag at these CSS-pixel anchors.
    // Installed once: the functions read refs, and a later effect would
    // replace a canvas element a test stored on this same property.
    useEffect(() => {
      const hook: CanvasHandle = {
        anchorNode: clientAnchor,
        anchorBetween: (source, target) => {
          const from = clientAnchor(source);
          const to = clientAnchor(target);
          if (!from || !to) return null;
          return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
        },
        fit,
      };
      window.__yakjevCanvas = hook;
      return () => {
        if (window.__yakjevCanvas === hook) delete window.__yakjevCanvas;
      };
    }, []);

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
          (graph.current.getNodeAttribute(id, "size") as number) || 12;
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
      syncGraph(
        graph.current,
        latest.current.data,
        positions.current,
        blendedColors(latest.current.data, latest.current.paint),
      );
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
                size: 12,
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
                opacity: { attribute: "opacity", defaultValue: 1 },
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
                opacity: { attribute: "opacity", defaultValue: 1 },
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
        fit();
        let frame = 0;
        sigma.getCamera().on("updated", () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            latest.current.onView();
            if (latest.current.ghosts.length || arrivingRef.current)
              setOverlayTick((value) => value + 1);
          });
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
        const releaseNode = (focusId: string) => {
          const home = dragHome.current;
          if (!home || !graph.current.hasNode(focusId)) return;
          const focus = {
            x: graph.current.getNodeAttribute(focusId, "x") as number,
            y: graph.current.getNodeAttribute(focusId, "y") as number,
          };
          const taxonomy = latest.current.data.taxonomy;
          let best: {
            x: number;
            y: number;
            distance: number;
            gap: number;
          } | null = null;
          for (const ghost of latest.current.ghosts) {
            if (ghost.kind !== "drag") continue;
            const other = [ghost.from, ghost.to].find(
              (end): end is string =>
                typeof end === "string" && end !== focusId,
            );
            if (!other || !graph.current.hasNode(other)) continue;
            const point = {
              x: graph.current.getNodeAttribute(other, "x") as number,
              y: graph.current.getNodeAttribute(other, "y") as number,
            };
            const gap = Math.hypot(focus.x - point.x, focus.y - point.y);
            if (best && gap >= best.gap) continue;
            const relation = taxonomy.relations.find(
              (item) => item.label === ghost.label,
            );
            best = {
              ...point,
              gap,
              distance: relation?.blocking
                ? BLOCKING_DISTANCE
                : ASSERTED_DISTANCE,
            };
          }
          if (!best) return;
          const sigma = renderer.current;
          let dx = home.x - best.x;
          let dy = home.y - best.y;
          if (Math.hypot(dx, dy) < 1) {
            dx = focus.x - best.x;
            dy = focus.y - best.y;
          }
          const title = String(
            graph.current.getNodeAttribute(focusId, "label") ?? "",
          );
          const viewport = sigma?.graphToViewport(focus);
          const covers =
            dx < 0 &&
            labelSitsRight(
              viewport?.x ?? 0,
              title,
              container.current?.clientWidth ?? 0,
            );
          const distance = visibleSettleDistance(
            best.distance,
            sigma ? pixelsPerUnit(sigma) : 1,
            labelWidthPx(title),
            covers,
          );
          const dest = settlePoint(focus, home, best, distance);
          if (!dest) return;
          cancelAnimationFrame(settleFrame.current);
          const started = performance.now();
          const reduced = reduceMotion.current;
          const step = (now: number) => {
            const sigmaNow = renderer.current;
            if (!sigmaNow || !graph.current.hasNode(focusId)) return;
            const t = reduced ? 1 : Math.min(1, (now - started) / 300);
            const eased = 1 - (1 - t) ** 3;
            const x = focus.x + (dest.x - focus.x) * eased;
            const y = focus.y + (dest.y - focus.y) * eased;
            graph.current.setNodeAttribute(focusId, "x", x);
            graph.current.setNodeAttribute(focusId, "y", y);
            positions.current.set(focusId, { x, y });
            sigmaNow.refresh();
            if (t < 1) settleFrame.current = requestAnimationFrame(step);
          };
          settleFrame.current = requestAnimationFrame(step);
        };
        sigma.on("nodeDragStart", (payload) => {
          const shift =
            payload.event.original instanceof MouseEvent &&
            payload.event.original.shiftKey;
          if (shift) {
            payload.preventSigmaDefault();
            link.current = {
              source: payload.node,
              x: payload.event.x,
              y: payload.event.y,
              moved: false,
            };
            return;
          }
          dragGesture.current = {
            x: payload.event.x,
            y: payload.event.y,
            peak: 0,
          };
          cancelAnimationFrame(settleFrame.current);
          dragHome.current = {
            x: graph.current.getNodeAttribute(payload.node, "x") as number,
            y: graph.current.getNodeAttribute(payload.node, "y") as number,
          };
          latest.current.onDragStart(
            payload.node,
            reachOf.current(payload.node),
          );
        });
        sigma.on("nodeDrag", ({ node, event }) => {
          if (link.current) return;
          suppressClick.current = true;
          const gesture = dragGesture.current;
          if (gesture) {
            gesture.peak = Math.max(
              gesture.peak,
              Math.hypot(event.x - gesture.x, event.y - gesture.y),
            );
          }
          positions.current.set(node, {
            x: graph.current.getNodeAttribute(node, "x") as number,
            y: graph.current.getNodeAttribute(node, "y") as number,
          });
          setOverlayTick((value) => value + 1);
          latest.current.onDragMove(node, reachOf.current(node));
        });
        sigma.on("nodeDragEnd", ({ node }) => {
          if (link.current) return;
          positions.current.set(node, {
            x: graph.current.getNodeAttribute(node, "x") as number,
            y: graph.current.getNodeAttribute(node, "y") as number,
          });
          const nearby = reachOf.current(node);
          const moved = (dragGesture.current?.peak ?? 0) > DRAG_COMMIT_PX;
          dragGesture.current = null;
          if (moved) {
            releaseNode(node);
            latest.current.onDragEnd(node, nearby);
          } else latest.current.onDragCancel();
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
          cancelAnimationFrame(settleFrame.current);
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
      // Fill color is applied with the projection. Writing it here snapped
      // every node back to its status color when a card opened or closed.
      graph.current.forEachNode((id) => {
        const dimmed = props.matches !== null && !props.matches.has(id);
        const opacity = dimmed ? 0.35 : 1;
        if (graph.current.getNodeAttribute(id, "opacity") !== opacity)
          graph.current.setNodeAttribute(id, "opacity", opacity);
        sigma.setNodeState(id, {
          isHighlighted:
            (props.selection?.kind === "node" && props.selection.id === id) ||
            (props.matches?.has(id) ?? false),
          isHidden: props.hidden !== null && !props.hidden.has(id),
        });
      });
      graph.current.forEachEdge((id, _attributes, source, target) => {
        const dimmed =
          props.matches !== null &&
          (!props.matches.has(source) || !props.matches.has(target));
        const opacity = arrivals.some((arrival) => arrival.id === id)
          ? 0
          : dimmed
            ? 0.2
            : 1;
        if (graph.current.getEdgeAttribute(id, "opacity") !== opacity)
          graph.current.setEdgeAttribute(id, "opacity", opacity);
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
        });
      });
    }, [props.selection, props.hidden, props.matches, props.data, arrivals]);

    const seenIds = useRef("");

    function clusterFillsView() {
      const sigma = renderer.current;
      const box = container.current;
      if (!sigma || !box || graph.current.order === 0) return true;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      graph.current.forEachNode((id) => {
        const point = sigma.graphToViewport({
          x: graph.current.getNodeAttribute(id, "x") as number,
          y: graph.current.getNodeAttribute(id, "y") as number,
        });
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
      const width = box.clientWidth;
      const height = box.clientHeight;
      const inside =
        minX > 48 && minY > 48 && maxX < width - 80 && maxY < height - 48;
      const fills = maxX - minX > width * 0.28 || maxY - minY > height * 0.28;
      return inside && fills;
    }

    useEffect(() => {
      const wasEmpty = graph.current.order === 0;
      positions.current = rememberLayout(positions.current, props.data);
      syncGraph(
        graph.current,
        props.data,
        positions.current,
        blendedColors(props.data, props.paint),
      );
      const ids = props.data.nodes
        .map((node) => node.id)
        .sort()
        .join("\n");
      const grew = ids !== seenIds.current;
      seenIds.current = ids;
      renderer.current?.refresh();
      const edgeIds = new Set(props.data.edges.map((edge) => edge.id));
      const since = seenRevision.current;
      seenRevision.current = props.data.revision;
      if (since !== null && !reduceMotion.current) {
        const fresh = backgroundArrivals(props.data, since);
        if (fresh.length) {
          const born = performance.now();
          for (const edge of fresh) {
            if (graph.current.hasEdge(edge.id))
              graph.current.setEdgeAttribute(edge.id, "opacity", 0);
          }
          setArrivals((current) =>
            [
              ...current.filter((arrival) => edgeIds.has(arrival.id)),
              ...fresh.map((edge) => ({
                id: edge.id,
                source: edge.source,
                target: edge.target,
                born,
              })),
            ].slice(-24),
          );
        }
      }
      if (
        renderer.current &&
        ((wasEmpty && graph.current.order > 0) || (grew && !clusterFillsView()))
      )
        fit();
    }, [props.data, props.paint]);

    useEffect(() => {
      if (!arrivals.length) return;
      const oldest = Math.min(...arrivals.map((arrival) => arrival.born));
      const wait = Math.max(0, ARRIVE_MS - (performance.now() - oldest));
      const timer = window.setTimeout(() => {
        const now = performance.now();
        setArrivals((current) =>
          current.filter((arrival) => now - arrival.born < ARRIVE_MS),
        );
      }, wait);
      return () => window.clearTimeout(timer);
    }, [arrivals]);

    const announcement = dragAnnouncement(props.ghosts);

    return (
      <div className="graph-shell" ref={shell}>
        <style>{GHOST_CSS}</style>
        <div
          ref={container}
          className="graph-canvas"
          role="application"
          aria-label="Intention graph. Double-click to capture. Drag a node toward another to connect it. Shift-drag to choose the link."
          data-revision={props.data.revision}
        />
        <svg className="link-band" aria-hidden="true" data-frame={overlayTick}>
          <defs>
            <marker
              id="ghost-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path
                d="M 1 1.5 L 8 5 L 1 8.5"
                fill="none"
                stroke="context-stroke"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>
          {props.ghosts.map((ghost, index) => {
            const strength = clamp01(ghost.strength);
            const from = overlayPoint(ghost.from);
            const to = overlayPoint(ghost.to);
            if (!from || !to) return null;
            const drawn = thread(from, to, strength);
            const width = 1.15 + strength * 1.7;
            const plate = Math.max(36, ghost.label.length * 6.3 + 16);
            const ink = labelInk(ghost.kind, strength);
            return (
              <g
                key={`${ghost.kind}:${endpointKey(ghost.from)}:${ghost.to}:${ghost.label}`}
                className={
                  ghost.kind === "typing" ? "ghost-typing" : "ghost-drag"
                }
              >
                <path
                  className="ghost-glow"
                  d={drawn.d}
                  fill="none"
                  stroke={ink.thread}
                  strokeWidth={width + 5}
                  opacity={0.08 + strength * 0.14}
                />
                <path
                  className="ghost-thread"
                  d={drawn.d}
                  fill="none"
                  stroke={ink.thread}
                  strokeWidth={width}
                  opacity={0.38 + strength * 0.55}
                  markerEnd="url(#ghost-arrow)"
                />
                {!reduceMotion.current && (
                  <path
                    className="ghost-bead"
                    d={drawn.d}
                    fill="none"
                    stroke={ink.bead}
                    pathLength={1}
                    strokeWidth={Math.max(1.4, width - 0.2)}
                    style={{ animationDelay: `${index * 0.14}s` }}
                  />
                )}
                {ghost.label && (
                  <g
                    className="ghost-label"
                    transform={`translate(${drawn.label.x} ${drawn.label.y})`}
                  >
                    <rect
                      x={-plate / 2}
                      y={-9}
                      width={plate}
                      height={18}
                      rx={9}
                      fill="#f5f2e9"
                      stroke={ink.plate}
                      strokeWidth={1}
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#203d35"
                      fontFamily="Georgia, serif"
                      fontStyle="italic"
                      fontSize={11}
                    >
                      {ghost.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {arrivals.map((arrival) => {
            const from = overlayPoint(arrival.source);
            const to = overlayPoint(arrival.target);
            if (!from || !to) return null;
            const d = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
            return (
              <g key={arrival.id} className="jev-arrive">
                <path className="jev-arrive-glow" d={d} pathLength={1} />
                <path className="jev-arrive-draw" d={d} pathLength={1} />
                <circle
                  className="jev-arrive-ring"
                  cx={from.x}
                  cy={from.y}
                  r={14}
                />
                <circle
                  className="jev-arrive-ring"
                  cx={to.x}
                  cy={to.y}
                  r={14}
                />
              </g>
            );
          })}
          <line ref={band} visibility="hidden" />
        </svg>
        {announcement && (
          <p className="ghost-status" role="status" style={DROP_HINT_STYLE}>
            {announcement}
          </p>
        )}
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
              Double-click the canvas. Drag a node toward another and it
              connects on drop. Shift-drag to choose the link.
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
          Drag toward a node to connect · shift-drag chooses the link ·
          double-click captures · click an arrow reframes · / finds · ⌘Z undoes
        </p>
      </div>
    );

    function overlayPoint(end: Ghost["from"]): Point | null {
      const shellBox = shell.current?.getBoundingClientRect();
      if (!shellBox) return null;
      if (typeof end !== "string")
        return { x: end.x - shellBox.left, y: end.y - shellBox.top };
      const sigma = renderer.current;
      if (!sigma || !graph.current.hasNode(end)) return null;
      const viewport = sigma.graphToViewport({
        x: graph.current.getNodeAttribute(end, "x") as number,
        y: graph.current.getNodeAttribute(end, "y") as number,
      });
      const canvas = container.current?.getBoundingClientRect();
      if (!canvas) return null;
      return {
        x: viewport.x + canvas.left - shellBox.left,
        y: viewport.y + canvas.top - shellBox.top,
      };
    }
  },
);

function endpointKey(end: Ghost["from"]) {
  return typeof end === "string"
    ? end
    : `${Math.round(end.x)},${Math.round(end.y)}`;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function labelInk(kind: Ghost["kind"], strength: number) {
  const alpha = (0.35 + strength * 0.5).toFixed(2);
  if (kind === "typing")
    return {
      thread: "#2c84ff",
      bead: "#2c84ff",
      plate: `rgba(44,132,255,${alpha})`,
    };
  return {
    thread: "#284e40",
    bead: "#e35b00",
    plate: `rgba(40,78,64,${alpha})`,
  };
}

const DROP_HINT_STYLE: CSSProperties = {
  position: "absolute",
  top: 14,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 4,
  margin: 0,
  padding: "4px 10px",
  border: "1px solid #c4ccbe",
  borderRadius: 999,
  background: "#f5f2e9",
  color: "#203d35",
  fontSize: 12,
  lineHeight: 1.3,
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

const labelCanvas =
  typeof document === "undefined" ? null : document.createElement("canvas");

function labelWidthPx(label: string) {
  const context = labelCanvas?.getContext("2d");
  if (!context) return label.length * 8;
  context.font = "13px Avenir Next, Avenir, system-ui, sans-serif";
  return context.measureText(label).width;
}

// Same rule as the node style: labels sit to the right unless the screen is
// narrow or the text would run off the right edge.
function labelSitsRight(viewportX: number, label: string, canvasWidth: number) {
  if (canvasWidth < 500) return false;
  return viewportX + label.length * 8 + 20 <= canvasWidth;
}

function pixelsPerUnit(sigma: Sigma) {
  const origin = sigma.graphToViewport({ x: 0, y: 0 });
  const step = sigma.graphToViewport({ x: 1, y: 0 });
  const scale = Math.hypot(step.x - origin.x, step.y - origin.y);
  return scale > 1e-6 ? scale : 1;
}

function dragAnnouncement(ghosts: readonly Ghost[]) {
  const count = ghosts.reduce(
    (total, ghost) => total + (ghost.kind === "drag" ? 1 : 0),
    0,
  );
  if (count === 0) return "";
  return count === 1
    ? "Drop connects 1 intention"
    : `Drop connects ${count} intentions`;
}

// A slight sag so a weak link feels like a thread and a strong one pulls taut.
function thread(from: Point, to: Point, strength: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const sag = 8 + (1 - strength) * 22;
  const cx = (from.x + to.x) / 2 + (-dy / length) * sag;
  const cy = (from.y + to.y) / 2 + (dx / length) * sag;
  return {
    d: `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`,
    label: {
      x: 0.25 * from.x + 0.5 * cx + 0.25 * to.x,
      y: 0.25 * from.y + 0.5 * cy + 0.25 * to.y,
    },
  };
}

const GHOST_CSS = `
.ghost-glow, .ghost-thread, .ghost-bead { fill: none; stroke-linecap: round; }
.ghost-glow, .ghost-thread { stroke: #284e40; }
.ghost-typing .ghost-glow, .ghost-typing .ghost-thread { stroke: #2c84ff; }
.ghost-bead {
  stroke: #e35b00;
  stroke-dasharray: 0.13 0.87;
  animation: ghost-run 1.4s linear infinite;
}
.ghost-typing .ghost-bead {
  stroke: #2c84ff;
  stroke-dasharray: 0.07 0.93;
  animation-duration: 2.2s;
}
.ghost-label rect { fill: #f5f2e9; stroke: #284e4028; }
.ghost-typing .ghost-label rect { stroke: #2c84ff33; }
.ghost-label text {
  font-family: Georgia, serif;
  font-style: italic;
  font-size: 11px;
  fill: #203d35;
}
.ghost-status {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  margin: 0;
  padding: 4px 10px;
  border: 1px solid #c4ccbe;
  border-radius: 999px;
  background: #f5f2e9;
  color: #203d35;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}
.status-dot[data-jev="on"] {
  background: #284e40;
  animation: jev-dot 1.8s ease-in-out infinite;
}
@keyframes ghost-run { to { stroke-dashoffset: -1; } }
@keyframes jev-dot {
  0%, 100% { box-shadow: 0 0 0 0 #54794c00; }
  50% { box-shadow: 0 0 0 4px #54794c55; }
}
.jev-arrive-draw, .jev-arrive-glow {
  fill: none;
  stroke-linecap: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
}
.jev-arrive-draw {
  stroke: #284e40;
  stroke-width: 2.2;
  animation: jev-draw 900ms ease-out forwards;
}
.jev-arrive-glow {
  stroke: #e35b00;
  stroke-width: 9;
  opacity: 0;
  animation: jev-glow 900ms ease-out forwards;
}
.jev-arrive-ring {
  fill: none;
  stroke: #e35b00;
  stroke-width: 2;
  transform-box: fill-box;
  transform-origin: center;
  animation: jev-pulse 900ms ease-out forwards;
}
@keyframes jev-draw { to { stroke-dashoffset: 0; } }
@keyframes jev-glow {
  0% { opacity: 0.2; stroke-dashoffset: 1; }
  45% { opacity: 0.55; }
  100% { opacity: 0; stroke-dashoffset: 0; }
}
@keyframes jev-pulse {
  0% { opacity: 0.75; transform: scale(0.7); }
  100% { opacity: 0; transform: scale(2.6); }
}
@media (prefers-reduced-motion: reduce) {
  .status-dot[data-jev="on"] { animation: none; box-shadow: 0 0 0 3px #54794c55; }
  .jev-arrive-draw { stroke-dashoffset: 0; animation: none; }
  .jev-arrive-glow, .jev-arrive-ring { animation: none; opacity: 0; }
}
`;

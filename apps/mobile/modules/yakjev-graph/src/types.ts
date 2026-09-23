import type { StyleProp, ViewStyle } from "react-native";

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  /** Shared layout coordinates. Positive y points down. */
  readonly x: number;
  readonly y: number;
  readonly color: string;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly color?: string;
  readonly label?: string;
}

export type GraphGhostEdge = Omit<GraphEdge, "id"> & { readonly id?: string };

export interface GraphNodeDragEvent {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly nearbyIds: readonly string[];
  readonly phase: "start" | "move" | "end" | "cancel";
}

export interface YakjevGraphViewProps {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly ghostEdges?: readonly GraphGhostEdge[];
  readonly selectedNodeId?: string;
  readonly selectedEdgeId?: string;
  readonly connectSourceId?: string;
  readonly focusNodeId?: string;
  /** Increment to fit the complete graph; ordinary graph updates preserve the camera. */
  readonly fitRequest?: number;
  readonly interactive?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly onNodePress?: (event: { id: string }) => void;
  readonly onEdgePress?: (event: { id: string }) => void;
  readonly onCanvasPress?: (event: { x: number; y: number }) => void;
  readonly onNodeDrag?: (event: GraphNodeDragEvent) => void;
  readonly onConnect?: (event: { source: string; target: string }) => void;
  readonly onRendererError?: (event: { message: string }) => void;
}

import { requireNativeViewManager } from "expo-modules-core";
import type { ComponentType } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import type { YakjevGraphViewProps } from "./types";

type EventKeys = {
  [K in keyof YakjevGraphViewProps]: K extends `on${string}` ? K : never;
}[keyof YakjevGraphViewProps] &
  keyof YakjevGraphViewProps;
type NativeProps = Omit<YakjevGraphViewProps, EventKeys> & {
  [K in EventKeys]?: (event: {
    nativeEvent: Parameters<NonNullable<YakjevGraphViewProps[K]>>[0];
  }) => void;
};

const NativeView: ComponentType<NativeProps> | null =
  Platform.OS === "ios" ? requireNativeViewManager("YakjevGraph") : null;

/** Native pan/zoom/drag never wait for the JS thread. Drag events are sampled at 10Hz. */
export function YakjevGraphView(props: YakjevGraphViewProps) {
  if (!NativeView) {
    return (
      <View style={[styles.unsupported, props.style]}>
        <Text>
          The native graph is available in the Yakjev iOS development build.
        </Text>
      </View>
    );
  }

  return (
    <NativeView
      {...props}
      ghostEdges={props.ghostEdges ?? []}
      selectedNodeId={props.selectedNodeId ?? ""}
      selectedEdgeId={props.selectedEdgeId ?? ""}
      connectSourceId={props.connectSourceId ?? ""}
      focusNodeId={props.focusNodeId ?? ""}
      fitRequest={props.fitRequest ?? 0}
      interactive={props.interactive ?? true}
      onNodePress={(event) => props.onNodePress?.(event.nativeEvent)}
      onEdgePress={(event) => props.onEdgePress?.(event.nativeEvent)}
      onCanvasPress={(event) => props.onCanvasPress?.(event.nativeEvent)}
      onNodeDrag={(event) => props.onNodeDrag?.(event.nativeEvent)}
      onConnect={(event) => props.onConnect?.(event.nativeEvent)}
      onRendererError={(event) => props.onRendererError?.(event.nativeEvent)}
    />
  );
}

const styles = StyleSheet.create({
  unsupported: { alignItems: "center", justifyContent: "center", padding: 24 },
});

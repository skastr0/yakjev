import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fetch as expoFetch } from "expo/fetch";
import { randomUUID } from "expo-crypto";
import {
  blendedColors,
  connections,
  createClient,
  errorMessage,
  initialPosition,
  jevEdge,
  labelOf,
  paintNode,
  visibleGraph,
  type DraftPreview,
  type YakjevClient,
} from "@yakjev/client";
import type { Graph, PreviewJudgment } from "@yakjev/protocol";
import {
  YakjevGraphView,
  type GraphGhostEdge,
  type GraphNodeDragEvent,
} from "../../modules/yakjev-graph";
import { useSession } from "../state/use-session";
import { useGraph } from "../state/use-graph";
import { useJevPreview } from "../state/use-jev-preview";
import { ConnectScreen } from "./ConnectScreen";
import { ConnectEditor, CreateEditor, EdgeEditor, NodeEditor } from "./editors";
import type { Execute } from "./editors";
import { usePreferences } from "./use-preferences";
import {
  ContextPanel,
  HistoryPanel,
  SearchPanel,
  TaxonomyPanel,
} from "./panels";
import { Button, JevNote, Sheet } from "./primitives";
import { color, styles } from "./theme";

type Mode =
  | { kind: "create"; x: number; y: number }
  | { kind: "node" | "edge"; id: string }
  | { kind: "connect"; source: string; target: string }
  | { kind: "search" | "tools" | "context" | "history" | "taxonomy" };
type Drag = { id: string; nearbyIds: readonly string[] };
const DRAFT_ID = "__yakjev_mobile_draft";

export default function MobileApp() {
  const session = useSession();
  const insets = useSafeAreaInsets();
  const client = useMemo(
    () =>
      session.session
        ? createClient({
            baseUrl: session.session.baseUrl,
            token: session.session.token,
            fetch: expoFetch,
            randomUUID,
          })
        : null,
    [session.session],
  );
  return (
    <View style={[styles.app, { paddingTop: insets.top }]}>
      {client ? (
        <Workspace
          key={session.session!.baseUrl}
          client={client}
          server={session.session!.baseUrl}
          onLock={() => void session.disconnect()}
        />
      ) : (
        <>
          <View
            style={{
              paddingHorizontal: 20,
              paddingVertical: 8,
              borderBottomWidth: 0.5,
              borderColor: color.line,
            }}
          >
            <Text style={styles.brand}>yakjev</Text>
          </View>
          <ConnectScreen
            loading={session.loading}
            error={session.error}
            onConnect={session.connect}
          />
        </>
      )}
    </View>
  );
}

function Workspace({
  client,
  server,
  onLock,
}: {
  client: YakjevClient;
  server: string;
  onLock: () => void;
}) {
  const state = useGraph(client);
  const preferences = usePreferences(server, client);
  const graph = state.graph;
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [archived, setArchived] = useState(false);
  const [fit, setFit] = useState(0);
  const [focus, setFocus] = useState("");
  const [connectSource, setConnectSource] = useState("");
  const [draft, setDraft] = useState<DraftPreview | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const view = useMemo(
    () => (graph ? visibleGraph(graph, archived) : null),
    [graph, archived],
  );
  const seeded = useRef(new Set<string>());
  const fittedInitialLayout = useRef(false);
  const currentClient = useRef(client);
  currentClient.current = client;
  const onRetrySaved = useRef<{
    client: YakjevClient;
    saved: (() => void) | undefined;
  } | null>(null);
  const execute = useCallback<Execute>(
    async (command, onSaved) => {
      if (currentClient.current !== client) return false;
      const attempt = { client, saved: onSaved };
      onRetrySaved.current = attempt;
      const ok = await state.execute(command);
      if (currentClient.current !== client) return false;
      if (ok) {
        if (onRetrySaved.current === attempt) onRetrySaved.current = null;
        onSaved?.();
      }
      return ok;
    },
    [client, state.execute],
  );
  const retry = useCallback(async () => {
    const attempt = onRetrySaved.current;
    if (!(await state.retry())) return;
    if (currentClient.current !== client || attempt?.client !== client) return;
    if (onRetrySaved.current === attempt) onRetrySaved.current = null;
    attempt.saved?.();
  }, [client, state.retry]);
  const busy = state.pending > 0 || state.failedWrite;
  const readGraph = useCallback(
    () => state.getSnapshot().graph,
    [state.getSnapshot],
  );
  const colors = useMemo(() => (view ? blendedColors(view) : null), [view]);
  useEffect(() => {
    if (!graph || !preferences.ready || busy || state.connection !== "live")
      return;
    void preferences.migrateColors(graph, execute, readGraph);
  }, [
    graph,
    preferences.ready,
    preferences.migrateColors,
    busy,
    state.connection,
    execute,
    readGraph,
  ]);
  const placed = useMemo(() => {
    const saved = new Map(
      state.positions.map((position) => [position.id, position]),
    );
    const stable =
      view?.nodes.flatMap(
        (node) =>
          saved.get(node.id) ??
          (node.position ? [{ id: node.id, ...node.position }] : []),
      ) ?? [];
    return (
      view?.nodes.map((node) => ({
        id: node.id,
        ...(saved.get(node.id) ??
          node.position ??
          initialPosition(node.id, stable)),
      })) ?? []
    );
  }, [view?.nodes, state.positions]);
  const positionById = useMemo(
    () => new Map(placed.map((point) => [point.id, point])),
    [placed],
  );

  // The snapshot can arrive before the saved layout. Fit once after both
  // initial reads complete; subsequent reconnects preserve the owner's camera.
  useEffect(() => {
    if (
      fittedInitialLayout.current ||
      state.connection !== "live" ||
      !view?.nodes.length
    )
      return;
    fittedInitialLayout.current = true;
    setFit((value) => value + 1);
  }, [state.connection, view?.nodes.length]);

  // Wait for the layout read to complete before persisting missing positions.
  // Existing web coordinates keep their original scale and position.
  useEffect(() => {
    if (state.connection !== "live" || !view) return;
    const saved = new Set(state.positions.map((point) => point.id));
    const missing = placed.filter(
      (point) => !saved.has(point.id) && !seeded.current.has(point.id),
    );
    if (!missing.length) return;
    for (const point of missing) seeded.current.add(point.id);
    void state.savePositions(missing);
  }, [state.connection, state.positions, placed, view, state.savePositions]);

  const dragInput = useMemo(
    () =>
      preferences.connectWhileDragging && drag && drag.nearbyIds.length
        ? {
            focusNodeId: drag.id,
            includeNodeIds: [...drag.nearbyIds].slice(0, 96),
            only: true,
            purpose: "drag" as const,
          }
        : null,
    [drag, preferences.connectWhileDragging],
  );
  const dragPreview = useJevPreview(client, dragInput, graph?.revision ?? 0);
  const dragJudgments = useMemo(
    () =>
      preferences.connectWhileDragging && view && drag
        ? eligibleDrag(
            drag.id,
            drag.nearbyIds,
            dragPreview.preview?.judgments ?? [],
            view,
          )
        : [],
    [view, drag, dragPreview.preview, preferences.connectWhileDragging],
  );
  const draftJudgments = useMemo(
    () =>
      view && draft?.preview.basedOnRevision === view.revision
        ? connections(draft.preview, view).filter((item) => !item.suppressed)
        : [],
    [view, draft],
  );
  const ghostEdges = useMemo<GraphGhostEdge[]>(() => {
    const ghosts = (focusId: string, judgments: readonly PreviewJudgment[]) =>
      judgments.map((judgment) => ({
        source:
          judgment.direction === "candidate_to_focus"
            ? judgment.nodeId
            : focusId,
        target:
          judgment.direction === "candidate_to_focus"
            ? focusId
            : judgment.nodeId,
        color: color.jev,
        label:
          view && judgment.relation ? labelOf(view, judgment.relation) : "",
      }));
    return [
      ...(mode?.kind === "create" ? ghosts(DRAFT_ID, draftJudgments) : []),
      ...(drag ? ghosts(drag.id, dragJudgments) : []),
    ];
  }, [view, mode?.kind, draftJudgments, drag, dragJudgments]);
  const baseNodes = useMemo(
    () =>
      view?.nodes.map((node) => {
        const point = positionById.get(node.id)!;
        // Sigma's persisted graph y points up; UIKit's drawing y points down.
        return {
          id: node.id,
          label: node.title,
          x: point.x,
          y: -point.y,
          color: colors?.nodes.get(node.id) ?? "#2c84ff",
        };
      }) ?? [],
    [view?.nodes, positionById, colors],
  );
  const renderNodes = useMemo(
    () =>
      mode?.kind === "create" && draftJudgments.length
        ? [
            ...baseNodes,
            {
              id: DRAFT_ID,
              label: draft?.text ?? "",
              x: mode.x,
              y: mode.y,
              color: color.jev,
            },
          ]
        : baseNodes,
    [baseNodes, mode, draft, draftJudgments.length],
  );
  const renderEdges = useMemo(
    () =>
      view?.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        color: colors?.edges.get(edge.id) ?? "#668477",
        label: `${edge.state === "disputed" ? "Disputed · " : ""}${labelOf(view, edge.relation)}`,
      })) ?? [],
    [view, colors],
  );

  const close = useCallback(() => {
    setMode(null);
    setDraft(null);
  }, []);
  const closeEditor = () => {
    if (modeRef.current === mode) close();
  };
  const onDraft = useCallback(
    (value: DraftPreview | null) => setDraft(value),
    [],
  );
  const chooseNode = useCallback((id: string) => {
    if (id === DRAFT_ID) return;
    setFocus("");
    setMode({ kind: "node", id });
  }, []);
  const connect = useCallback(
    ({ source, target }: { source: string; target: string }) => {
      setConnectSource("");
      if (source !== target) setMode({ kind: "connect", source, target });
    },
    [],
  );
  function focusNode(id: string) {
    setFocus("");
    close();
    requestAnimationFrame(() => setFocus(id));
  }
  function create() {
    const x = placed.length
      ? placed.reduce((sum, point) => sum + point.x, 0) / placed.length
      : 0;
    const y = placed.length
      ? -placed.reduce((sum, point) => sum + point.y, 0) / placed.length
      : 0;
    setMode({ kind: "create", x, y });
  }
  function onDrag(event: GraphNodeDragEvent) {
    if (event.phase === "cancel") {
      setDrag(null);
      return;
    }
    if (event.phase === "start" || event.phase === "move") {
      const nearbyIds = [...event.nearbyIds].slice(0, 96).sort();
      setDrag((current) =>
        current?.id === event.id &&
        current.nearbyIds.join("|") === nearbyIds.join("|")
          ? current
          : { id: event.id, nearbyIds },
      );
      return;
    }
    void state.savePositions([{ id: event.id, x: event.x, y: -event.y }]);
    const preview = dragPreview.preview;
    const judgments =
      preferences.connectWhileDragging &&
      view &&
      drag?.id === event.id &&
      preview?.basedOnRevision === view.revision
        ? eligibleDrag(event.id, event.nearbyIds, preview.judgments, view)
        : [];
    setDrag(null);
    if (!preview) return;
    void (async () => {
      for (const judgment of judgments) {
        const edge = jevEdge(event.id, preview, judgment, randomUUID);
        if (edge && !(await state.execute({ type: "edge.put", edge }))) break;
      }
    })();
  }
  async function exportGraph() {
    try {
      const exported = await client.exportGraph();
      await Share.share({
        message: JSON.stringify(exported, null, 2),
        title: "Yakjev graph",
      });
    } catch (cause) {
      setLocalError(errorMessage(cause));
    }
  }
  const currentNode =
    mode?.kind === "node"
      ? view?.nodes.find((node) => node.id === mode.id)
      : null;
  const currentEdge =
    mode?.kind === "edge"
      ? view?.edges.find((edge) => edge.id === mode.id)
      : null;
  const error =
    localError ??
    state.error ??
    preferences.migrationError ??
    preferences.error;
  const connectionText =
    state.connection === "live"
      ? `Live · r${graph?.revision ?? 0}`
      : state.connection === "locked"
        ? "Locked"
        : state.connection === "connecting"
          ? "Connecting…"
          : "Reconnecting…";

  return (
    <View style={styles.app}>
      <View
        style={[
          styles.row,
          {
            paddingHorizontal: 20,
            paddingVertical: 8,
            borderBottomWidth: 0.5,
            borderColor: color.line,
            justifyContent: "space-between",
          },
        ]}
      >
        <Text style={styles.brand}>yakjev</Text>
        <View style={styles.row}>
          <View
            style={{
              height: 5,
              width: 5,
              borderRadius: 3,
              backgroundColor:
                state.connection === "live" ? "#527e45" : "#b27c00",
            }}
          />
          <Text accessibilityLiveRegion="polite" style={styles.note}>
            {connectionText}
          </Text>
          <Button
            quiet
            label="Workspace tools"
            onPress={() => setMode({ kind: "tools" })}
          >
            •••
          </Button>
        </View>
      </View>
      {error && (
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            backgroundColor: "#f8e8df",
          }}
        >
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <View style={styles.wrap}>
            {state.failedWrite && (
              <Button quiet onPress={() => void retry()}>
                Retry save
              </Button>
            )}
            {state.layoutPending && (
              <Button quiet onPress={() => void state.retryLayout()}>
                Retry position
              </Button>
            )}
            {preferences.migrationError && !state.failedWrite && graph && (
              <Button
                quiet
                disabled={busy || state.connection !== "live"}
                onPress={() =>
                  void preferences.retryColors(graph, execute, readGraph)
                }
              >
                Retry colors
              </Button>
            )}
            {state.connection !== "live" && (
              <Button quiet onPress={state.reconnect}>
                Reconnect
              </Button>
            )}
            {state.connection === "locked" && (
              <Button quiet onPress={onLock}>
                Change connection
              </Button>
            )}
            {localError && (
              <Button quiet onPress={() => setLocalError(null)}>
                Dismiss
              </Button>
            )}
          </View>
        </View>
      )}
      <View style={{ flex: 1 }}>
        {view ? (
          <>
            <YakjevGraphView
              testID="yakjev-graph"
              style={{ flex: 1 }}
              nodes={renderNodes}
              edges={renderEdges}
              ghostEdges={ghostEdges}
              selectedNodeId={currentNode?.id ?? ""}
              selectedEdgeId={currentEdge?.id ?? ""}
              focusNodeId={focus}
              connectSourceId={connectSource}
              fitRequest={fit}
              interactive={!busy && !mode}
              onNodePress={({ id }) =>
                connectSource
                  ? connect({ source: connectSource, target: id })
                  : chooseNode(id)
              }
              onEdgePress={({ id }) => setMode({ kind: "edge", id })}
              onCanvasPress={({ x, y }) =>
                connectSource
                  ? setConnectSource("")
                  : setMode({ kind: "create", x, y })
              }
              onNodeDrag={onDrag}
              onConnect={connect}
              onRendererError={({ message }) => setLocalError(message)}
            />
            {view.nodes.length === 0 && (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 32,
                  top: "32%",
                  right: 32,
                }}
              >
                <Text style={[styles.title, { fontSize: 36, lineHeight: 42 }]}>
                  Start with an intention.
                </Text>
                <Text style={[styles.note, { marginTop: 16 }]}>
                  Capture what you want to do. Jev connects the ideas as your
                  graph grows.
                </Text>
              </View>
            )}
            {Platform.OS !== "ios" && (
              <View
                style={{
                  position: "absolute",
                  left: 20,
                  right: 20,
                  top: 24,
                  padding: 20,
                  backgroundColor: color.paper,
                }}
              >
                <Text style={styles.text}>
                  The native graph is available on iOS.
                </Text>
                <Text style={styles.note}>
                  Find and edit your intentions here, or open the graph in the
                  web app.
                </Text>
                <Button onPress={() => setMode({ kind: "search" })}>
                  Find intentions
                </Button>
              </View>
            )}
          </>
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
            }}
          >
            <ActivityIndicator color={color.ink} />
            <Text style={styles.note}>
              {state.connection === "locked"
                ? "Unlock your graph to continue."
                : "Opening your graph…"}
            </Text>
            <Button onPress={onLock} quiet>
              Change connection
            </Button>
          </View>
        )}
      </View>
      {view && (
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 12),
            borderTopWidth: 0.5,
            borderColor: color.line,
            gap: 6,
          }}
        >
          {connectSource ? (
            <View style={[styles.row, { justifyContent: "space-between" }]}>
              <Text style={[styles.note, { flex: 1 }]}>
                Tap an intention to connect.
              </Text>
              <Button quiet onPress={() => setConnectSource("")}>
                Cancel
              </Button>
            </View>
          ) : (
            <>
              {drag && (
                <JevNote
                  loading={dragPreview.loading}
                  text={
                    !preferences.connectWhileDragging
                      ? "Move only · drop to place the intention."
                      : dragPreview.loading
                        ? "Jev is reading nearby intentions…"
                        : dragJudgments.length
                          ? `Drop to connect ${dragJudgments.length} ${dragJudgments.length === 1 ? "intention" : "intentions"}`
                          : (dragPreview.error ??
                            "Move closer to an intention to connect.")
                  }
                />
              )}
              <View style={[styles.row, { justifyContent: "space-between" }]}>
                <Button
                  onPress={() => {
                    setFocus("");
                    setFit((value) => value + 1);
                  }}
                >
                  Fit
                </Button>
                <Button quiet onPress={() => setMode({ kind: "search" })}>
                  Find
                </Button>
                <Button
                  quiet
                  disabled={!state.lastEdit || busy}
                  onPress={() =>
                    state.lastEdit &&
                    void state.execute({
                      type: "undo",
                      revision: state.lastEdit.revision,
                    })
                  }
                >
                  Undo
                </Button>
                <Button primary disabled={busy} onPress={create}>
                  + Intention
                </Button>
              </View>
              {state.notice && !drag && (
                <Text
                  accessibilityLiveRegion="polite"
                  numberOfLines={1}
                  style={styles.note}
                >
                  {state.notice}
                </Text>
              )}
            </>
          )}
        </View>
      )}
      {mode && graph && (
        <Sheet
          title={modeTitle(mode)}
          onClose={close}
          scroll={mode.kind !== "search" && mode.kind !== "history"}
        >
          {state.error && (
            <View style={styles.section}>
              <Text accessibilityRole="alert" style={styles.error}>
                {state.error}
              </Text>
              {state.failedWrite && (
                <Button onPress={() => void retry()}>
                  Retry unconfirmed save
                </Button>
              )}
            </View>
          )}
          {mode.kind === "create" && (
            <CreateEditor
              graph={view ?? graph}
              client={client}
              execute={execute}
              busy={busy}
              onPreview={onDraft}
              onCreated={(id) => {
                void state.savePositions([{ id, x: mode.x, y: -mode.y }]);
                if (modeRef.current === mode) {
                  setFocus(id);
                  close();
                }
              }}
            />
          )}
          {mode.kind === "node" && currentNode && (
            <NodeEditor
              key={currentNode.id}
              node={currentNode}
              graph={graph}
              execute={execute}
              paint={currentNode.color}
              paintReady={!busy && state.connection === "live"}
              onPaint={(hex) => void execute(paintNode(currentNode.id, hex))}
              onClose={closeEditor}
              busy={busy}
              onConnect={() => {
                setConnectSource(currentNode.id);
                close();
              }}
              onFocus={() => focusNode(currentNode.id)}
              onEdge={(id) => setMode({ kind: "edge", id })}
            />
          )}
          {mode.kind === "edge" && currentEdge && (
            <EdgeEditor
              key={currentEdge.id}
              edge={currentEdge}
              graph={graph}
              execute={execute}
              onClose={closeEditor}
              busy={busy}
            />
          )}
          {mode.kind === "connect" && (
            <ConnectEditor
              key={`${mode.source}:${mode.target}`}
              source={mode.source}
              target={mode.target}
              graph={graph}
              client={client}
              execute={execute}
              onClose={closeEditor}
              busy={busy}
            />
          )}
          {mode.kind === "search" && (
            <SearchPanel
              graph={view ?? graph}
              onChoose={(id) => {
                setFocus(id);
                setMode({ kind: "node", id });
              }}
            />
          )}
          {mode.kind === "context" && (
            <ContextPanel
              graph={graph}
              execute={execute}
              onClose={closeEditor}
              busy={busy}
            />
          )}
          {mode.kind === "history" && (
            <>
              <Text style={styles.note}>Latest 100 changes</Text>
              <HistoryPanel client={client} revision={graph.revision} />
            </>
          )}
          {mode.kind === "taxonomy" && (
            <TaxonomyPanel
              graph={graph}
              execute={execute}
              onClose={closeEditor}
              busy={busy}
            />
          )}
          {mode.kind === "tools" && (
            <View style={styles.section}>
              <Text style={styles.note}>
                {graph.nodes.length} intentions · {graph.edges.length}{" "}
                connections
              </Text>
              <Button onPress={() => setMode({ kind: "context" })}>
                Jev context
              </Button>
              <Button
                selected={preferences.connectWhileDragging}
                disabled={!preferences.ready}
                onPress={() =>
                  preferences.setConnectWhileDragging(
                    !preferences.connectWhileDragging,
                  )
                }
              >
                {preferences.connectWhileDragging
                  ? "Connect while dragging · on"
                  : "Connect while dragging · off"}
              </Button>
              <Button
                selected={archived}
                onPress={() => {
                  setArchived((value) => !value);
                  close();
                }}
              >
                {archived
                  ? "Hide archived intentions"
                  : "Show archived intentions"}
              </Button>
              <Button onPress={() => setMode({ kind: "history" })}>
                History
              </Button>
              <Button onPress={() => setMode({ kind: "taxonomy" })}>
                Relationship types
              </Button>
              <Button onPress={() => void exportGraph()}>Export graph</Button>
              <Button quiet onPress={onLock}>
                Lock graph
              </Button>
            </View>
          )}
        </Sheet>
      )}
    </View>
  );
}

function eligibleDrag(
  focus: string,
  nearby: readonly string[],
  judgments: readonly PreviewJudgment[],
  graph: Graph,
) {
  const visible = new Set(graph.nodes.map((node) => node.id));
  const close = new Set(nearby);
  const existing = new Set(
    graph.edges.map((edge) => `${edge.source}\0${edge.target}`),
  );
  return judgments.filter((judgment) => {
    if (
      !judgment.connect ||
      judgment.suppressed ||
      !judgment.relation ||
      !judgment.direction ||
      !close.has(judgment.nodeId) ||
      !visible.has(judgment.nodeId)
    )
      return false;
    const pair =
      judgment.direction === "focus_to_candidate"
        ? `${focus}\0${judgment.nodeId}`
        : `${judgment.nodeId}\0${focus}`;
    return !existing.has(pair);
  });
}

const modeTitle = (mode: Mode) =>
  ({
    create: "Capture intention",
    node: "Intention",
    edge: "Connection",
    connect: "Connect intentions",
    search: "Find",
    tools: "Your graph",
    context: "Jev context",
    history: "History",
    taxonomy: "Relationship types",
  })[mode.kind];

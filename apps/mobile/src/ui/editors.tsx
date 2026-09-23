import { useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import {
  assertEdge,
  captureWithJev,
  connections,
  correctJev,
  JEV_RATIONALE,
  PALETTE,
  jevOrigin,
  labelOf,
  removeEdge,
  removeNode,
  safeSourceHref,
  updateNode,
  unlinkJev,
  type DraftPreview,
  type YakjevClient,
} from "@yakjev/client";
import type { Command, Edge, Graph, Node } from "@yakjev/protocol";
import { useJevPreview } from "../state/use-jev-preview";
import { Button, ChangedElsewhere, Field, JevNote } from "./primitives";
import { color, styles } from "./theme";
import { sameNodeContent } from "./node-content";

export type Execute = (
  command: Command,
  onSaved?: () => void,
) => Promise<boolean>;
type Common = {
  graph: Graph;
  execute: Execute;
  onClose: () => void;
  busy: boolean;
};

export function CreateEditor({
  graph,
  client,
  execute,
  onCreated,
  onPreview,
  busy,
}: Omit<Common, "onClose"> & {
  client: YakjevClient;
  onCreated: (id: string) => void;
  onPreview: (value: DraftPreview | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [paint, setPaint] = useState<string | null>(PALETTE[0].hex);
  const [failure, setFailure] = useState(false);
  const input = useMemo(
    () =>
      title.trim()
        ? { draft: { title: title.trim() }, purpose: "typing" as const }
        : null,
    [title],
  );
  const jev = useJevPreview(client, input, graph.revision);
  const draft = useMemo(
    () => (jev.preview ? { text: title.trim(), preview: jev.preview } : null),
    [title, jev.preview],
  );
  const judgments = connections(jev.preview, graph).filter(
    (item) => !item.suppressed,
  );
  useEffect(() => {
    onPreview(draft);
    return () => onPreview(null);
  }, [draft, onPreview]);
  async function capture() {
    const built = captureWithJev(title, draft, graph, randomUUID);
    if (!built || built.command.type !== "capture") return;
    const command = {
      ...built.command,
      nodes: built.command.nodes.map((node) => ({ ...node, color: paint })),
    };
    const ok = await execute(command, () => onCreated(built.nodeId));
    setFailure(!ok);
  }
  return (
    <View style={styles.section}>
      <Field
        label="Intention"
        placeholder="What do you want to do?"
        autoFocus
        value={title}
        maxLength={240}
        onChangeText={setTitle}
        multiline
        style={{ minHeight: 76, fontSize: 19 }}
      />
      {!!title.trim() && (
        <JevNote
          loading={jev.loading}
          text={
            jev.loading
              ? "Jev is reading…"
              : jev.error || jev.preview?.status === "unavailable"
                ? "Jev is unavailable. You can still capture this intention."
                : jev.preview?.status === "failed"
                  ? "Jev could not read this intention."
                  : judgments.length
                    ? `Jev will connect ${judgments.length} ${judgments.length === 1 ? "intention" : "intentions"}`
                    : jev.preview?.status === "succeeded"
                      ? "Jev sees no connections yet."
                      : "Jev is looking for connections."
          }
        />
      )}
      {judgments.slice(0, 5).map((judgment) => (
        <Text key={judgment.nodeId} style={styles.note}>
          {labelOf(graph, judgment.relation!)} →{" "}
          {graph.nodes.find((node) => node.id === judgment.nodeId)?.title}
        </Text>
      ))}
      <ColorChoices value={paint} onChange={setPaint} disabled={busy} />
      {failure && (
        <Text style={styles.error}>
          Could not save. Check the connection and try again.
        </Text>
      )}
      <Button
        primary
        disabled={!title.trim() || busy}
        onPress={() => void capture()}
      >
        {busy ? "Capturing…" : "Capture intention"}
      </Button>
    </View>
  );
}

export function NodeEditor({
  node,
  graph,
  execute,
  onClose,
  onConnect,
  onFocus,
  onEdge,
  paint,
  onPaint,
  paintReady,
  busy,
}: Common & {
  node: Node;
  onConnect: () => void;
  onFocus: () => void;
  onEdge: (id: string) => void;
  paint: string | null | undefined;
  onPaint: (hex: string | null) => void;
  paintReady: boolean;
}) {
  const [title, setTitle] = useState(node.title);
  const [description, setDescription] = useState(node.description);
  const [project, setProject] = useState(node.project);
  const [status, setStatus] = useState(node.status);
  const [sources, setSources] = useState(
    node.sources.map((source) => ({ ...source })),
  );
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [failure, setFailure] = useState(false);
  const [connectionPage, setConnectionPage] = useState(0);
  const [editedContent, setEditedContent] = useState(node);
  const changedElsewhere = !sameNodeContent(editedContent, node);
  const edges = useMemo(
    () =>
      graph.edges.filter(
        (edge) => edge.source === node.id || edge.target === node.id,
      ),
    [graph.edges, node.id],
  );
  const nodeTitles = useMemo(
    () => new Map(graph.nodes.map((item) => [item.id, item.title])),
    [graph.nodes],
  );
  async function save() {
    if (changedElsewhere) return;
    const command = updateNode(node, {
      title,
      description,
      project,
      status,
      sources,
    });
    if (!command) return;
    const ok = await execute(command, onClose);
    setFailure(!ok);
  }
  return (
    <View style={styles.section}>
      <Field
        label="Title"
        value={title}
        onChangeText={setTitle}
        maxLength={240}
        multiline
        style={{ minHeight: 64, fontSize: 19 }}
      />
      {changedElsewhere && (
        <ChangedElsewhere
          onReload={() => {
            setTitle(node.title);
            setDescription(node.description);
            setProject(node.project);
            setStatus(node.status);
            setSources(node.sources.map((source) => ({ ...source })));
            setEditedContent(node);
            setFailure(false);
          }}
        />
      )}
      <View style={styles.wrap}>
        {(["idea", "active", "done", "archived"] as const).map((value) => (
          <Button
            key={value}
            selected={status === value}
            onPress={() => setStatus(value)}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </Button>
        ))}
      </View>
      <ColorChoices
        value={paint}
        onChange={onPaint}
        disabled={!paintReady || busy}
      />
      <Field
        label="Project"
        value={project}
        onChangeText={setProject}
        maxLength={240}
        placeholder="Optional"
      />
      <Field
        label="Description"
        value={description}
        onChangeText={setDescription}
        maxLength={2000}
        multiline
        placeholder="Details, context, constraints…"
      />
      <View style={styles.row}>
        <Button onPress={onConnect}>Connect to…</Button>
        <Button onPress={onFocus}>Focus on graph</Button>
      </View>
      {edges.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.label}>CONNECTIONS · {edges.length}</Text>
          {edges
            .slice(connectionPage * 20, (connectionPage + 1) * 20)
            .map((edge) => {
              const other = nodeTitles.get(
                edge.source === node.id ? edge.target : edge.source,
              );
              return (
                <Pressable
                  key={edge.id}
                  accessibilityRole="button"
                  onPress={() => onEdge(edge.id)}
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    style={[styles.note, edge.origin && { color: color.jev }]}
                  >
                    {edge.origin ? "Jev · " : ""}
                    {edge.source === node.id ? "→" : "←"}{" "}
                    {labelOf(graph, edge.relation)}
                  </Text>
                  <Text style={styles.text}>{other}</Text>
                </Pressable>
              );
            })}
          {edges.length > 20 && (
            <View style={styles.row}>
              <Button
                disabled={connectionPage === 0}
                onPress={() => setConnectionPage((page) => page - 1)}
              >
                Previous
              </Button>
              <Text style={styles.note}>
                {connectionPage + 1} / {Math.ceil(edges.length / 20)}
              </Text>
              <Button
                disabled={(connectionPage + 1) * 20 >= edges.length}
                onPress={() => setConnectionPage((page) => page + 1)}
              >
                Next
              </Button>
            </View>
          )}
        </View>
      )}
      <View style={styles.divider} />
      <Text style={styles.label}>SOURCES</Text>
      {sources.map((source, index) => (
        <View key={`${index}:${source.uri}`} style={styles.row}>
          <Pressable
            accessibilityRole="link"
            disabled={!safeSourceHref(source.uri)}
            onPress={() => void Linking.openURL(source.uri)}
            style={{ flex: 1, minHeight: 44, justifyContent: "center" }}
          >
            <Text style={styles.text}>{source.label || source.uri}</Text>
          </Pressable>
          <Button
            label={`Remove source ${source.label || index + 1}`}
            quiet
            onPress={() =>
              setSources((items) => items.filter((_, i) => i !== index))
            }
          >
            Remove
          </Button>
        </View>
      ))}
      {sources.length < 40 && (
        <>
          <Field
            label="Source address"
            value={sourceUrl}
            onChangeText={setSourceUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            maxLength={2048}
            placeholder="https://…"
          />
          <Field
            label="Source label"
            value={sourceLabel}
            onChangeText={setSourceLabel}
            maxLength={240}
            placeholder="Optional"
          />
          <Button
            disabled={!sourceUrl.trim()}
            onPress={() => {
              setSources((items) => [
                ...items,
                { uri: sourceUrl.trim(), label: sourceLabel.trim() },
              ]);
              setSourceUrl("");
              setSourceLabel("");
            }}
          >
            Add source
          </Button>
        </>
      )}
      {failure && (
        <Text style={styles.error}>
          Could not save. Check the connection and try again.
        </Text>
      )}
      <Button
        primary
        disabled={!title.trim() || busy || changedElsewhere}
        onPress={() => void save()}
      >
        {busy ? "Saving…" : "Save intention"}
      </Button>
      <Button
        quiet
        disabled={busy}
        onPress={() =>
          Alert.alert(
            "Remove intention?",
            "Its connections will also leave the graph. The journal keeps its history.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Remove",
                style: "destructive",
                onPress: () => void execute(removeNode(node.id), onClose),
              },
            ],
          )
        }
      >
        Remove intention
      </Button>
    </View>
  );
}

export function EdgeEditor({
  edge,
  graph,
  execute,
  onClose,
  busy,
}: Common & { edge: Edge }) {
  const [relation, setRelation] = useState(edge.relation);
  const [rationale, setRationale] = useState(edge.rationale);
  const [disputed, setDisputed] = useState(edge.state === "disputed");
  const [editedRevision, setEditedRevision] = useState(edge.updated.revision);
  const changedElsewhere = editedRevision !== edge.updated.revision;
  const [failure, setFailure] = useState(false);
  async function save() {
    if (changedElsewhere) return;
    const base = edge.origin
      ? correctJev(edge, relation, rationale, graph)
      : {
          type: "edge.reframe" as const,
          id: edge.id,
          relation,
          rationale: rationale.trim() || edge.rationale,
          state: edge.state,
        };
    const ok = await execute(
      {
        ...base,
        state: disputed ? "disputed" : "asserted",
      } as Command,
      onClose,
    );
    setFailure(!ok);
  }
  return (
    <View style={styles.section}>
      <Pair graph={graph} source={edge.source} target={edge.target} />
      {changedElsewhere && (
        <ChangedElsewhere
          onReload={() => {
            setRelation(edge.relation);
            setRationale(edge.rationale);
            setDisputed(edge.state === "disputed");
            setEditedRevision(edge.updated.revision);
            setFailure(false);
          }}
        />
      )}
      {edge.origin && (
        <JevNote
          text={
            edge.correction
              ? "You corrected this connection. Jev learns from your changes."
              : "Connected by Jev. Corrections teach Jev how you think."
          }
        />
      )}
      <RelationChoices graph={graph} value={relation} onChange={setRelation} />
      <Field
        label="Why this connection"
        value={rationale}
        onChangeText={setRationale}
        maxLength={2000}
        multiline
      />
      <Button
        selected={disputed}
        onPress={() => setDisputed((value) => !value)}
      >
        {disputed ? "Disputed" : "Dispute this connection"}
      </Button>
      {failure && (
        <Text style={styles.error}>
          Could not save. Check the connection and try again.
        </Text>
      )}
      <Button
        primary
        disabled={busy || changedElsewhere}
        onPress={() => void save()}
      >
        Save connection
      </Button>
      <Button
        disabled={busy}
        onPress={() =>
          void execute(
            edge.origin ? unlinkJev(edge.id) : removeEdge(edge.id),
            onClose,
          )
        }
      >
        {edge.origin ? "Not related · teach Jev" : "Remove connection"}
      </Button>
    </View>
  );
}

export function ConnectEditor({
  source,
  target,
  graph,
  client,
  execute,
  onClose,
  busy,
}: Common & { source: string; target: string; client: YakjevClient }) {
  const input = useMemo(
    () => ({
      focusNodeId: source,
      includeNodeIds: [target],
      only: true,
      purpose: "link" as const,
    }),
    [source, target],
  );
  const jev = useJevPreview(client, input, graph.revision);
  const judgment = jev.preview?.judgments.find(
    (item) => item.nodeId === target && !item.suppressed && item.relation,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [reversed, setReversed] = useState<boolean | null>(null);
  const [rationale, setRationale] = useState("");
  const [failure, setFailure] = useState(false);
  const flipped = reversed ?? judgment?.direction === "candidate_to_focus";
  const relation = picked ?? judgment?.relation ?? null;
  const from = flipped ? target : source;
  const to = flipped ? source : target;
  async function save() {
    if (!relation) return;
    const built = assertEdge(from, to, relation, rationale, randomUUID);
    const command =
      judgment &&
      jev.preview &&
      relation === judgment.relation &&
      flipped === (judgment.direction === "candidate_to_focus") &&
      !rationale.trim() &&
      built.command.type === "edge.put"
        ? {
            ...built.command,
            edge: {
              ...built.command.edge,
              rationale: JEV_RATIONALE,
              origin: jevOrigin(jev.preview, judgment),
            },
          }
        : built.command;
    const ok = await execute(command, onClose);
    setFailure(!ok);
  }
  return (
    <View style={styles.section}>
      <Pair graph={graph} source={from} target={to} />
      <JevNote
        loading={jev.loading}
        text={
          jev.loading
            ? "Jev is reading the connection…"
            : judgment
              ? `Jev · ${labelOf(graph, judgment.relation!)}`
              : jev.preview?.status === "succeeded"
                ? "Choose how these intentions connect."
                : "Jev is unavailable. Choose the connection yourself."
        }
      />
      <RelationChoices graph={graph} value={relation} onChange={setPicked} />
      <Button onPress={() => setReversed(!flipped)}>⇄ Swap direction</Button>
      <Field
        label="Why this connection"
        value={rationale}
        onChangeText={setRationale}
        maxLength={2000}
        multiline
        placeholder="Optional"
      />
      {failure && (
        <Text style={styles.error}>
          Could not connect. Check the connection and try again.
        </Text>
      )}
      <Button primary disabled={!relation || busy} onPress={() => void save()}>
        Connect
      </Button>
    </View>
  );
}

function ColorChoices({
  value,
  onChange,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (hex: string | null) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.wrap} accessibilityLabel="Intention color">
      <Button
        selected={value == null}
        disabled={disabled}
        label="Use status color"
        onPress={() => onChange(null)}
      >
        Status
      </Button>
      {PALETTE.map((swatch) => (
        <Pressable
          key={swatch.id}
          accessibilityRole="button"
          accessibilityLabel={`${swatch.id} color`}
          accessibilityState={{ selected: value === swatch.hex, disabled }}
          disabled={disabled}
          onPress={() => onChange(swatch.hex)}
          style={{
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 22,
            borderWidth: value === swatch.hex ? 1 : 0,
            borderColor: color.ink,
            opacity: disabled ? 0.4 : 1,
          }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: swatch.hex,
            }}
          />
        </Pressable>
      ))}
    </View>
  );
}

function Pair({
  graph,
  source,
  target,
}: {
  graph: Graph;
  source: string;
  target: string;
}) {
  const title = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.title ?? id;
  return (
    <Text style={[styles.text, { fontSize: 18, lineHeight: 27 }]}>
      {title(source)}
      {"\n"}
      <Text style={{ color: color.muted }}>↓</Text>
      {"\n"}
      {title(target)}
    </Text>
  );
}

function RelationChoices({
  graph,
  value,
  onChange,
}: {
  graph: Graph;
  value: string | null;
  onChange: (relation: string) => void;
}) {
  return (
    <View style={styles.wrap}>
      {graph.taxonomy.relations.map((relation) => (
        <Button
          key={relation.id}
          selected={relation.id === value}
          label={`${relation.label}${relation.blocking ? ", prerequisite" : ""}`}
          onPress={() => onChange(relation.id)}
        >
          {relation.label}
        </Button>
      ))}
    </View>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
} from "react-native";
import {
  addRelation,
  errorMessage,
  searchNodes,
  type YakjevClient,
} from "@yakjev/client";
import type { Graph, HistoryEntry } from "@yakjev/protocol";
import type { Execute } from "./editors";
import { Button, ChangedElsewhere, Field } from "./primitives";
import { color, styles } from "./theme";

export function SearchPanel({
  graph,
  onChoose,
}: {
  graph: Graph;
  onChoose: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () => searchNodes(graph.nodes, query),
    [graph.nodes, query],
  );
  return (
    <View style={{ gap: 12 }}>
      <Field
        label="Find intentions"
        placeholder="Title, project, description…"
        value={query}
        onChangeText={setQuery}
        autoFocus
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <Text style={styles.note}>
        {matches.length} {matches.length === 1 ? "intention" : "intentions"}
      </Text>
      <FlatList
        style={{ height: 320 }}
        data={matches}
        keyExtractor={(node) => node.id}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={5}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => onChoose(item.id)}
            style={{
              paddingVertical: 12,
              borderBottomWidth: 0.5,
              borderColor: color.line,
              minHeight: 52,
            }}
          >
            <Text numberOfLines={2} style={styles.text}>
              {item.title}
            </Text>
            <Text style={styles.note}>
              {[item.project, item.status].filter(Boolean).join(" · ")}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.note}>No matching intentions.</Text>
        }
      />
    </View>
  );
}

export function ContextPanel({
  graph,
  execute,
  onClose,
  busy,
}: {
  graph: Graph;
  execute: Execute;
  onClose: () => void;
  busy: boolean;
}) {
  const [text, setText] = useState(graph.jevContext?.text ?? "");
  const [original, setOriginal] = useState(graph.jevContext?.text ?? "");
  const changedElsewhere = original !== (graph.jevContext?.text ?? "");
  const [failed, setFailed] = useState(false);
  return (
    <View style={styles.section}>
      <Text style={styles.text}>What Jev should always know</Text>
      {changedElsewhere && (
        <ChangedElsewhere
          onReload={() => {
            const latest = graph.jevContext?.text ?? "";
            setText(latest);
            setOriginal(latest);
            setFailed(false);
          }}
        />
      )}
      <Text style={styles.note}>
        Long-term facts and preferences. Jev reads this in every judgment, from
        the first thing you type.
      </Text>
      <Field
        label="Jev context"
        value={text}
        onChangeText={setText}
        multiline
        maxLength={4000}
        style={{ minHeight: 220 }}
        placeholder="Projects, priorities, and how you think about connections…"
      />
      <Text style={styles.note}>{text.length} / 4000</Text>
      {failed && (
        <Text style={styles.error}>
          Could not save this context. Try again.
        </Text>
      )}
      <Button
        primary
        disabled={
          busy || changedElsewhere || text === (graph.jevContext?.text ?? "")
        }
        onPress={() =>
          void execute(
            { type: "jev.context.set", text: text.trim() },
            onClose,
          ).then((ok) => {
            setFailed(!ok);
          })
        }
      >
        Save context
      </Button>
    </View>
  );
}

export function HistoryPanel({
  client,
  revision,
}: {
  client: YakjevClient;
  revision: number;
}) {
  const [entries, setEntries] = useState<readonly HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void client
      .history(Math.max(0, revision - 100), abort.signal)
      .then((items) => {
        if (!abort.signal.aborted) setEntries([...items].reverse());
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(errorMessage(cause));
      });
    return () => abort.abort();
  }, [client, revision]);
  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!entries) return <ActivityIndicator color={color.ink} />;
  return (
    <FlatList
      style={{ height: 420 }}
      data={entries}
      keyExtractor={(entry) => `${entry.revision}:${entry.requestId}`}
      initialNumToRender={14}
      windowSize={5}
      renderItem={({ item }) => (
        <View
          style={{
            paddingVertical: 12,
            borderBottomWidth: 0.5,
            borderColor: color.line,
          }}
        >
          <Text style={styles.text}>
            r{item.revision} · {historyLabel(item)}
          </Text>
          <Text style={styles.note}>
            {item.actor.channel} · {new Date(item.at).toLocaleString()}
          </Text>
          {item.command.type === "capture" && (
            <Text numberOfLines={2} style={styles.note}>
              {item.command.capture.text}
            </Text>
          )}
        </View>
      )}
      ListEmptyComponent={
        <Text style={styles.note}>Your graph’s history will appear here.</Text>
      }
    />
  );
}

const historyLabel = (entry: HistoryEntry) =>
  ({
    capture: "Captured intentions",
    "node.put": "Edited intention",
    "node.remove": "Removed intention",
    "edge.put": "Connected intentions",
    "edge.remove": "Removed connection",
    "edge.reframe": "Reframed connection",
    "jev.context.set": "Updated Jev context",
    "taxonomy.replace": "Updated relationship types",
    undo: "Undid a change",
    "layout.set": "Moved intentions",
  })[entry.type] ?? entry.type;

export function TaxonomyPanel({
  graph,
  execute,
  onClose,
  busy,
}: {
  graph: Graph;
  execute: Execute;
  onClose: () => void;
  busy: boolean;
}) {
  const [relations, setRelations] = useState(
    graph.taxonomy.relations.map((relation) => ({ ...relation })),
  );
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState(relations[0]?.id ?? "");
  const [originalVersion, setOriginalVersion] = useState(
    graph.taxonomy.version,
  );
  const changedElsewhere = originalVersion !== graph.taxonomy.version;
  const [failed, setFailed] = useState(false);
  const current = relations.find((relation) => relation.id === selected);
  function update(
    patch: Partial<{ label: string; definition: string; blocking: boolean }>,
  ) {
    setRelations((items) =>
      items.map((relation) =>
        relation.id === selected ? { ...relation, ...patch } : relation,
      ),
    );
  }
  return (
    <View style={styles.section}>
      <Text style={styles.note}>
        These definitions guide Jev’s connections across every client.
      </Text>
      {changedElsewhere && (
        <ChangedElsewhere
          onReload={() => {
            setRelations(
              graph.taxonomy.relations.map((relation) => ({ ...relation })),
            );
            setOriginalVersion(graph.taxonomy.version);
            setSelected(graph.taxonomy.relations[0]?.id ?? "");
            setFailed(false);
          }}
        />
      )}
      <View style={styles.wrap}>
        {relations.map((relation) => (
          <Button
            key={relation.id}
            selected={selected === relation.id}
            onPress={() => setSelected(relation.id)}
          >
            {relation.label}
          </Button>
        ))}
      </View>
      {current && (
        <>
          <Field
            label="Relationship name"
            value={current.label}
            onChangeText={(value) => update({ label: value })}
            maxLength={240}
          />
          <Field
            label="Definition"
            value={current.definition}
            onChangeText={(value) => update({ definition: value })}
            maxLength={2000}
            multiline
          />
          <Button
            selected={current.blocking}
            onPress={() => update({ blocking: !current.blocking })}
          >
            {current.blocking
              ? "Prerequisite · blocks progress"
              : "Does not block progress"}
          </Button>
        </>
      )}
      {relations.length < 40 && (
        <>
          <View style={styles.divider} />
          <Field
            label="New relationship type"
            value={label}
            onChangeText={setLabel}
            maxLength={240}
            placeholder="Name a connection"
          />
          <Button
            disabled={!label.trim()}
            onPress={() => {
              const command = addRelation(
                { ...graph.taxonomy, relations },
                label,
              );
              if (command.type !== "taxonomy.replace") return;
              setRelations(
                command.relations.map((relation) => ({ ...relation })),
              );
              setSelected(command.relations.at(-1)!.id);
              setLabel("");
            }}
          >
            Add type
          </Button>
        </>
      )}
      {failed && (
        <Text style={styles.error}>
          Could not save relationship types. Try again.
        </Text>
      )}
      <Button
        primary
        disabled={
          busy ||
          changedElsewhere ||
          relations.some((relation) => !relation.label.trim())
        }
        onPress={() =>
          void execute({ type: "taxonomy.replace", relations }, onClose).then(
            (ok) => {
              setFailed(!ok);
            },
          )
        }
      >
        Save relationship types
      </Button>
    </View>
  );
}

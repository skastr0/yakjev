# Agent access

MCP calls server `Store`, `Auth.bearer`, and `discover`. It does not open SQLite. Amp uses tools only, over Streamable HTTP.

Agents without MCP support (e.g. hermes) can use the yakjev CLI instead; see docs/cli.md — same bearer auth and capability surface over /api.

## Tools

- `graph_read`: `graph`, `history`, `search`, `neighborhood`, `export`, `evaluation`, `node`, `edge`.
- `graph_command`: same envelope as `POST /api/commands`.
- `graph_discover`: pure `discover()`. Not semantic search.
- `graph_evaluate`: `Evaluations.evaluate`, the same operation as `POST /api/evaluations`.
- `graph_preview`: `Evaluations.preview`, the same operation as `POST /api/jev/preview`. Jev's read of a draft or node against the graph (relatedness, same intention, relation, direction, connect). Writes nothing; use it to spot an existing restatement before capturing.

Actor is `{ id, channel: "mcp" }` from the bearer. Arguments named `actor`, `user`, `role`, or `channel` are rejected. Evaluation reads use `Store.evaluation`, not the summary on the graph snapshot.

## Commands

Every mutation is one `graph_command` call: `{ requestId, expectedRevision, command }`. Read `revision` from `graph_read` first; a stale `expectedRevision` conflicts without writing. Re-sending an identical requestId replays its original receipt; the same requestId with a changed payload conflicts.

- `capture`: nodes + edges + a capture record, atomically. New nodes only; existing nodes go in `capture.nodeIds`. Jev then connects each new node to related intentions in the background (as actor `jev`); send `autoConnect: false` to skip that.
- `capture.remove`: drop the capture record only. Nodes and edges it created stay, and `history` keeps the original command. A capture also feeds its text into Jev discovery input for every nodeId it names — including ids whose nodes were later removed — so `capture.remove` is what detaches that context.
- `node.put`: create or replace a node. `status: "archived"` retires a node without deleting it.
- `node.remove`: `ids[]` plus optional `removeEdges` and `rationale`. Refuses while incident edges exist — the error lists their ids — unless `removeEdges: true` cascades them away. Cascaded corrected or disputed edges keep their suppression exactly as `edge.remove`'s default does; plain cascaded assertions leave no trace. Pending suggestions on removed endpoints become superseded. Captures keep their `nodeIds` as historical provenance.
- `edge.put`: new directed assertions only; an existing pair must be explicitly reframed.
- `edge.reframe`: correct an existing edge's relation, rationale, or state.
- `edge.remove` on an edge Jev made (it has `origin`) suppresses the pair by default and teaches Jev: the removal is sent to later judgments as an owner correction.
- `edge.remove`: resolve by `id` or by a directed `source` + `target` pair; a mismatched `id`/pair combination and a reverse-only pair fail. `suppress` records the pair as rejected for machine inference: it defaults on for corrected or disputed edges, whose suppression would otherwise die with the edge, and off for plain assertions. Suppression blocks `suggestion.record` in both directions but never an explicit `edge.put`, and it is permanent. Pending suggestions for exactly that pair become superseded.
- `layout.set`: `{ id, x, y, pinned }` positions, or `{ id, clear: true }` to un-place a node.
- `taxonomy.replace`: replace relation definitions; referenced types cannot be dropped.
- `jev.context.set`: `{ text }` (max 4000) replaces the workspace context: long-term facts and preferences Jev reads on every call. Blank text clears it. Stored as `graph.jevContext`.
- `suggestion.record` / `suggestion.decide`: record a machine proposal; explicitly accept or reject it.
- `evaluation.record`: record an evaluation result and its batched suggestions.
- `undo`: reverts only the current revision, so an intervening edit cannot be erased. To remove earlier work, use the remove commands. Undo restores entities as new edits, which supersedes pending suggestions.

Cleaning up a capture: read `history` for the capture's `command.nodes`, then `node.remove` those ids; `capture.remove` drops the record itself. Evaluation records and decided suggestions are permanent provenance and have no remove command.

Removed entities stay in the immutable journal and in `export`: removal is a graph edit, never source deletion.

## Client

```json
{
  "amp.mcpServers": {
    "yakjev": {
      "url": "${YAKJEV_REMOTE_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${YAKJEV_OWNER_TOKEN}"
      }
    }
  }
}
```

Workload-identity JWTs are not the first path. Cookie sessions are not accepted on `/mcp`. Do not put a real token in this file.

# @yakjev/cli

HTTP mirror of the Yakjev MCP tools. Same owner bearer, same reads and commands, sent to `/api`. That path records actor channel `browser`, not `mcp`. Replay still keys on owner id plus `requestId`, so CLI and MCP share one journal.

```sh
bun run packages/cli/src/cli.ts -- <command> [json|@file|-]
```

Config, first hit per field: `--server` / `--token`, then `YAKJEV_REMOTE_URL` (`YAKJEV_URL`) and `YAKJEV_OWNER_TOKEN`, then `~/.config/yakjev/config.json` (`YAKJEV_CONFIG` overrides the path):

```json
{ "remoteUrl": "https://yakjev.example.com", "ownerToken": "..." }
```

Do not commit a real token. Payloads are inline JSON, `@file`, or `-`. `--timeout-ms` defaults to 30000.

| Command | Payload |
| --- | --- |
| `read <view>` | `graph`, `history` `{after?,limit?}`, `search` `{query}`, `neighborhood` `{id,direction?,blocking?}`, `export`, `evaluation` `{id}`, `node` `{id}`, `edge` `{id}` or `{source,target}` |
| `command` | `{requestId?, expectedRevision, command}` — same envelope as `POST /api/commands` |
| `discover` | `{query, focusNodeId?, includeNodeIds?}` — lexical retrieval, not semantic search |
| `evaluate` | `{requestId?, expectedRevision, query, focusNodeId?, includeNodeIds?}` |
| `doctor` | config, `/healthz`, and `/api/session`; exit 0; status in `data.status` |
| `capabilities`, `schema` | the same command and view table |

Success: `{"ok":true,"command":"...","data":...}` on stdout. Failure: `{"ok":false,"command":"yakjev","error":{"type","message","details?"}}` on stderr, exit 1.

Omit `requestId` to mint one. An identical requestId replays its receipt; a changed payload conflicts. Read `revision` before `expectedRevision`. Stale revisions conflict without writing.

`node.remove` refuses incident edges unless `removeEdges: true`. Cascaded corrected or disputed edges stay suppressed; plain assertions do not. `edge.remove` takes `id` or a directed pair. `suppress` defaults on for corrected or disputed edges and off for plain assertions. It blocks machine re-proposal in both directions and still allows `edge.put`. `capture.remove` drops the record only. `undo` reverts only the current revision.

Full examples and removal rules: [docs/cli.md](../../docs/cli.md).

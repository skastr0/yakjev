# CLI

HTTP client for the same graph operations as the MCP tools. It does not open SQLite. Calls go to `/api` with the owner bearer. That path records actor `{ id, channel: "browser" }`. MCP records `channel: "mcp"` for the same owner id. Replay is keyed by owner id and `requestId`, so a CLI retry and an MCP retry share one journal.

Run from the repository:

```sh
bun run packages/cli/src/cli.ts -- <command> [json|@file|-]
```

The `--` keeps Bun from taking flags. `packages/cli` also runs `bun run dev -- <command>`.

## Config

First value wins, per field:

1. `--server` and `--token`
2. `YAKJEV_REMOTE_URL` (`YAKJEV_URL` is the same) and `YAKJEV_OWNER_TOKEN`
3. `~/.config/yakjev/config.json`, or the file in `YAKJEV_CONFIG`

```json
{ "remoteUrl": "https://yakjev.example.com", "ownerToken": "..." }
```

Trailing slashes on the URL are stripped. Empty strings are ignored. A missing file is fine. Invalid JSON in that file fails before the request. Do not commit a real token.

`--timeout-ms` defaults to 30000. `doctor` always uses 10 seconds.

Payloads are inline JSON, `@path`, or `-` for stdin. View and command fields belong in that JSON, not in flags.

`--help` prints this usage as text. `--version` prints a JSON envelope (`0.0.1`).

## Output

Success is one JSON object on stdout:

```json
{ "ok": true, "command": "read graph", "data": {} }
```

`command` is `read <view>`, `command`, `discover`, `evaluate`, `doctor`, `capabilities`, `schema`, or `version`.

Failure is one JSON object on stderr and exit 1:

```json
{
  "ok": false,
  "command": "yakjev",
  "error": {
    "type": "ApiError",
    "message": "Graph revision changed; refresh before editing",
    "details": {
      "error": "Conflict",
      "message": "Graph revision changed; refresh before editing",
      "currentRevision": 4
    }
  }
}
```

`error.type` is `CliConfigError` (no URL or token), `CliInputError` (bad JSON, unknown command or view, bad selector), `ApiError` (HTTP error; `details` is the server body `{ error, message, currentRevision? }`), `TransportError` (request failed), or `SchemaError` (command or evaluate payload rejected locally). A TTY indents; a pipe does not. `details` is omitted when empty.

`doctor` stays on stdout and exit 0. `data.status` is `unconfigured`, `unreachable`, `unauthenticated`, `rejected`, or `ready`. The token is reported as `configured` or `missing`, never printed.

## Reads

`read` views: `graph`, `history`, `search`, `neighborhood`, `export`, `evaluation`, `node`, `edge`. `node` and `edge` are filtered from `GET /api/graph` in the client. The others call their `/api` routes.

```sh
bun run packages/cli/src/cli.ts -- read graph
bun run packages/cli/src/cli.ts -- read history '{"after":0,"limit":20}'
bun run packages/cli/src/cli.ts -- read search '{"query":"inbox"}'
bun run packages/cli/src/cli.ts -- read neighborhood '{"id":"inbox","direction":"both","blocking":true}'
bun run packages/cli/src/cli.ts -- read export
bun run packages/cli/src/cli.ts -- read evaluation '{"id":"eval-1"}'
bun run packages/cli/src/cli.ts -- read node '{"id":"inbox"}'
bun run packages/cli/src/cli.ts -- read edge '{"id":"ab"}'
bun run packages/cli/src/cli.ts -- read edge '{"source":"inbox","target":"delegation"}'
```

`history` defaults to `after: 0`, `limit: 100`. `neighborhood` defaults to `direction: "outgoing"` and `blocking: false`. `search` requires `query`. `evaluation` and `node` require `id`. `edge` requires `id` or a directed `source` and `target`. A mismatched id and pair is `CliInputError`. A reverse-only pair is `NotFound`. Evaluation reads are the full record, not the summary on the graph snapshot.

## Commands

Every mutation is `command` with the same envelope as `POST /api/commands`: `{ requestId, expectedRevision, command }`. Read `revision` from `read graph` first. A stale `expectedRevision` conflicts without writing. Omit `requestId` to mint a new one. Re-sending an identical requestId replays its original receipt. The same requestId with a changed payload conflicts. Extra fields are dropped before the POST. Actor, user, role, and channel cannot be set from the payload.

```sh
bun run packages/cli/src/cli.ts -- command '{"requestId":"capture-inbox-1","expectedRevision":0,"command":{"type":"capture","capture":{"id":"cap-inbox","text":"Claimed chain, not a verified dependency.","sources":[],"nodeIds":["inbox"]},"nodes":[{"id":"inbox","title":"Human-owned inbox","description":"Work that is not yet delegated.","project":"yakjev","status":"idea","sources":[]}],"edges":[]}}'
```

- `capture`: nodes + edges + a capture record, atomically. New nodes only; existing nodes go in `capture.nodeIds`.
- `capture.remove`: drop the capture record only. Nodes and edges it created stay, and `history` keeps the original command. A capture also feeds its text into Jev discovery input for every nodeId it names — including ids whose nodes were later removed — so `capture.remove` is what detaches that context.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":1,"command":{"type":"capture.remove","id":"cap-inbox","rationale":"wrong session"}}'
```

- `node.put`: create or replace a node. `status: "archived"` retires a node without deleting it.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":1,"command":{"type":"node.put","node":{"id":"inbox","title":"Human-owned inbox","description":"Retired from the working set.","project":"yakjev","status":"archived","sources":[]}}}'
```

- `node.remove`: `ids[]` plus optional `removeEdges` and `rationale`. Refuses while incident edges exist — the error lists their ids — unless `removeEdges: true` cascades them away. Cascaded corrected or disputed edges keep their suppression exactly as `edge.remove`'s default does; plain cascaded assertions leave no trace. Pending suggestions on removed endpoints become superseded. Captures keep their `nodeIds` as historical provenance.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":2,"command":{"type":"node.remove","ids":["inbox"],"removeEdges":true,"rationale":"captured in error"}}'
```

- `edge.put`: new directed assertions only; an existing pair must be explicitly reframed.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":2,"command":{"type":"edge.put","edge":{"id":"inbox-requires-delegation","source":"inbox","target":"delegation","relation":"requires","rationale":"Claimed prerequisite, not a verified fact."}}}'
```

- `edge.reframe`: correct an existing edge's relation, rationale, or state.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":3,"command":{"type":"edge.reframe","id":"inbox-requires-delegation","relation":"benefits_from","rationale":"Optional preparation.","state":"disputed"}}'
```

- `edge.remove`: resolve by `id` or by a directed `source` + `target` pair; a mismatched `id`/pair combination and a reverse-only pair fail. `suppress` records the pair as rejected for machine inference: it defaults on for corrected or disputed edges, whose suppression would otherwise die with the edge, and off for plain assertions. Suppression blocks `suggestion.record` in both directions but never an explicit `edge.put`, and it is permanent. Pending suggestions for exactly that pair become superseded.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":4,"command":{"type":"edge.remove","source":"inbox","target":"delegation","suppress":false}}'
```

- `layout.set`: `{ id, x, y, pinned }` positions, or `{ id, clear: true }` to un-place a node.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":4,"command":{"type":"layout.set","positions":[{"id":"inbox","clear":true}]}}'
```

- `taxonomy.replace`: replace relation definitions; referenced types cannot be dropped.
- `suggestion.record` / `suggestion.decide`: record a machine proposal; explicitly accept or reject it.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":5,"command":{"type":"suggestion.decide","id":"s1","decision":"reject","rationale":"Not a prerequisite."}}'
```

- `evaluation.record`: record an evaluation result and its batched suggestions.
- `undo`: reverts only the current revision, so an intervening edit cannot be erased. To remove earlier work, use the remove commands. Undo restores entities as new edits, which supersedes pending suggestions.

```sh
bun run packages/cli/src/cli.ts -- command '{"expectedRevision":6,"command":{"type":"undo","revision":6}}'
```

Cleaning up a capture: read `history` for the capture's `command.nodes`, then `node.remove` those ids; `capture.remove` drops the record itself. Evaluation records and decided suggestions are permanent provenance and have no remove command.

Removed entities stay in the immutable journal and in `export`: removal is a graph edit, never source deletion.

## Discover

Pure `discover()`. Not semantic search. `GET /api/discovery`.

```sh
bun run packages/cli/src/cli.ts -- discover '{"query":"inbox","focusNodeId":"inbox","includeNodeIds":["delegation"]}'
```

## Evaluate

`Evaluations.evaluate`, the same operation as `POST /api/evaluations`. Replay is checked before the provider call. `expectedRevision` is required. Omit `requestId` to mint one.

```sh
bun run packages/cli/src/cli.ts -- evaluate '{"expectedRevision":6,"query":"what does the inbox require?","focusNodeId":"inbox"}'
```

## Doctor and capabilities

```sh
bun run packages/cli/src/cli.ts -- doctor
bun run packages/cli/src/cli.ts -- capabilities
```

`schema` returns the same payload as `capabilities`: read views, command names, and the notes that commands are revision-checked, requestId replay is exact, `node.remove` cascades only with `removeEdges: true`, and `edge.remove` suppress defaults on for corrected or disputed edges.

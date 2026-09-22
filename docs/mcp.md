# Agent access

MCP calls server `Store`, `Auth.bearer`, and `discover`. It does not open SQLite. Amp uses tools only, over Streamable HTTP.

## Tools

- `graph_read`: `graph`, `history`, `search`, `neighborhood`, `export`, `evaluation`.
- `graph_command`: same envelope as `POST /api/commands`.
- `graph_discover`: pure `discover()`. Not semantic search.
- `graph_evaluate`: `Evaluations.evaluate`, the same operation as `POST /api/evaluations`.

Actor is `{ id, channel: "mcp" }` from the bearer. Arguments named `actor`, `user`, `role`, or `channel` are rejected. Evaluation reads use `Store.evaluation`, not the summary on the graph snapshot.

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

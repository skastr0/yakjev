# Agent access

MCP calls the server `Store`, `Auth`, and `discover`. It does not open SQLite and does not apply a second rule engine. Amp uses tools only, over Streamable HTTP.

## Tools

- `graph_read`: `graph`, `history`, `search`, `neighborhood`, `export`, `evaluation`.
- `graph_command`: same envelope as `POST /api/commands`.
- `graph_discover`: pure `discover()`. Not semantic search.
- `graph_evaluate`: will call `Evaluations.evaluate` when that service is mounted. It does not call the provider itself.

Actor is `{ id, channel: "mcp" }` from `Auth.bearer`. Arguments named `actor`, `user`, `role`, or `channel` are rejected.

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

Workload-identity JWTs are not the first path. Cookie sessions are not accepted on `/mcp`.

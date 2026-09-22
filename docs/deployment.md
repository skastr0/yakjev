# Deploying yakjev

Public HTTPS on Railway. The owner token is the lock. There is no private network path.

Keep `YAKJEV_OWNER_TOKEN` only in Railway service secrets. Never put it in Vite, a `VITE_` name, or the page source.

| Piece   | Choice                                                                      |
| ------- | --------------------------------------------------------------------------- |
| Runtime | Bun, `packages/server/src/main.ts`                                          |
| Process | `deploy/entrypoint.sh`                                                      |
| Ingress | Railway service domain → `PORT`                                             |
| Data    | one volume at `/data`                                                       |
| Auth    | `Authorization: Bearer <YAKJEV_OWNER_TOKEN>` and the browser session cookie |

## Railway

1. Dockerfile builder. Leave the start command empty so the image entrypoint runs.
2. Attach one volume at `/data`. One replica. Volumes cannot be used with replicas.
3. Generate a Railway service domain. Do not add a TCP proxy.
4. Set service variables:

| Name                 | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| `YAKJEV_OWNER_TOKEN` | at least 32 random characters                                             |
| `YAKJEV_ORIGIN`      | `https://<generated-domain>` if not inferred from `RAILWAY_PUBLIC_DOMAIN` |
| `TYPESAFE_API_KEY`   | server-side Jev calls; never a `VITE_` name                               |
| `SYNTHETIC_API_KEY`  | semantic retrieval embeddings (Synthetic nomic); absent means lexical     |
| `YAKJEV_DATA_DIR`    | `/data/yakjev`                                                            |
| `YAKJEV_LISTEN_HOST` | `0.0.0.0`                                                                 |

Do not set `YAKJEV_DEV_AUTH` in Railway. The image runs with `NODE_ENV=production`, and the server exits if that flag is set.

`/healthz` is public and returns no graph data. Graph reads, writes, and `/mcp` require the owner token. The browser exchanges that token for an HttpOnly cookie.

## MCP

Endpoint: `https://<generated-domain>/mcp`

```json
{
  "Authorization": "Bearer <YAKJEV_OWNER_TOKEN>"
}
```

## Backup

Railway volume backups include the SQLite file. For a consistent copy, use SQLite `VACUUM INTO` rather than copying a live database file. Restoring a volume restores the graph. There is no separate network identity to restore.

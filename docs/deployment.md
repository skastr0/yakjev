# Deploying yakjev

Yakjev runs on the Mac mini inside the tailnet. The app binds `127.0.0.1:3210`; Tailscale Serve terminates HTTPS for the Tailscale Service `svc:yakjev`. There is no public domain and no Funnel. The owner token is still the lock: tailnet reachability is not application authorization.

Keep the tailnet name out of this public repository. The origin and every secret live in an untracked env file on the mini.

| Piece   | Choice                                                                      |
| ------- | --------------------------------------------------------------------------- |
| Runtime | Bun 1.4.2, `packages/server/src/main.ts`                                    |
| Process | launchd agent `com.skastr0.yakjev` → `deploy/macmini/run.sh`                |
| Ingress | `svc:yakjev` HTTPS 443 → `http://127.0.0.1:3210`, tailnet only              |
| Config  | `~/.config/yakjev/env` (0600)                                               |
| Data    | `~/.yakjev/data/yakjev.sqlite`                                              |
| Logs    | `~/.yakjev/logs/yakjev.{out,err}.log`                                       |
| Backup  | `com.skastr0.yakjev.backup` daily 04:15 → `~/.yakjev/backups`, keeps 14     |
| Auth    | `Authorization: Bearer <YAKJEV_OWNER_TOKEN>` and the browser session cookie |

## Mac mini

1. Check out this repository on the mini. Install Bun 1.4.2 (`mise install bun@1.4.2`), then `bun install --frozen-lockfile && bun run build`.
2. Write `~/.config/yakjev/env` with mode 0600:

   | Name                 | Value                                                                 |
   | -------------------- | --------------------------------------------------------------------- |
   | `YAKJEV_ORIGIN`      | `https://yakjev.<tailnet>.ts.net`, no trailing slash                  |
   | `YAKJEV_OWNER_TOKEN` | at least 32 random characters                                         |
   | `TYPESAFE_API_KEY`   | server-side Jev calls; never a `VITE_` name                           |
   | `SYNTHETIC_API_KEY`  | semantic retrieval embeddings (Synthetic nomic); absent means lexical |

   The runner forces `NODE_ENV=production`, `YAKJEV_LISTEN_HOST=127.0.0.1`, port 3210 and `YAKJEV_DATA_DIR=~/.yakjev/data`. It refuses `YAKJEV_DEV_AUTH`, any `RAILWAY_*` variable, a non-loopback host, and an origin that is not `https://*.ts.net`.

3. `BUN_BIN=<absolute bun 1.4.2 path> deploy/macmini/install.sh` renders and loads two launchd agents: the server and its daily backup. Re-run it after changing the Bun path.
4. Check loopback: `curl -fsS http://127.0.0.1:3210/healthz`.

## Redeploy

On the mini, from the checkout:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run build
launchctl kickstart -k gui/$(id -u)/com.skastr0.yakjev
curl -fsS http://127.0.0.1:3210/healthz
```

The graph lives outside the checkout, so a pull never touches it. The server creates its tables at startup; take a backup first (`deploy/macmini/backup.sh`) when a deploy changes `packages/server/src/store.ts`.

## Tailscale

1. In the admin console, define the service `svc:yakjev` (TCP 443) and let the mini's `tag:mac-mini-server` host it. The name must be free: remove the stale `yakjev` device left over from the old Railway container first.
2. On the mini: `tailscale serve --service=svc:yakjev --https=443 http://127.0.0.1:3210`, then approve the host for the service if the policy does not auto-approve it.
3. Grants must allow the owner's devices, and the tags of authorized orbs, `tcp:443` to `svc:yakjev`. Grants are additive: a wildcard grant makes a narrow one meaningless. Do not enable Funnel.
4. From another tailnet device: `curl -fsS https://yakjev.<tailnet>.ts.net/healthz`.

This repository never changes tailnet policy. Apply grants and service definitions yourself.

## MCP

Endpoint: `https://yakjev.<tailnet>.ts.net/mcp`

```json
{
  "Authorization": "Bearer <YAKJEV_OWNER_TOKEN>"
}
```

The client must be on the tailnet.

## Backup

`deploy/macmini/backup.sh` writes `~/.yakjev/backups/yakjev-<UTC stamp>.sqlite` with SQLite `VACUUM INTO`, which is consistent beside the running server. It checks `PRAGMA integrity_check` on the copy and keeps the newest 14 (`YAKJEV_BACKUP_KEEP`). launchd runs it daily at 04:15, and at the next wake if the mini slept through that time. Never copy the live database file.

The mini is one disk. To keep a copy elsewhere, run `deploy/macmini/pull-backups.sh --install` on another machine with `ssh mac-mini` access. It pulls new backups daily into `~/Backups/yakjev` over SSH, keeps 60, and never writes to the mini.

Restore: `launchctl bootout gui/$(id -u)/com.skastr0.yakjev`, remove `yakjev.sqlite-wal` and `yakjev.sqlite-shm`, copy the backup to `~/.yakjev/data/yakjev.sqlite`, check `PRAGMA integrity_check`, then run `install.sh` again.

## Railway (paused)

The root `Dockerfile` and `deploy/entrypoint.sh` still build the public Railway image. The Railway service is stopped. Its variables were `YAKJEV_OWNER_TOKEN`, `TYPESAFE_API_KEY`, `SYNTHETIC_API_KEY`, `YAKJEV_DATA_DIR=/data/yakjev` and `YAKJEV_LISTEN_HOST=0.0.0.0`, with one volume at `/data`, one replica, and a generated service domain. If you bring it back, restore from a fresh `VACUUM INTO` of the mini first, because the mini now holds the authoritative graph.

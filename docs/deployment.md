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

3. `BUN_BIN=<absolute bun 1.4.2 path> deploy/macmini/install.sh` renders the launchd plist and loads it. Re-run it after changing the Bun path; restart after a deploy with `launchctl kickstart -k gui/$(id -u)/com.skastr0.yakjev`.
4. Check loopback: `curl -fsS http://127.0.0.1:3210/healthz`.

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

Use SQLite `VACUUM INTO` for a consistent copy, never a copy of the live file. Restore by stopping the agent (`launchctl bootout gui/$(id -u)/com.skastr0.yakjev`), placing the copy at `~/.yakjev/data/yakjev.sqlite`, running `PRAGMA integrity_check`, and running `install.sh` again.

## Railway (paused)

The root `Dockerfile` and `deploy/entrypoint.sh` still build the public Railway image. The Railway service is stopped. Its variables were `YAKJEV_OWNER_TOKEN`, `TYPESAFE_API_KEY`, `SYNTHETIC_API_KEY`, `YAKJEV_DATA_DIR=/data/yakjev` and `YAKJEV_LISTEN_HOST=0.0.0.0`, with one volume at `/data`, one replica, and a generated service domain. If you bring it back, restore from a fresh `VACUUM INTO` of the mini first, because the mini now holds the authoritative graph.

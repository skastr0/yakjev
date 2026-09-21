# Deploying yakjev (Tailscale-only on Railway)

This is a scaffold. It does not deploy anything. Production traffic stays on the tailnet: the app binds `127.0.0.1:3210` and Tailscale Serve terminates HTTPS. There is no public Railway domain, no TCP proxy, and no Tailscale Funnel.

Keep `TS_AUTHKEY` only in Railway service secrets. Keep personal tailnet names and origins out of GitHub and CI; authorized orbs receive the remote URL through Amp settings and join via OIDC, as described in [orb access](orbs.md).

## Shape

| Piece           | Where                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| Image           | `deploy/Dockerfile` (Bun 1.3.14 + pinned Tailscale + tini)               |
| Supervisor      | `deploy/entrypoint.sh` (userspace `tailscaled`, Serve, app; fail closed) |
| Railway config  | `railway.json` (Dockerfile builder, 1 replica, no healthcheck path)      |
| App data        | `/data/yakjev` (`YAKJEV_DATA_DIR`)                                       |
| Tailscale state | `/data/tailscale` (`TS_STATE_DIR`)                                       |
| Public origin   | `YAKJEV_ORIGIN=https://<hostname>.<tailnet>.ts.net`                      |

Railway mounts **one** volume at `/data`. Volumes cannot be used with replicas ([Railway volumes reference](https://docs.railway.com/volumes/reference)).

## Manual deploy (operator)

Do this on a machine that already has Railway and Tailscale admin access. Do not apply tailnet policy from CI.

### 1. Repo and Railway project

1. Publish the public GitHub repo (no secrets in git).
2. Create a Railway project and one service from that repo. Builder is Dockerfile; path is `deploy/Dockerfile` (`railway.json`).
3. Attach **one** volume, mount path `/data`. Keep **one replica**.
4. Do **not** click Generate Domain. Do **not** add a TCP proxy. If Railway created a `*.railway.app` domain, delete it before the first successful start. The entrypoint exits if `RAILWAY_PUBLIC_DOMAIN` or `RAILWAY_TCP_PROXY_DOMAIN` is set.
5. Do **not** set `deploy.healthcheckPath` (already `null` in `railway.json`). See [Private health checks](#private-health-checks).

### 2. Tailscale: HTTPS, tags, auth key

1. Enable MagicDNS and HTTPS certificates in the admin console. Enabling HTTPS publishes machine names in Certificate Transparency (public ledger). Use a boring hostname such as `yakjev`. Do not put secrets in the hostname. See [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).
2. Prefer a **stable host tag** you already use for servers (for example `tag:server`). Do not invent a new tag per app unless policy already has one. Define it in `tagOwners` before minting a tagged auth key. See [Tags](https://tailscale.com/docs/features/tags).
3. Generate an auth key: **tagged**, **not ephemeral**, **reusable only if you must re-register**, expiry 1–90 days. Treat reusable keys as passwords. After the node is Running with persisted `/data/tailscale`, you can revoke the key. See [Auth keys](https://tailscale.com/docs/features/access-control/auth-keys).
4. Set Railway **service** variables (not shared git, not orbs):

   | Variable            | Value                                                     |
   | ------------------- | --------------------------------------------------------- |
   | `YAKJEV_ORIGIN`     | `https://<hostname>.<tailnet>.ts.net` (no trailing slash) |
   | `TS_HOSTNAME`       | same `<hostname>` as in `YAKJEV_ORIGIN`                   |
   | `TS_ADVERTISE_TAGS` | `tag:server` (or your existing server tag)                |
   | `TS_AUTHKEY`        | the tagged key (Railway secret / sealed variable)         |
   | `YAKJEV_DATA_DIR`   | `/data/yakjev`                                            |
   | `TS_STATE_DIR`      | `/data/tailscale`                                         |

   After the first successful login, you may remove `TS_AUTHKEY`. Fresh empty state without a key **fails closed**.

### 3. Grants (additive — this is the usual footgun)

Tailscale access rules are **deny-by-default** and **allow-if-any-rule-matches**. Adding a tight grant does **not** revoke a broader one. Personal tailnets often still have the default:

```json
{
  "grants": [{ "src": ["*"], "dst": ["*"], "ip": ["*"] }]
}
```

If that (or `autogroup:member` → `*`) remains, a new `tcp:443` grant to `tag:server` changes nothing. Replace the wildcard; do not append beside it.

Restricted example (illustrative tags only):

```jsonc
{
  "tagOwners": {
    "tag:server": ["autogroup:admin"],
  },
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": ["tag:server"],
      "ip": ["tcp:443"],
    },
  ],
}
```

Narrower still: a group of operators instead of `autogroup:member`. Do not use `"dst": ["*"]` or `"ip": ["*"]` for this host. Do not enable Funnel on the node (`tailscale funnel` / Serve `AllowFunnel`). Serve is tailnet-only ([Serve](https://tailscale.com/docs/features/tailscale-serve)).

This repo does not modify your tailnet. Apply grants yourself in the admin console.

### 4. First start and verify

1. Deploy the service. Watch logs for `yakjev: ready origin=...`.
2. From a tailnet client that is allowed `tcp:443`:
   `curl -fsS "$YAKJEV_ORIGIN/healthz"`.
3. Confirm `tailscale serve status` on the node (Railway exec/logs) shows HTTPS → `http://127.0.0.1:3210` and Funnel off.
4. Confirm no Railway public domain and no TCP proxy.

## Private health checks

The app listens on **loopback only**. Railway healthchecks originate as `healthcheck.railway.app` and use `PORT` ([Healthchecks](https://docs.railway.com/deployments/healthchecks)). They cannot reach `127.0.0.1:3210`, and exposing `PORT` on `0.0.0.0` would fight the Tailscale-only design.

So: **no Railway `healthcheckPath`**. Restart policy is `ON_FAILURE`. The entrypoint exits if `tailscaled` or the app dies, which is what Railway restarts. Volume-backed deploys already have downtime ([volumes + healthchecks](https://docs.railway.com/deployments/healthchecks)).

In-container check: `curl -fsS http://127.0.0.1:3210/healthz` (SQLite-backed). From the tailnet: `GET $YAKJEV_ORIGIN/healthz`.

## Backups and restore

Railway supports volume backups, including SQLite data ([Volume backups](https://docs.railway.com/volumes/backups)). For a known-consistent application backup, use SQLite's Backup API or `VACUUM INTO`; copying a live database file alone can be inconsistent ([SQLite backup](https://sqlite.org/backup.html), [VACUUM INTO](https://sqlite.org/lang_vacuum.html)).

Before a **manual** Railway snapshot you care about:

1. Create a fresh backup with `VACUUM INTO` to a new filename under `/data/yakjev`, or use the Backup API. Alternatively, fully stop all writers before copying the database and its sidecars; a quiet period is not sufficient.
2. Trigger a Railway volume backup, then test restoring the SQLite backup into a disposable database and run `PRAGMA integrity_check`. Scheduled volume backups do not replace restore testing.
3. Wipe volume deletes all Railway backups.

Restore: Railway Backups tab → Restore → review staged volume swap → Deploy. Restores only into the same project + environment. The old volume stays unmounted; do not wipe it until the node is healthy. Tailscale node identity lives under `/data/tailscale`; restoring an old snapshot can resurrect an old node key. After restore, check the machine still shows Running and Serve still points at `127.0.0.1:3210`.

## Auth-key lifecycle

| Phase                               | Action                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| First boot, empty `/data/tailscale` | `TS_AUTHKEY` required or the container exits                                                                |
| Running, state on volume            | Key not required; identity is the state file                                                                |
| Key expires                         | Already-registered node stays until **node** key expiry (tagged devices disable node-key expiry by default) |
| Re-register / lost volume           | Mint a new tagged, non-ephemeral key; do not reuse an ephemeral key                                         |
| Key stolen                          | Revoke in admin console; rotate; treat the node as untrusted until re-auth                                  |
| Ephemeral key                       | Do not use; Railway restarts would drop the node                                                            |

## Amp orbs / CI

`.agents/setup` installs clients without authentication; `.agents/resume` joins with an ephemeral Amp OIDC identity. Authorized orbs use Railway credentials and `YAKJEV_REMOTE_URL` from Amp settings, never the server's `TS_AUTHKEY`. Grant orb access to the deployed host's HTTPS port explicitly. See [orb access](orbs.md). CI only builds and tests; it has no production credentials.

## Pinning

- Bun image: `oven/bun:1.3.14-debian`
- Tailscale: `1.102.4` from `pkgs.tailscale.com/stable` (Debian Trixie)
- Init: Debian `tini` as PID 1

## Official docs used

- https://tailscale.com/docs/concepts/userspace-networking
- https://tailscale.com/docs/reference/tailscaled
- https://tailscale.com/docs/reference/tailscale-cli/up
- https://tailscale.com/docs/reference/tailscale-cli/serve
- https://tailscale.com/docs/features/access-control/auth-keys
- https://tailscale.com/docs/how-to/set-up-https-certificates
- https://tailscale.com/docs/features/tags
- https://docs.railway.com/builds/dockerfiles
- https://docs.railway.com/config-as-code/reference
- https://docs.railway.com/volumes/reference
- https://docs.railway.com/volumes/backups
- https://docs.railway.com/deployments/healthchecks
- https://docs.railway.com/networking/public-networking
- https://sqlite.org/backup.html

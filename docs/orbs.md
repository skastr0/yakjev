# Amp orb access

## Development

Setup installs Bun 1.4.2, dependencies, a web build, GitHub CLI if missing, Railway CLI 5.58.0, and Quasar CLI 0.5.3. Toolchains may be cached. Setup does not authenticate.

`amp orb services ensure` starts a private API on 3210 with `YAKJEV_DEV_AUTH=true` and an Amp-authenticated web portal. The synthetic owner token is `synthetic-yakjev-owner-token-local-only`. The server accepts this mode only with a non-production loopback origin. Production must not set the flag.

## Deployed app

| Setting | Purpose |
| --- | --- |
| `YAKJEV_REMOTE_URL` | Public origin, `https://<service>.up.railway.app` |
| `YAKJEV_OWNER_TOKEN` | Same owner token as the Railway service. Required for MCP writes. |
| `TYPESAFE_API_KEY` | Server-side Jev calls |
| `RAILWAY_API_TOKEN` | Railway CLI |
| `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` | This app's deployment |
| `QUASAR_SERVER_URL` | Session-memory endpoint |

MCP endpoint: `$YAKJEV_REMOTE_URL/mcp` with `Authorization: Bearer $YAKJEV_OWNER_TOKEN`.

Do not put the owner token in Vite or in this repository. Lifecycle hooks do not create projects or deploy.

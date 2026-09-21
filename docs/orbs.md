# Amp orb access

## Development

Setup installs Bun 1.3.14, dependencies, a web build, GitHub CLI if missing, Tailscale, Railway CLI 5.58.0, and Quasar CLI 0.5.3. Toolchains/clients may be cached; login state must not be created in setup. Resume authenticates after the snapshot is activated.

`amp orb services ensure` starts a private API on 3210 and an Amp-authenticated web portal. The Vite proxy keeps browser requests on one origin. Builds and tests need no provider credentials. The checked-in TypeSafe skill is automatically discovered.

## Existing account integration

This follows the established Quasar orb pattern: [Amp project-scoped OIDC](https://ampcode.com/docs/orbs/handling-secrets#tailscale), an ephemeral `tag:amp-orb` node, and the E2B network-availability systemd drop-in. Tokens flow through stdin, not arguments or files. No Tailscale auth key is needed **for orbs**.

Amp personal settings supply credentials; project settings select the app's deployment. These arrive at runtime; public forks must configure their own values:

| Setting                                                              | Purpose                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `TAILSCALE_CLIENT_ID`, `TAILSCALE_AUDIENCE`                          | Existing OIDC registration identifiers (not secrets)                |
| `QUASAR_SERVER_URL`                                                  | HTTPS session-memory endpoint                                       |
| `TYPESAFE_API_KEY`                                                   | Server-side Jev calls, once implemented                             |
| `RAILWAY_API_TOKEN`                                                  | Existing account/workspace credential used by Railway CLI           |
| `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` | Project settings selecting this app's deployment, not another app   |
| `YAKJEV_REMOTE_URL`                                                  | Add to project settings after deployment; bare tailnet HTTPS origin |

Personal secrets override project secrets of the same name. For narrower Railway authority, use a project/environment `RAILWAY_TOKEN`, and explicitly unset `RAILWAY_API_TOKEN` when invoking the CLI. A public repository does not grant contributors the owner's secrets: do not run unreviewed PR code in a credentialed orb. GitHub CI receives none of these credentials.

## The remaining deployment boundary

The Railway node needs its own tagged auth key (or separately configured workload identity). **Do not reuse an orb identity as the persistent server identity.** Store its auth key only in Railway.

OIDC registration permits joining the tailnet; it does not grant access to arbitrary services. Before claiming orb access to the live app, add an approved grant from `tag:amp-orb` to the Yakjev host on `tcp:443`. Prefer an exact host destination if the existing server tag covers unrelated machines. Audit existing broad grants; new grants do not narrow old ones. Tailnet policy edits require operator approval.

Then set `YAKJEV_REMOTE_URL` in Amp project settings. Resume will verify `/healthz` with normal TLS certificate validation. Future remote MCP uses that same HTTPS ingress and requires application authorization before writes are enabled. No MCP server exists in this scaffold.

## Deployment operations

Railway CLI consumes the inherited token without persisting a login. Once the Railway project/service/environment exist, use explicit target IDs for status, logs, and deployments. Do not infer the target from an unrelated parent-directory link. Lifecycle hooks never create projects, deploy, or mutate tailnet policy.

Read-only access checks in a fresh orb. Workspace tokens often reject account queries such as `railway whoami` and `railway project list` while still allowing resource operations against explicit IDs:

```sh
railway status --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT_ID" --json
quasar stats
curl --fail --proto '=https' "$YAKJEV_REMOTE_URL/healthz" # only after deployment
```

After changing Amp settings, refresh through the orb Terminal with `amp orb restart-processes`; this restarts its executor, so do not run it from an active agent merely to test setup. Repeated setup/resume must preserve a connected daemon and avoid duplicated client installations.

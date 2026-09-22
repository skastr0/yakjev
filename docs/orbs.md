# Amp orb access

## Development

Setup installs Bun 1.4.2, dependencies, a web build, GitHub CLI if missing, Tailscale, Railway CLI 5.58.0, and Quasar CLI 0.5.3. Toolchains/clients may be cached; login state must not be created in setup. Resume authenticates after the snapshot is activated.

`amp orb services ensure` starts a private API on 3210 with `YAKJEV_DEV_AUTH=true` and an Amp-authenticated web portal. The synthetic owner token is `synthetic-yakjev-owner-token-local-only`; the server accepts this mode only with a non-production loopback origin. Production must not set the flag. The Vite proxy keeps browser requests on one origin. Builds and tests need no provider credentials. The checked-in TypeSafe skill is automatically discovered.

## Existing account integration

This follows the established Quasar orb pattern: [Amp project-scoped OIDC](https://ampcode.com/docs/orbs/handling-secrets#tailscale), an ephemeral `tag:amp-orb` node, and the E2B network-availability systemd drop-in. Tokens flow through stdin, not arguments or files. No Tailscale auth key is needed **for orbs**.

Amp personal settings supply credentials; project settings select the app's deployment. These arrive at runtime; public forks must configure their own values:

| Setting                                                              | Purpose                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `TAILSCALE_CLIENT_ID`, `TAILSCALE_AUDIENCE`                          | Existing OIDC registration identifiers (not secrets)              |
| `QUASAR_SERVER_URL`                                                  | HTTPS session-memory endpoint                                     |
| `TYPESAFE_API_KEY`                                                   | Server-side Jev calls, once implemented                           |
| `RAILWAY_API_TOKEN`                                                  | Existing account/workspace credential used by Railway CLI         |
| `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` | Project settings selecting this app's deployment, not another app |
| `YAKJEV_REMOTE_URL`                                                  | Deployed app's bare tailnet HTTPS origin, supplied at runtime     |

Personal secrets override project secrets of the same name. For narrower Railway authority, use a project/environment `RAILWAY_TOKEN`, and explicitly unset `RAILWAY_API_TOKEN` when invoking the CLI. A public repository does not grant contributors the owner's secrets: do not run unreviewed PR code in a credentialed orb. GitHub CI receives none of these credentials.

## Enrollment and authorization

The Railway node needs its own tagged auth key (or separately configured workload identity). **Do not reuse an orb identity as the persistent server identity.** Store its auth key only in Railway.

OIDC registration permits joining the tailnet; it does not grant access to arbitrary services. Verify an approved grant from `tag:amp-orb` to the Yakjev host on `tcp:443`; add one only if missing and authorized. Prefer an exact host destination if the existing server tag covers unrelated machines. Audit existing broad grants; new grants do not narrow old ones. Tailnet policy edits require operator approval.

With `YAKJEV_REMOTE_URL` configured, resume probes `/healthz` with normal TLS certificate validation. Future remote MCP uses that same HTTPS ingress and requires application authorization before writes are enabled. No MCP server exists in this scaffold.

## Access from other projects is a product requirement

The owner's other projects must be able to use Yakjev's MCP without cloning this repository or receiving deployment credentials. Shared client configuration must provide enrollment, the endpoint, and application credentials; this repository's lifecycle scripts alone cannot configure unrelated projects. Personal or workspace settings can distribute configuration, but each project's enrollment identity must also satisfy the Tailscale trust policy.

Keep network access narrow to Yakjev HTTPS and preserve project/thread attribution in application operations. Do not distribute Railway credentials or the server's enrollment key to MCP clients. Whether enrollment uses approved project identities or a broader owner/workspace trust rule is a separate access-policy decision, not permission to trust arbitrary Amp projects.

## Known resume failure: stale ephemeral identity

Ephemeral Tailscale nodes can be removed while an orb is paused. A resumed daemon may still report `BackendState=Running` while control requests fail with `PollNetMap: initial fetch failed 404: node not found`. Before this recovery, `.agents/resume` called ordinary `tailscale up`. In Tailscale 1.102.4 that command can return after editing preferences, before exchanging the supplied OIDC token, when the saved state is already Running and tags are unchanged. See the [up implementation](https://github.com/tailscale/tailscale/blob/v1.102.4/cmd/tailscale/cli/up.go#L463-L469) and [early return](https://github.com/tailscale/tailscale/blob/v1.102.4/cmd/tailscale/cli/up.go#L589-L592).

`.agents/resume` treats a registration as current only when `BackendState` is `Running` and `Self.Online` is true. In Tailscale 1.102.4, `Online` is assigned from `health.GetInPollNetMap` ([local.go](https://github.com/tailscale/tailscale/blob/v1.102.4/ipn/ipnlocal/local.go)). A brief wait covers a healthy gap between polls before `--force-reauth`. `tailscale whois` is not used: it only reads the local netmap ([WhoIs](https://github.com/tailscale/tailscale/blob/v1.102.4/client/local/local.go)). After a fresh exchange, resume waits for `Online` and then probes configured Quasar and Yakjev HTTPS endpoints independently. A failed probe is not evidence of a missing grant or a removed node. If neither URL is configured, resume can exit 0 after the poll check alone, so that exit is not end-to-end proof. Do not broaden grants to repair a missing node registration.

The E2B `TS_ASSUME_NETWORK_UP_FOR_TEST` setting is still required. A network-down health warning can remain even with that setting active because E2B's interface is link-local; inspect control-plane errors and actual HTTPS probes rather than diagnosing from that warning alone. See [Amp's Tailscale setup](https://ampcode.com/docs/orbs/handling-secrets#tailscale) and [ephemeral-node lifecycle](https://tailscale.com/docs/features/ephemeral-nodes).

## Deployment operations

Railway CLI consumes the inherited token without persisting a login. Once the Railway project/service/environment exist, use explicit target IDs for status, logs, and deployments. Do not infer the target from an unrelated parent-directory link. Lifecycle hooks never create projects, deploy, or mutate tailnet policy.

Read-only access checks in a fresh orb. Workspace tokens often reject account queries such as `railway whoami` and `railway project list` while still allowing resource operations against explicit IDs:

```sh
railway status --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT_ID" --json
quasar stats
curl --fail --proto '=https' "$YAKJEV_REMOTE_URL/healthz" # only after deployment
```

After changing Amp settings, refresh through the orb Terminal with `amp orb restart-processes`; this restarts its executor, so do not run it from an active agent merely to test setup. Repeated setup/resume must preserve a connected daemon and avoid duplicated client installations.

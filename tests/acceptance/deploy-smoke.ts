#!/usr/bin/env bun
// Read-only deployed-instance smoke. Never writes graph data and never mutates
// deployment state.
//
//   YAKJEV_REMOTE_URL=https://<hostname>.<tailnet>.ts.net bun tests/acceptance/deploy-smoke.ts
//
// Requires a tailnet identity that is allowed tcp:443 to the host. The script
// fails loudly if the environment variable is missing: a silent skip would look
// like a passing release check.
export {};

const remoteOrigin = process.env.YAKJEV_REMOTE_URL;

if (!remoteOrigin) {
  console.error(
    "YAKJEV_REMOTE_URL is not set. This smoke is opt-in; it must not run as a silent pass.",
  );
  process.exit(2);
}
if (!remoteOrigin.startsWith("https://")) {
  console.error("YAKJEV_REMOTE_URL must be an HTTPS origin");
  process.exit(2);
}

const checks: { name: string; ok: boolean; detail: string }[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name} — ${detail}`);
}

async function probe(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${remoteOrigin}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}

// 1. Health over normal TLS validation.
try {
  const response = await probe("/healthz");
  const body = await response.text();
  record(
    "healthz over HTTPS",
    response.ok,
    `${response.status} ${body.slice(0, 120)}`,
  );
} catch (error) {
  record("healthz over HTTPS", false, String(error));
}

// 2. The graph surface must refuse an unauthenticated read. This proves the
//    deployment is not wide open without touching any real data.
try {
  const response = await probe("/api/graph");
  record(
    "unauthenticated /api/graph is refused",
    response.status === 401 || response.status === 403,
    `status ${response.status}`,
  );
} catch (error) {
  record("unauthenticated /api/graph is refused", false, String(error));
}

// 3. An unauthenticated write must be refused and must not be applied.
try {
  const response = await probe("/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "deploy-smoke-unauthorized",
      expectedRevision: 0,
      command: { type: "undo", revision: 0 },
    }),
  });
  record(
    "unauthenticated write is refused",
    response.status === 401 || response.status === 403,
    `status ${response.status}`,
  );
} catch (error) {
  record("unauthenticated write is refused", false, String(error));
}

// 4. The deployment must not serve a public hostname. Checked from the operator
//    side; here we only confirm the configured origin is a tailnet hostname.
record(
  "configured origin looks like a tailnet host",
  /\.ts\.net$/.test(new URL(remoteOrigin).hostname),
  "origin is a tailnet hostname",
);

const failed = checks.filter((check) => !check.ok);
console.log(
  `\n${checks.length - failed.length}/${checks.length} read-only deploy checks passed`,
);
if (failed.length > 0) process.exitCode = 1;

import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL(
  "../scripts/release-testflight-internal.sh",
  import.meta.url,
).pathname;

function fixture(mode: "empty" | "malformed") {
  const dir = mkdtempSync(join(tmpdir(), "yakjev-release-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const asc = join(bin, "asc");
  writeFileSync(
    asc,
    `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
assert args[:2] == ['--profile', 'fixture-profile'], args
args = args[2:]
root = pathlib.Path(os.environ['RELEASE_FIXTURE'])
with (root / 'calls').open('a') as output:
    output.write(json.dumps(args) + '\\n')
key = ' '.join(args[:3])
group = {'id': 'fixture-group', 'attributes': {'name': 'Internal Testers'}}
tester = {'id': 'fixture-tester', 'attributes': {'email': 'tester@example.invalid'}}
if args[0] == 'doctor': result = {}
elif key == 'apps view --id': result = {'data': {'attributes': {'bundleId': 'engineer.castro.yakjev'}}}
elif key == 'builds app view': result = {'data': {'id': '12345'}}
elif key == 'builds wait --build-id': result = {}
elif key == 'testflight groups list':
    if os.environ['RELEASE_FIXTURE_MODE'] == 'malformed': result = {'links': {}}
    else: result = {'data': [group] if (root / 'group').exists() else None, 'links': {}}
elif key == 'testflight groups create':
    (root / 'group').touch()
    result = {'data': group}
elif key == 'builds add-groups --build-id': result = {}
elif key == 'testflight testers list':
    result = {'data': [tester] if (root / 'invited').exists() else None, 'links': {}}
elif key == 'testflight testers invite':
    assert '--group' in args
    (root / 'invited').touch()
    result = {}
elif key == 'builds build-beta-detail view': result = {}
else: raise AssertionError('Unexpected release operation: ' + str(args))
print(json.dumps(result))
`,
  );
  chmodSync(asc, 0o755);
  const config = join(dir, "release.env");
  // Always override the config path; tests must never read operator credentials.
  writeFileSync(
    config,
    "ASC_PROFILE=fixture-profile\nINVITE_EMAIL=tester@example.invalid\n",
  );
  return {
    run: (...extra: string[]) =>
      Bun.spawnSync(
        [
          "bash",
          script,
          "--app-id",
          "12345",
          "--distribute-build",
          "fixture-build",
          ...extra,
        ],
        {
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            YAKJEV_RELEASE_ENV_FILE: config,
            RELEASE_FIXTURE: dir,
            RELEASE_FIXTURE_MODE: mode,
            ARTIFACTS_DIR: join(dir, "artifacts"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    calls: () =>
      readFileSync(join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    removeEmail: () => writeFileSync(config, "ASC_PROFILE=fixture-profile\n"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("release accepts ASC data:null empty collections and invites the new tester", () => {
  const local = fixture("empty");
  try {
    const result = local.run();
    expect(result.stderr.toString()).not.toContain("error:");
    expect(result.exitCode).toBe(0);
    const calls = local.calls();
    expect(
      calls.some(
        (args) => args.slice(0, 3).join(" ") === "testflight groups create",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) => args.slice(0, 3).join(" ") === "testflight testers invite",
      ),
    ).toBe(true);
    expect(
      calls.some((args) => args.slice(0, 2).join(" ") === "builds upload"),
    ).toBe(false);
  } finally {
    local.close();
  }
});

test("release fails malformed collection responses instead of treating them as empty", () => {
  const local = fixture("malformed");
  try {
    const result = local.run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Malformed ASC list response");
    expect(
      local
        .calls()
        .some((args) => args.includes("create") || args.includes("invite")),
    ).toBe(false);
  } finally {
    local.close();
  }
});

test("distribution without invitations needs no signing settings or tester email", () => {
  const local = fixture("empty");
  try {
    local.removeEmail();
    const result = local.run("--no-invite");
    expect(result.exitCode).toBe(0);
    expect(local.calls().some((args) => args.includes("testers"))).toBe(false);
  } finally {
    local.close();
  }
});

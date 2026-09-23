import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackage, getRawHeader } from "@electron/asar";
import { FuseState, FuseV1Options, FuseVersion } from "@electron/fuses";
import { auditAsar, validatePackagedFile } from "../scripts/audit-package.mjs";
import {
  packagePolicy,
  validateEntitlements,
  validateFuseWire,
} from "../scripts/package-policy.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yakjev-package-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  const entries = {
    "package.json": JSON.stringify({
      name: "@yakjev/desktop",
      main: "out/main/index.js",
    }),
    "out/main/index.js": "console.log('main');",
    "out/preload/index.js": "console.log('preload');",
    "out/renderer/index.html": '<script src="./assets/app.js"></script>',
    "out/renderer/assets/app.js": "console.log('renderer');",
    "out/connection/index.html": "<p>Connect</p>",
  };
  for (const [name, contents] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), contents);
  }
  const archive = path.join(root, "app.asar");
  await createPackage(source, archive);
  const hash = createHash("sha256")
    .update(getRawHeader(archive).headerString)
    .digest("hex");
  return {
    archive,
    plist: {
      ElectronAsarIntegrity: {
        "Resources/app.asar": { algorithm: "SHA256", hash },
      },
    },
  };
};

test("audits compiled entries and hashes actual ASAR payloads", async () => {
  const { archive, plist } = await fixture();
  expect(auditAsar(archive, plist).files).toBe(6);
  const bytes = await readFile(archive);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(archive, bytes);
  expect(() => auditAsar(archive, plist)).toThrow(
    "ASAR payload integrity mismatch",
  );
});

test("requires embedded integrity to match this archive", async () => {
  const { archive } = await fixture();
  expect(() => auditAsar(archive, {})).toThrow("Embedded ASAR integrity");
});

test.each([
  "out/main/index.js.map",
  "out/main/.env.production",
  "out/main/auth.p8",
  "out/main/source.ts",
  "out/main/node_modules/secret/index.js",
  "out/main/notarization-receipt.json",
  "src/main/index.js",
  "out/main/../../private.json",
])("rejects unexpected package content %s", (name) => {
  expect(() => validatePackagedFile(name, Buffer.from("fixture"))).toThrow(
    "Unexpected packaged file",
  );
});

test.each([
  "const path = '/Users/example/Projects/yakjev';",
  "const path = '/home/example/yakjev';",
  "-----BEGIN PRIVATE KEY-----",
  "console.log('ok');\n//# sourceMappingURL=index.js.map",
])("rejects private build data in compiled payload %s", (contents) => {
  expect(() =>
    validatePackagedFile("out/main/index.js", Buffer.from(contents)),
  ).toThrow("Private build data");
});

test("allows only JIT on known Electron executables and empty entitlements on libraries", () => {
  validateEntitlements(
    { "com.apple.security.cs.allow-jit": true },
    "Contents/MacOS/Yakjev",
  );
  validateEntitlements(
    {},
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  );
  expect(() =>
    validateEntitlements(
      { "com.apple.security.cs.allow-jit": true },
      "Contents/Frameworks/unexpected.dylib",
    ),
  ).toThrow("Unexpected signed entitlements");
  expect(() =>
    validateEntitlements(
      {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.device.audio-input": true,
      },
      "Contents/MacOS/Yakjev",
    ),
  ).toThrow("Unexpected signed entitlements");
  expect(() => validateEntitlements({}, "Contents/MacOS/Yakjev")).toThrow(
    "Unexpected signed entitlements",
  );
});

test("requires all known fuses and rejects a mutated runtime permission", () => {
  const wire = { version: FuseVersion.V1 };
  for (const [name, value] of Object.entries(packagePolicy.fuses))
    wire[FuseV1Options[name]] = value ? FuseState.ENABLE : FuseState.DISABLE;
  validateFuseWire(wire);
  expect(() =>
    validateFuseWire({ ...wire, [FuseV1Options.RunAsNode]: FuseState.ENABLE }),
  ).toThrow("fuse mismatch");
  expect(() => validateFuseWire({ ...wire, 99: FuseState.DISABLE })).toThrow(
    "complete known set",
  );
});

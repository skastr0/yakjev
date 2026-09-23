import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPackage } from "./audit-package.mjs";
import { notarizeApp, notarizeDmg } from "./notarize.mjs";
import { buildEnvironment, signingConfig } from "./signing-config.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(desktop, "../..");
const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--sign", "--notarize", "--dir"].includes(arg))
    throw new Error(`Unknown argument: ${arg}`);
const notarized = args.has("--notarize");
const signed = notarized || args.has("--sign");
if (notarized && args.has("--dir"))
  throw new Error("Notarization requires archives");
if (process.platform !== "darwin")
  throw new Error("Build macOS packages on macOS");
if (!["arm64", "x64"].includes(process.arch))
  throw new Error("Unsupported architecture");
const signing = signed ? signingConfig() : undefined;
const env = buildEnvironment();
if (signing) {
  env.YAKJEV_MAC_TEAM_ID = signing.team;
  env.YAKJEV_MAC_SIGNING_IDENTITY = signing.identity;
}

// Child output can include a certificate identity or local path. Keep it in the
// ignored private attempt, and emit only stage names to the terminal.
async function command(
  program,
  arguments_,
  { cwd = desktop, log, capture = false } = {},
) {
  return new Promise((fulfill, reject) => {
    const child = spawn(program, arguments_, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", async (code) => {
      try {
        const output = Buffer.concat(chunks);
        if (log) await writeFile(log, output, { mode: 0o600, flag: "wx" });
        if (code !== 0)
          throw new Error(
            `${program} failed (${code}); inspect the local build log`,
          );
        fulfill(capture ? output.toString("utf8").trim() : undefined);
      } catch (error) {
        reject(error);
      }
    });
  });
}

const bun = process.execPath;
const expectedBun = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
).packageManager.replace("bun@", "");
if ((await command(bun, ["--version"], { capture: true })) !== expectedBun)
  throw new Error(`Use the pinned Bun ${expectedBun}`);
const commit = await command("git", ["rev-parse", "HEAD"], { capture: true });
const dirty =
  (await command("git", ["status", "--porcelain"], { capture: true })) !== "";
if (signed && dirty)
  throw new Error("Commit changes before a signed release build");

const release = join(desktop, "release");
await mkdir(release, { recursive: true, mode: 0o700 });
if (
  (await lstat(release)).isSymbolicLink() ||
  (await realpath(release)) !== release
)
  throw new Error("Release directory must be a canonical directory");
const releaseStat = await lstat(release);
const attempt = await mkdtemp(join(release, ".attempt-"));
await chmod(attempt, 0o700);
const log = (name) => join(attempt, `${name}.log`);
console.log(
  `Building ${signed ? "Developer ID" : "source"} macOS ${process.arch} package`,
);

await command(bun, ["install", "--frozen-lockfile"], {
  cwd: repository,
  log: log("install"),
});
await command(bun, ["run", "build"], { log: log("compile") });
const manifest = JSON.parse(
  await readFile(join(desktop, "package.json"), "utf8"),
);
const provenance = {
  schema: 1,
  version: manifest.version,
  commit,
  dirty,
  architecture: process.arch,
  electron: manifest.devDependencies.electron,
  bun: expectedBun,
};
await writeFile(
  join(desktop, "out/build-provenance.json"),
  JSON.stringify(provenance, null, 2) + "\n",
);
console.log("Packaging and checking the application");
await command(
  bun,
  [
    "x",
    "--no-install",
    "electron-builder",
    "--mac",
    "--dir",
    `--${process.arch}`,
    "--publish",
    "never",
    `--config.directories.output=${attempt}`,
    `--config.mac.identity=${signing?.builderIdentity ?? "null"}`,
    `--config.mac.forceCodeSigning=${signed}`,
    "--config.mac.notarize=false",
  ],
  { log: log("package") },
);
const platformDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
const appPath = join(attempt, platformDirectory, "Yakjev.app");
await auditPackage(appPath, { signed });

const name = `Yakjev-${manifest.version}-${process.arch}`;
const zipPath = join(attempt, `${name}.zip`);
const dmgPath = join(attempt, `${name}.dmg`);
const receipt = { ...provenance, signed, notarized: false, artifacts: {} };
if (!args.has("--dir")) {
  if (notarized) {
    console.log(
      "Submitting application to Apple and stapling the accepted ticket",
    );
    receipt.applicationNotarization = await notarizeApp({
      appPath,
      zipPath,
      workDir: attempt,
    });
  } else {
    await command("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], {
      log: log("zip"),
    });
  }
  console.log("Creating the disk image");
  const imageRoot = join(attempt, "dmg-root");
  await mkdir(imageRoot, { mode: 0o700 });
  await command("ditto", [appPath, join(imageRoot, "Yakjev.app")], {
    log: log("dmg-copy"),
  });
  await command("ln", ["-s", "/Applications", join(imageRoot, "Applications")]);
  await command(
    "hdiutil",
    [
      "create",
      "-volname",
      "Yakjev",
      "-srcfolder",
      imageRoot,
      "-format",
      "UDZO",
      dmgPath,
    ],
    { log: log("dmg") },
  );
  if (signed)
    await command(
      "codesign",
      ["--sign", signing.identity, "--timestamp", dmgPath],
      { log: log("dmg-sign") },
    );
  if (notarized) {
    console.log("Submitting disk image to Apple and verifying its ticket");
    receipt.diskImageNotarization = await notarizeDmg({
      dmgPath,
      workDir: attempt,
    });
    receipt.notarized = true;
  }
  for (const path of [zipPath, dmgPath]) {
    const bytes = await readFile(path);
    receipt.artifacts[path.slice(attempt.length + 1)] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}
await auditPackage(appPath, { signed });
await writeFile(
  join(attempt, "receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
const current = await lstat(release);
if (
  current.dev !== releaseStat.dev ||
  current.ino !== releaseStat.ino ||
  current.isSymbolicLink()
)
  throw new Error("Release directory changed during build");
// A unique final directory preserves the last usable release on every failure.
const destination = join(
  release,
  `${manifest.version}-${process.arch}-${commit.slice(0, 8)}-${attempt.split(".attempt-")[1]}`,
);
await rename(attempt, destination);
console.log(`Ready: ${destination}/${platformDirectory}/Yakjev.app`);
console.log(`Local receipt: ${destination}/receipt.json`);

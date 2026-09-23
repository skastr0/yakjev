import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(desktopRoot, "release");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const canonicalDirectory = async (candidate, label) => {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute canonical directory`);
  }
  const metadata = await lstat(candidate);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(candidate)) !== candidate
  ) {
    throw new Error(`${label} must be a canonical non-symlink directory`);
  }
  return metadata;
};

const admitWorkDirectory = async (workDir) => {
  if (process.platform !== "darwin") {
    throw new Error("macOS notarization must run on macOS");
  }
  await canonicalDirectory(releaseRoot, "Release root");
  const metadata = await canonicalDirectory(
    workDir,
    "Notarization work directory",
  );
  if (
    path.dirname(workDir) !== releaseRoot ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("Notarization requires an owned mode-0700 release attempt");
  }
  return metadata;
};

const assertWorkDirectory = async (workDir, identity) => {
  const metadata = await canonicalDirectory(
    workDir,
    "Notarization work directory",
  );
  if (
    !sameIdentity(metadata, identity) ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("Notarization work directory changed during execution");
  }
};

const admitDirectOutput = async (candidate, workDir, extension, exists) => {
  if (
    typeof candidate !== "string" ||
    !path.isAbsolute(candidate) ||
    path.dirname(candidate) !== workDir ||
    !path.basename(candidate).endsWith(extension) ||
    /[\r\n\0]/u.test(candidate)
  ) {
    throw new Error(
      `Notarization ${extension} must be a direct release-attempt child`,
    );
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!exists) {
    if (metadata !== undefined) {
      throw new Error("Notarization archive output already exists");
    }
    return undefined;
  }
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (await realpath(candidate)) !== candidate
  ) {
    throw new Error("Notarization artifact must be a canonical regular file");
  }
  return metadata;
};

const assertArtifactIdentity = async (candidate, identity) => {
  const metadata = await lstat(candidate);
  if (
    metadata.isSymbolicLink() ||
    !sameIdentity(metadata, identity) ||
    (metadata.isFile() && metadata.nlink !== 1) ||
    (await realpath(candidate)) !== candidate
  ) {
    throw new Error("Notarization artifact changed during execution");
  }
};

const sha256 = async (filePath) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
};

// Raw Apple responses can contain account metadata. They stay in private files,
// and only the verified status, submission UUID and content hashes leave here.
const runPrivate = async (
  command,
  args,
  { workDir, label, env, timeout = 120_000 },
) => {
  const basename = `.${label}-${randomUUID()}`;
  const stdoutPath = path.join(workDir, `${basename}.json`);
  const stderrPath = path.join(workDir, `${basename}.err`);
  const stdout = await open(stdoutPath, "wx", 0o600);
  let stderr;
  try {
    stderr = await open(stderrPath, "wx", 0o600);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env,
        shell: false,
        stdio: ["ignore", stdout.fd, stderr.fd],
        timeout,
        killSignal: "SIGKILL",
      });
      child.once("error", () =>
        reject(new Error(`${label} could not execute`)),
      );
      child.once("close", (code) => resolve(code));
    });
    if (code !== 0) {
      throw new Error(`${label} failed; private diagnostics were retained`);
    }
  } finally {
    await stdout.close();
    await stderr?.close();
  }
  return { stdoutPath, stderrPath };
};

const readDmgCdHash = async (dmgPath, workDir, env) => {
  await runPrivate("/usr/bin/codesign", ["--verify", "--strict", dmgPath], {
    workDir,
    env,
    label: "dmg-signature-verification",
  });
  const { stderrPath } = await runPrivate(
    "/usr/bin/codesign",
    ["-d", "--verbose=4", dmgPath],
    { workDir, env, label: "dmg-signature-metadata" },
  );
  const metadata = await readFile(stderrPath, "utf8");
  const hashes = metadata
    .split("\n")
    .filter((line) => line.startsWith("CDHash="));
  if (hashes.length !== 1 || !/^CDHash=[0-9a-f]{40,64}$/iu.test(hashes[0])) {
    throw new Error("Disk image has no unambiguous signature content hash");
  }
  return hashes[0].slice("CDHash=".length).toLowerCase();
};

// stapler can atomically replace a DMG while attaching its ticket. Permit that
// inode change only across the staple call, with unchanged signed content, then
// bind all later checks to the replacement inode. Callers retain the original
// submitted archive hash separately because the ticket changes its file bytes.
export const stapleDmgPreservingSignature = async ({
  dmgPath,
  workDir,
  workIdentity,
  dmgIdentity,
  expectedCdHash,
  staple,
  readCdHash,
}) => {
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(dmgPath, dmgIdentity);
  if ((await readCdHash()) !== expectedCdHash) {
    throw new Error("Disk image signed content changed before stapling");
  }
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(dmgPath, dmgIdentity);
  await staple();
  await assertWorkDirectory(workDir, workIdentity);
  const stapledIdentity = await admitDirectOutput(
    dmgPath,
    workDir,
    ".dmg",
    true,
  );
  if ((await readCdHash()) !== expectedCdHash) {
    throw new Error("Stapling changed the disk image signed content");
  }
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(dmgPath, stapledIdentity);
  return stapledIdentity;
};

// asc can emit consecutive JSON objects. Parse a strict JSON object stream,
// including braces inside strings, and use the final submission response.
export const parseNotarizationResponse = (raw) => {
  const values = [];
  let offset = 0;
  while (offset < raw.length) {
    while (/\s/u.test(raw[offset] ?? "") && offset < raw.length) offset += 1;
    if (offset === raw.length) break;
    const start = offset;
    if (raw[offset] !== "{" && raw[offset] !== "[") {
      throw new Error("Notarization returned an invalid JSON response");
    }
    let depth = 0;
    let string = false;
    let escaped = false;
    for (; offset < raw.length; offset += 1) {
      const char = raw[offset];
      if (string) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') string = false;
      } else if (char === '"') string = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          offset += 1;
          break;
        }
      }
    }
    if (depth !== 0 || string)
      throw new Error("Notarization returned incomplete JSON");
    try {
      values.push(JSON.parse(raw.slice(start, offset)));
    } catch {
      throw new Error("Notarization returned an invalid JSON response");
    }
  }
  let response = values.at(-1);
  response = response?.data ?? response;
  if (Array.isArray(response)) {
    if (response.length !== 1)
      throw new Error("Notarization response is ambiguous");
    response = response[0];
  }
  const status = response?.attributes?.status ?? response?.status;
  const submissionId = response?.id ?? response?.attributes?.id;
  if (status !== "Accepted") {
    throw new Error("Apple did not accept the notarization submission");
  }
  if (typeof submissionId !== "string" || !uuidPattern.test(submissionId)) {
    throw new Error("Notarization response has no valid submission identifier");
  }
  return { status: "Accepted", submissionId };
};

const submit = async (filePath, workDir, env, kind) => {
  await runPrivate("asc", ["doctor"], {
    workDir,
    env,
    label: `${kind}-notary-auth`,
  });
  const { stdoutPath } = await runPrivate(
    "asc",
    [
      "notarization",
      "submit",
      "--file",
      filePath,
      "--wait",
      "--timeout",
      "45m",
      "--poll-interval",
      "15s",
      "--output",
      "json",
    ],
    {
      workDir,
      env: { ...env, ASC_UPLOAD_TIMEOUT: env.ASC_UPLOAD_TIMEOUT || "1800s" },
      label: `${kind}-notary-submit`,
      timeout: 80 * 60_000,
    },
  );
  return parseNotarizationResponse(await readFile(stdoutPath, "utf8"));
};

export const notarizeApp = async ({
  appPath,
  zipPath,
  workDir,
  env = process.env,
}) => {
  const workIdentity = await admitWorkDirectory(workDir);
  if (
    !["mac-arm64", "mac"].some(
      (directory) => appPath === path.join(workDir, directory, "Yakjev.app"),
    )
  ) {
    throw new Error(
      "Notarization app must be Yakjev.app inside this release attempt",
    );
  }
  const appIdentity = await canonicalDirectory(appPath, "Notarization app");
  await admitDirectOutput(zipPath, workDir, ".zip", false);
  const run = (command, args, label) =>
    runPrivate(command, args, { workDir, env, label });
  await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    "app-signature",
  );
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(appPath, appIdentity);
  await run(
    "/usr/bin/ditto",
    ["-c", "-k", "--keepParent", appPath, zipPath],
    "app-archive",
  );
  const zipIdentity = await admitDirectOutput(zipPath, workDir, ".zip", true);
  const inputSha256 = await sha256(zipPath);
  const accepted = await submit(zipPath, workDir, env, "app");
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(appPath, appIdentity);
  await assertArtifactIdentity(zipPath, zipIdentity);
  if ((await sha256(zipPath)) !== inputSha256) {
    throw new Error("Submitted archive changed during notarization");
  }
  await run("/usr/bin/xcrun", ["stapler", "staple", appPath], "app-staple");
  await run(
    "/usr/bin/xcrun",
    ["stapler", "validate", appPath],
    "app-staple-validation",
  );
  await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    "app-final-signature",
  );
  await run(
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", appPath],
    "app-gatekeeper",
  );
  const stapledZip = path.join(workDir, `.stapled-${randomUUID()}.zip`);
  await run(
    "/usr/bin/ditto",
    ["-c", "-k", "--keepParent", appPath, stapledZip],
    "app-stapled-archive",
  );
  await admitDirectOutput(stapledZip, workDir, ".zip", true);
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(zipPath, zipIdentity);
  await rename(stapledZip, zipPath);
  const outputSha256 = await sha256(zipPath);
  return { ...accepted, inputSha256, outputSha256 };
};

export const notarizeDmg = async ({ dmgPath, workDir, env = process.env }) => {
  const workIdentity = await admitWorkDirectory(workDir);
  const dmgIdentity = await admitDirectOutput(dmgPath, workDir, ".dmg", true);
  const expectedCdHash = await readDmgCdHash(dmgPath, workDir, env);
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(dmgPath, dmgIdentity);
  const inputSha256 = await sha256(dmgPath);
  const accepted = await submit(dmgPath, workDir, env, "dmg");
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(dmgPath, dmgIdentity);
  if ((await sha256(dmgPath)) !== inputSha256) {
    throw new Error("Submitted disk image changed during notarization");
  }
  const run = (args, label) =>
    runPrivate("/usr/bin/xcrun", args, { workDir, env, label });
  const stapledIdentity = await stapleDmgPreservingSignature({
    dmgPath,
    workDir,
    workIdentity,
    dmgIdentity,
    expectedCdHash,
    staple: () => run(["stapler", "staple", dmgPath], "dmg-staple"),
    readCdHash: () => readDmgCdHash(dmgPath, workDir, env),
  });
  await run(["stapler", "validate", dmgPath], "dmg-staple-validation");
  await runPrivate(
    "/usr/sbin/spctl",
    [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      dmgPath,
    ],
    { workDir, env, label: "dmg-gatekeeper" },
  );
  await assertWorkDirectory(workDir, workIdentity);
  await assertArtifactIdentity(dmgPath, stapledIdentity);
  const outputSha256 = await sha256(dmgPath);
  await assertArtifactIdentity(dmgPath, stapledIdentity);
  return { ...accepted, inputSha256, outputSha256 };
};

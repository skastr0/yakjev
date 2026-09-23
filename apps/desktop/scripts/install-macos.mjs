#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rmdir,
} from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditPackage } from "./audit-package.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(desktopRoot, "release");
const bundleIdentifier = "dev.castro.yakjev";
const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${path.basename(command)} did not complete successfully`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
};

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

const assertIdentity = async (candidate, identity) => {
  if (
    !sameIdentity(
      await canonicalDirectory(candidate, "Install directory"),
      identity,
    )
  ) {
    throw new Error("An install directory changed during execution");
  }
};

const cdHash = (appPath, env) => {
  const output = run("/usr/bin/codesign", ["-d", "--verbose=4", appPath], env);
  const hashes = output.split("\n").flatMap((line) => {
    const match = /^CDHash=([0-9a-f]{40,64})$/iu.exec(line.trim());
    return match ? [match[1].toLowerCase()] : [];
  });
  if (hashes.length !== 1)
    throw new Error("App signature has no unambiguous content hash");
  return hashes[0];
};

const requireStopped = (env) => {
  const processes = run("/bin/ps", ["-axww", "-o", "comm="], env);
  if (
    processes
      .split("\n")
      .some((line) => /\/Yakjev\.app\/Contents\//u.test(line))
  ) {
    throw new Error(
      "Quit Yakjev before installing; the running app was left untouched",
    );
  }
};

const validateApp = async (appPath, { signed, notarized, env }) => {
  try {
    await auditPackage(appPath, { signed, environment: env });
  } catch {
    throw new Error("Yakjev package audit failed; installation was refused");
  }
  if (notarized) {
    run("/usr/bin/xcrun", ["stapler", "validate", appPath], env);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], env);
  }
  return cdHash(appPath, env);
};

export const installMacApp = async ({
  appPath,
  signed = false,
  notarized = false,
  env = process.env,
}) => {
  if (process.platform !== "darwin")
    throw new Error("Yakjev installation requires macOS");
  signed ||= notarized;
  await canonicalDirectory(releaseRoot, "Desktop release root");
  const sourceIdentity = await canonicalDirectory(appPath, "Source app");
  const relative = path.relative(releaseRoot, appPath);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    path.basename(appPath) !== "Yakjev.app"
  ) {
    throw new Error(
      "Install source must be a Yakjev.app inside the desktop release directory",
    );
  }
  requireStopped(env);
  const options = { signed, notarized, env };
  const expectedHash = await validateApp(appPath, options);
  const accountHome = userInfo().homedir;
  await canonicalDirectory(accountHome, "Account home");
  const applications = path.join(accountHome, "Applications");
  try {
    await mkdir(applications, { mode: 0o755 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const applicationsIdentity = await canonicalDirectory(
    applications,
    "Applications directory",
  );
  if (applicationsIdentity.uid !== process.getuid()) {
    throw new Error(
      "User Applications directory is not owned by the current account",
    );
  }
  const destination = path.join(applications, "Yakjev.app");
  let previousIdentity;
  try {
    previousIdentity = await canonicalDirectory(destination, "Installed app");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previousIdentity !== undefined) {
    const info = JSON.parse(
      run(
        "/usr/bin/plutil",
        [
          "-convert",
          "json",
          "-o",
          "-",
          path.join(destination, "Contents", "Info.plist"),
        ],
        env,
      ),
    );
    if (info.CFBundleIdentifier !== bundleIdentifier) {
      throw new Error("The existing Yakjev.app belongs to another product");
    }
  }
  await assertIdentity(applications, applicationsIdentity);
  const stageRoot = await mkdtemp(path.join(applications, ".yakjev-install-"));
  const stageIdentity = await canonicalDirectory(stageRoot, "Install stage");
  const stagedApp = path.join(stageRoot, "Yakjev.app");
  const backup =
    previousIdentity === undefined
      ? undefined
      : path.join(
          applications,
          `Yakjev.previous-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.app`,
        );
  let stagedIdentity;
  let retired = false;
  let installed = false;
  try {
    run("/usr/bin/ditto", ["--rsrc", appPath, stagedApp], env);
    await assertIdentity(appPath, sourceIdentity);
    await assertIdentity(stageRoot, stageIdentity);
    stagedIdentity = await canonicalDirectory(stagedApp, "Staged app");
    if ((await validateApp(stagedApp, options)) !== expectedHash) {
      throw new Error("Staged app does not match the audited release");
    }
    requireStopped(env);
    await assertIdentity(applications, applicationsIdentity);
    await assertIdentity(stageRoot, stageIdentity);
    await assertIdentity(stagedApp, stagedIdentity);
    if (previousIdentity !== undefined) {
      await assertIdentity(destination, previousIdentity);
      await rename(destination, backup);
      retired = true;
      await assertIdentity(backup, previousIdentity);
    } else {
      try {
        await lstat(destination);
        throw new Error("Install destination appeared during staging");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await rename(stagedApp, destination);
    installed = true;
    await assertIdentity(destination, stagedIdentity);
    if ((await validateApp(destination, options)) !== expectedHash) {
      throw new Error("Installed app does not match the audited release");
    }
    await assertIdentity(applications, applicationsIdentity);
    await assertIdentity(stageRoot, stageIdentity);
    await rmdir(stageRoot);
    return { appPath: destination, backupPath: backup, signed, notarized };
  } catch (error) {
    try {
      await assertIdentity(applications, applicationsIdentity);
      await assertIdentity(stageRoot, stageIdentity);
      if (installed) {
        await assertIdentity(destination, stagedIdentity);
        await rename(destination, path.join(stageRoot, "failed-Yakjev.app"));
      }
      if (retired) {
        await assertIdentity(backup, previousIdentity);
        await rename(backup, destination);
        await assertIdentity(destination, previousIdentity);
      }
    } catch {
      throw new Error(
        "Installation failed and automatic restoration was unsafe; retained install directories require inspection",
      );
    }
    throw error;
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    let appPath;
    let signed = false;
    let notarized = false;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--app" && args[index + 1]) appPath = args[++index];
      else if (args[index] === "--signed") signed = true;
      else if (args[index] === "--notarized") notarized = true;
      else
        throw new Error(
          "Usage: install-macos.mjs --app ABSOLUTE_PATH [--signed] [--notarized]",
        );
    }
    if (!appPath) throw new Error("--app must name a built release app");
    const result = await installMacApp({ appPath, signed, notarized });
    console.log("Installed ~/Applications/Yakjev.app");
    if (result.backupPath)
      console.log(
        `Previous app retained at ~/Applications/${path.basename(result.backupPath)}`,
      );
  } catch (error) {
    console.error(`yakjev: ${error.message}`);
    process.exitCode = 1;
  }
}

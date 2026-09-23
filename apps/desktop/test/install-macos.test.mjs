import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStagedApp } from "../scripts/install-macos.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// Exercise the real directory transaction with synthetic bundle contents.
// Platform signing and audit commands belong to the release/install smoke.
const fixture = async ({ existing = true } = {}) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "yakjev-install-test-")),
  );
  roots.push(root);
  const applications = path.join(root, "Applications");
  await mkdir(applications);
  const destination = path.join(applications, "Yakjev.app");
  let previousIdentity;
  if (existing) {
    await mkdir(destination);
    await writeFile(path.join(destination, "version"), "previous");
    await writeFile(path.join(destination, "old-resource"), "old resource");
    previousIdentity = await lstat(destination);
  }
  const stageRoot = await mkdtemp(path.join(applications, ".yakjev-install-"));
  const stagedApp = path.join(stageRoot, "Yakjev.app");
  await mkdir(stagedApp);
  await writeFile(path.join(stagedApp, "version"), "current");
  const readVersion = (appPath = destination) =>
    readFile(path.join(appPath, "version"), "utf8");
  return {
    root,
    applications,
    applicationsIdentity: await lstat(applications),
    destination,
    stageRoot,
    stageIdentity: await lstat(stageRoot),
    stagedIdentity: await lstat(stagedApp),
    previousIdentity,
    backup: path.join(stageRoot, "previous"),
    readVersion,
    verifyInstalled: async () => {
      expect(await readVersion()).toBe("current");
    },
  };
};

test("fresh installation leaves only the canonical app", async () => {
  const input = await fixture({ existing: false });
  const result = await installStagedApp(input);
  expect(result).toEqual({ appPath: input.destination });
  expect(await readdir(input.applications)).toEqual(["Yakjev.app"]);
  expect(await input.readVersion()).toBe("current");
  expect((await lstat(input.destination)).ino).toBe(input.stagedIdentity.ino);
});

test("upgrade retains a hidden extensionless backup only until verification", async () => {
  const input = await fixture();
  let verified = false;
  const result = await installStagedApp({
    ...input,
    verifyInstalled: async () => {
      verified = true;
      expect(await input.readVersion()).toBe("current");
      expect(await input.readVersion(input.backup)).toBe("previous");
      expect((await lstat(input.backup)).ino).toBe(input.previousIdentity.ino);
      expect(path.extname(input.backup)).toBe("");
      expect((await readdir(input.stageRoot)).sort()).toEqual(["previous"]);
      expect(
        (await readdir(input.applications)).filter((name) =>
          name.endsWith(".app"),
        ),
      ).toEqual(["Yakjev.app"]);
    },
  });
  expect(verified).toBe(true);
  expect(result).toEqual({ appPath: input.destination });
  expect(await readdir(input.applications)).toEqual(["Yakjev.app"]);
  expect(await input.readVersion()).toBe("current");
});

test("failed installed verification restores the intact previous app", async () => {
  const input = await fixture();
  let removedBackup = false;
  await expect(
    installStagedApp({
      ...input,
      verifyInstalled: async () => {
        throw new Error("synthetic installed audit failure");
      },
      removeBackup: async () => {
        removedBackup = true;
      },
    }),
  ).rejects.toThrow("synthetic installed audit failure");
  expect(removedBackup).toBe(false);
  expect(await input.readVersion()).toBe("previous");
  expect((await lstat(input.destination)).ino).toBe(input.previousIdentity.ino);
  expect(
    await readFile(path.join(input.destination, "old-resource"), "utf8"),
  ).toBe("old resource");
  expect(await readdir(input.stageRoot)).toEqual(["failed"]);
  expect(await input.readVersion(path.join(input.stageRoot, "failed"))).toBe(
    "current",
  );
});

test("partial backup deletion cannot roll back the verified installation", async () => {
  const input = await fixture();
  const result = await installStagedApp({
    ...input,
    removeBackup: async (backup) => {
      await unlink(path.join(backup, "old-resource"));
      throw new Error("synthetic partial cleanup failure");
    },
  });
  expect(result).toEqual({
    appPath: input.destination,
    cleanupPath: input.stageRoot,
  });
  expect(await input.readVersion()).toBe("current");
  expect((await lstat(input.destination)).ino).toBe(input.stagedIdentity.ino);
  expect(await input.readVersion(input.backup)).toBe("previous");
  expect(await readdir(input.backup)).toEqual(["version"]);
  expect(await readdir(input.stageRoot)).toEqual(["previous"]);
});

test("transaction cleanup failure after old app deletion keeps the new app", async () => {
  const input = await fixture();
  const result = await installStagedApp({
    ...input,
    removeBackup: async (backup) => {
      await rm(backup, { recursive: true });
      await writeFile(
        path.join(input.stageRoot, "retained-diagnostic"),
        "synthetic",
      );
    },
  });
  expect(result.cleanupPath).toBe(input.stageRoot);
  expect(await input.readVersion()).toBe("current");
  expect((await lstat(input.destination)).ino).toBe(input.stagedIdentity.ino);
  expect(await readdir(input.stageRoot)).toEqual(["retained-diagnostic"]);
});

test("backup identity substitution refuses disposal and preserves foreign data", async () => {
  const input = await fixture();
  let removedBackup = false;
  const retained = path.join(input.stageRoot, "retained-previous");
  const result = await installStagedApp({
    ...input,
    verifyInstalled: async () => {
      await rename(input.backup, retained);
      await mkdir(input.backup);
      await writeFile(path.join(input.backup, "foreign"), "foreign data");
    },
    removeBackup: async () => {
      removedBackup = true;
    },
  });
  expect(removedBackup).toBe(false);
  expect(result.cleanupPath).toBe(input.stageRoot);
  expect(await input.readVersion()).toBe("current");
  expect(await input.readVersion(retained)).toBe("previous");
  expect(await readFile(path.join(input.backup, "foreign"), "utf8")).toBe(
    "foreign data",
  );
});

test("symlink backup substitution never reaches recursive disposal", async () => {
  const input = await fixture();
  const foreign = path.join(input.root, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "untouched"), "foreign data");
  let removedBackup = false;
  const result = await installStagedApp({
    ...input,
    verifyInstalled: async () => {
      await rename(
        input.backup,
        path.join(input.stageRoot, "retained-previous"),
      );
      await symlink(foreign, input.backup);
    },
    removeBackup: async () => {
      removedBackup = true;
    },
  });
  expect(removedBackup).toBe(false);
  expect(result.cleanupPath).toBe(input.stageRoot);
  expect(await input.readVersion()).toBe("current");
  expect(await readFile(path.join(foreign, "untouched"), "utf8")).toBe(
    "foreign data",
  );
});

test("stale stage identity refuses activation without touching either app", async () => {
  const input = await fixture();
  const retained = path.join(input.applications, ".retained-stage");
  await rename(input.stageRoot, retained);
  await mkdir(input.stageRoot);
  await writeFile(path.join(input.stageRoot, "foreign"), "foreign data");
  let verified = false;
  await expect(
    installStagedApp({
      ...input,
      verifyInstalled: async () => {
        verified = true;
      },
    }),
  ).rejects.toThrow("automatic restoration was unsafe");
  expect(verified).toBe(false);
  expect(await input.readVersion()).toBe("previous");
  expect(await input.readVersion(path.join(retained, "Yakjev.app"))).toBe(
    "current",
  );
  expect(await readFile(path.join(input.stageRoot, "foreign"), "utf8")).toBe(
    "foreign data",
  );
});

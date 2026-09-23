import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stapleDmgPreservingSignature } from "../scripts/notarize.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// Synthetic signature readers isolate the file-replacement contract. Actual
// Apple signing, stapling and Gatekeeper validation run in the release pipeline.
const fixture = async () => {
  const workDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "yakjev-staple-test-")),
  );
  roots.push(workDir);
  const dmgPath = path.join(workDir, "Yakjev.dmg");
  const expectedCdHash = "a".repeat(40);
  await writeFile(dmgPath, JSON.stringify({ cdHash: expectedCdHash }));
  const replace = async (cdHash = expectedCdHash) => {
    const replacement = path.join(workDir, "replacement.dmg");
    await writeFile(
      replacement,
      JSON.stringify({ cdHash, ticket: "synthetic" }),
    );
    await rename(replacement, dmgPath);
  };
  return {
    dmgPath,
    workDir,
    expectedCdHash,
    workIdentity: await lstat(workDir),
    dmgIdentity: await lstat(dmgPath),
    staple: replace,
    readCdHash: async () => JSON.parse(await readFile(dmgPath, "utf8")).cdHash,
    replace,
  };
};

test("allows stapler to replace the inode while preserving signed content", async () => {
  const input = await fixture();
  const output = await stapleDmgPreservingSignature(input);
  expect(output.ino).not.toBe(input.dmgIdentity.ino);
  expect(output.ino).toBe((await lstat(input.dmgPath)).ino);
  expect(await input.readCdHash()).toBe(input.expectedCdHash);
});

test("rejects a replacement with different signed content", async () => {
  const input = await fixture();
  await expect(
    stapleDmgPreservingSignature({
      ...input,
      staple: () => input.replace("b".repeat(40)),
    }),
  ).rejects.toThrow("Stapling changed the disk image signed content");
});

test("rejects an inode replacement before the stapler mutation window", async () => {
  const input = await fixture();
  await input.replace();
  let stapled = false;
  await expect(
    stapleDmgPreservingSignature({
      ...input,
      staple: async () => {
        stapled = true;
      },
    }),
  ).rejects.toThrow("Notarization artifact changed during execution");
  expect(stapled).toBe(false);
});

test("rejects replacement during pre-staple signature inspection", async () => {
  const input = await fixture();
  let stapled = false;
  await expect(
    stapleDmgPreservingSignature({
      ...input,
      readCdHash: async () => {
        await input.replace();
        return input.expectedCdHash;
      },
      staple: async () => {
        stapled = true;
      },
    }),
  ).rejects.toThrow("Notarization artifact changed during execution");
  expect(stapled).toBe(false);
});

test("rejects a symlink produced during the mutation window", async () => {
  const input = await fixture();
  await expect(
    stapleDmgPreservingSignature({
      ...input,
      staple: async () => {
        const target = path.join(input.workDir, "other.dmg");
        await writeFile(
          target,
          JSON.stringify({ cdHash: input.expectedCdHash }),
        );
        await unlink(input.dmgPath);
        await symlink(target, input.dmgPath);
      },
    }),
  ).rejects.toThrow("Notarization artifact must be a canonical regular file");
});

test("rejects another inode replacement during post-staple signature inspection", async () => {
  const input = await fixture();
  let inspected = 0;
  await expect(
    stapleDmgPreservingSignature({
      ...input,
      readCdHash: async () => {
        inspected += 1;
        if (inspected === 2) await input.replace();
        return input.expectedCdHash;
      },
    }),
  ).rejects.toThrow("Notarization artifact changed during execution");
});

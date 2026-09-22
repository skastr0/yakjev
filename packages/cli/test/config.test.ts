import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  configuredOwnerToken,
  configuredRemoteUrl,
  defaultClientConfigPath,
  loadClientConfig,
} from "../src/config";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const tempConfig = async (contents?: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "yakjev-cli-config-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  if (contents !== undefined) await writeFile(path, contents);
  return path;
};

test("defaultClientConfigPath honors YAKJEV_CONFIG and otherwise uses the home default", () => {
  expect(defaultClientConfigPath({ YAKJEV_CONFIG: "custom/cfg.json" })).toBe(
    resolve("custom/cfg.json"),
  );
  expect(defaultClientConfigPath({})).toBe(
    join(homedir(), ".config", "yakjev", "config.json"),
  );
});

test("loadClientConfig returns undefined when the file is absent", async () => {
  const path = await tempConfig();
  expect(loadClientConfig(path)).toBeUndefined();
});

test("loadClientConfig reads and trims remoteUrl and ownerToken", async () => {
  const path = await tempConfig(
    JSON.stringify({ remoteUrl: "  http://a:7345 ", ownerToken: " tok " }),
  );
  expect(loadClientConfig(path)).toEqual({
    remoteUrl: "http://a:7345",
    ownerToken: "tok",
  });
});

test("non-record or blank config values resolve to undefined fields", async () => {
  for (const contents of [`"text"`, `[1,2]`, `null`]) {
    const path = await tempConfig(contents);
    expect(loadClientConfig(path)).toEqual({
      remoteUrl: undefined,
      ownerToken: undefined,
    });
  }
  const blanks = await tempConfig(
    JSON.stringify({ remoteUrl: "   ", ownerToken: 42 }),
  );
  expect(loadClientConfig(blanks)).toEqual({
    remoteUrl: undefined,
    ownerToken: undefined,
  });
});

test("a malformed config file throws instead of being ignored", async () => {
  const path = await tempConfig("{ not json");
  expect(() => loadClientConfig(path)).toThrow();
});

test("env remote URL beats the file and trailing slashes are stripped", async () => {
  const path = await tempConfig(
    JSON.stringify({ remoteUrl: "http://file:1", ownerToken: "file-tok" }),
  );
  expect(
    configuredRemoteUrl({
      YAKJEV_CONFIG: path,
      YAKJEV_REMOTE_URL: "http://env:2///",
    }),
  ).toBe("http://env:2");
});

test("YAKJEV_URL is the remote alias and loses to YAKJEV_REMOTE_URL", async () => {
  const path = await tempConfig();
  expect(
    configuredRemoteUrl({ YAKJEV_CONFIG: path, YAKJEV_URL: "http://alias:3/" }),
  ).toBe("http://alias:3");
  expect(
    configuredRemoteUrl({
      YAKJEV_CONFIG: path,
      YAKJEV_URL: "http://alias:3",
      YAKJEV_REMOTE_URL: "http://primary:4",
    }),
  ).toBe("http://primary:4");
});

test("a blank env var falls through to the config file", async () => {
  const path = await tempConfig(
    JSON.stringify({ remoteUrl: "http://file:1/", ownerToken: "file-tok" }),
  );
  expect(
    configuredRemoteUrl({ YAKJEV_CONFIG: path, YAKJEV_REMOTE_URL: "   " }),
  ).toBe("http://file:1");
  expect(
    configuredOwnerToken({ YAKJEV_CONFIG: path, YAKJEV_OWNER_TOKEN: "  " }),
  ).toBe("file-tok");
});

test("file values are used when env is absent; nothing resolves with no file", async () => {
  const missing = await tempConfig();
  const env = { YAKJEV_CONFIG: missing };
  expect(configuredRemoteUrl(env)).toBeUndefined();
  expect(configuredOwnerToken(env)).toBeUndefined();
  const path = await tempConfig(
    JSON.stringify({ remoteUrl: "http://file:9//", ownerToken: "  tok9  " }),
  );
  expect(configuredRemoteUrl({ YAKJEV_CONFIG: path })).toBe("http://file:9");
  expect(configuredOwnerToken({ YAKJEV_CONFIG: path })).toBe("tok9");
});

test("env token beats the file token", async () => {
  const path = await tempConfig(JSON.stringify({ ownerToken: "file-tok" }));
  expect(
    configuredOwnerToken({
      YAKJEV_CONFIG: path,
      YAKJEV_OWNER_TOKEN: "env-tok",
    }),
  ).toBe("env-tok");
});

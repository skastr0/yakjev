import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { DesktopError } from "../src/main/config";
import { Settings } from "../src/main/settings";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(contents?: string) {
  const directory = await mkdtemp(join(tmpdir(), "yakjev-desktop-settings-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "profile", "connection.json");
  if (contents !== undefined) {
    await mkdir(dirname(path));
    await writeFile(path, contents);
  }
  const runtime = ManagedRuntime.make(Settings.layer(path));
  cleanups.push(() => runtime.dispose());
  const settings = await runtime.runPromise(Settings);
  return { path, settings, run: runtime.runPromise };
}

test("a first launch has no configured server and does not create settings", async () => {
  const { path, settings, run } = await fixture();
  expect(await run(settings.read)).toBeUndefined();
  expect(await Bun.file(path).exists()).toBe(false);
});

test("saves only the server origin and replaces previous settings", async () => {
  const { path, settings, run } = await fixture();
  await run(settings.save("https://first.example"));
  expect(await run(settings.read)).toBe("https://first.example");

  await run(settings.save("https://second.example:8443"));
  expect(await run(settings.read)).toBe("https://second.example:8443");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    origin: "https://second.example:8443",
  });
  expect(await readdir(dirname(path))).toEqual(["connection.json"]);
});

test("new settings files and their directory are private to the owner", async () => {
  const { path, settings, run } = await fixture();
  await run(settings.save("https://yakjev.example"));
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  }
});

test("canonicalizes a saved server when reading it", async () => {
  const { settings, run } = await fixture(
    JSON.stringify({ origin: " HTTPS://Yakjev.Example:443/ " }),
  );
  expect(await run(settings.read)).toBe("https://yakjev.example");
});

test.each([
  "{invalid json",
  "null",
  "[]",
  '"https://yakjev.example"',
  "{}",
  '{"origin": 7345}',
  '{"origin": "http://public.example"}',
  '{"origin": "https://token@yakjev.example"}',
  '{"origin": "https://yakjev.example/api"}',
])("invalid saved settings fail explicitly: %s", async (contents) => {
  const { path, settings, run } = await fixture(contents);
  const failure = await run(
    settings.read.pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
    ),
  );
  expect(failure).toBeInstanceOf(DesktopError);
  expect(await readFile(path, "utf8")).toBe(contents);
});

test("filesystem read failures are not mistaken for a first launch", async () => {
  const { path, settings, run } = await fixture();
  await mkdir(path, { recursive: true });
  const failure = await run(
    settings.read.pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
    ),
  );
  expect(failure).toBeInstanceOf(DesktopError);
  expect(failure?.message).toContain("Could not read");
});

test("filesystem save failures return a typed error", async () => {
  const { path, settings, run } = await fixture();
  await writeFile(dirname(path), "existing non-directory");
  const failure = await run(
    settings.save("https://yakjev.example").pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => undefined,
      }),
    ),
  );
  expect(failure).toBeInstanceOf(DesktopError);
  expect(failure?.message).toContain("Could not save");
  expect(await readFile(dirname(path), "utf8")).toBe("existing non-directory");
});

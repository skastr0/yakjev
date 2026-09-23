#!/usr/bin/env bun
// Exercise the shipping binary with renderer CDP only. Locked Electron fuses
// remain intact; no Node inspector or replacement executable is involved.
// YAKJEV_DESKTOP_EXECUTABLE=/absolute/path/to/Yakjev bun e2e/release-smoke.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import type { Subprocess } from "bun";
import type { Layout } from "../../../packages/protocol/src/index";
import { readGraph, sendCommand } from "../../../tests/acceptance/contract";
import {
  acceptanceToken,
  startServer,
} from "../../../tests/acceptance/harness";
import { launchEnvironment } from "./environment";

const configuredExecutable = process.env.YAKJEV_DESKTOP_EXECUTABLE;
assert(
  configuredExecutable,
  "Set YAKJEV_DESKTOP_EXECUTABLE to the built application executable.",
);
const executable = resolve(configuredExecutable);
const desktopRoot = resolve(import.meta.dir, "..");
const artifacts = join(desktopRoot, "artifacts");
const timings: { step: string; ms: number }[] = [];

async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await action();
  const ms = Math.round(performance.now() - started);
  timings.push({ step: name, ms });
  console.log(`PASS ${name} (${ms} ms)`);
  return value;
}

async function stopProcess(child: Subprocess): Promise<void> {
  if (child.exitCode === null) child.kill("SIGTERM");
  let cancelTimeout = () => {};
  const code = await Promise.race([
    child.exited,
    new Promise<undefined>((resolveTimeout) => {
      const timer = setTimeout(resolveTimeout, 30_000);
      cancelTimeout = () => clearTimeout(timer);
    }),
  ]);
  cancelTimeout();
  if (code === undefined) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(
      "The native application did not shut down within 30 seconds.",
    );
  }
  assert.equal(code, 0, "the native application must exit cleanly");
}

type NativeClient = { browser: Browser; page: Page; close(): Promise<void> };

async function launch(
  origin: string,
  userData: string,
  captureLog: (text: string) => void,
): Promise<NativeClient> {
  const child = Bun.spawn({
    cmd: [
      executable,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
    ],
    cwd: desktopRoot,
    env: { ...launchEnvironment(userData), YAKJEV_REMOTE_URL: origin },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  async function collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output = (output + text).slice(-16_384);
      captureLog(text);
    }
  }
  void collect(child.stdout).catch(() => {});
  void collect(child.stderr).catch(() => {});
  let browser: Browser | undefined;
  try {
    const endpoint = () =>
      output.match(
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
      )?.[1];
    await expect
      .poll(
        () => {
          if (child.exitCode !== null)
            throw new Error(
              `Application exited during startup (${child.exitCode}).`,
            );
          return endpoint();
        },
        {
          timeout: 25_000,
          message:
            "the packaged application must expose ephemeral loopback renderer CDP",
        },
      )
      .toBeTruthy();
    const address = endpoint();
    assert(address);
    browser = await chromium.connectOverCDP(address);
    const pages = () =>
      browser!.contexts().flatMap((context) => context.pages());
    await expect
      .poll(() => pages().some((page) => page.url() === `${origin}/`), {
        timeout: 20_000,
      })
      .toBe(true);
    const page = pages().find((candidate) => candidate.url() === `${origin}/`);
    assert(page, "the local renderer must use the synthetic server origin");
    const connected = browser;
    return {
      browser,
      page,
      async close() {
        // SIGTERM reaches the application's normal app.quit/Effect disposal
        // path, including native cookie flushing. CDP never closes the app.
        try {
          await stopProcess(child);
        } finally {
          await connected.close().catch(() => {});
        }
      },
    };
  } catch (error) {
    await stopProcess(child).catch(() => {});
    await browser?.close().catch(() => {});
    throw error;
  }
}

async function live(page: Page): Promise<void> {
  await expect(
    page.locator('.connection-status[data-state="live"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("application")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
}

async function unlock(page: Page): Promise<void> {
  await page.getByLabel("Owner access token").fill(acceptanceToken);
  await page.getByRole("button", { name: "Unlock graph" }).click();
  await live(page);
}

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "yakjev-release-smoke-"));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let client: NativeClient | undefined;
  let failure: unknown;
  let nativeOutput = "";
  const sanitize = (text: string) =>
    text
      .replaceAll(acceptanceToken, "[synthetic owner token]")
      .replaceAll(userData, "[isolated profile]");
  const captureLog = (text: string) => {
    nativeOutput = (nativeOutput + sanitize(text)).slice(-8_192);
  };
  try {
    server = await startServer();
    const synthetic = server;
    client = await step("packaged app starts through renderer CDP", () =>
      launch(synthetic.origin, userData, captureLog),
    );
    const page = client.page;
    await step(
      "owner login renders the graph without a native bridge",
      async () => {
        await unlock(page);
        assert.deepEqual(
          await page.evaluate(() => {
            const globals = window as unknown as Record<string, unknown>;
            return {
              require: typeof globals.require,
              process: typeof globals.process,
              bridges: Object.keys(window).filter((key) =>
                /electron|desktop/i.test(key),
              ),
              cookie: document.cookie,
            };
          }),
          {
            require: "undefined",
            process: "undefined",
            bridges: [],
            cookie: "",
          },
        );
      },
    );
    await step(
      "rendered create and edit reach the authoritative server",
      async () => {
        await page.keyboard.press("c");
        await page
          .getByLabel("Intention", { exact: true })
          .fill("Synthetic release intention");
        await page.getByLabel("Intention", { exact: true }).press("Enter");
        await expect
          .poll(async () => (await readGraph(synthetic)).nodes[0]?.title)
          .toBe("Synthetic release intention");
        assert.equal(
          (await readGraph(synthetic)).nodes[0]?.color,
          "#ed4968",
          "capture must save the original red default atomically",
        );
        await page
          .getByLabel("Title", { exact: true })
          .fill("Edited release intention");
        await page.getByLabel("Title", { exact: true }).press("Tab");
        await expect
          .poll(async () => (await readGraph(synthetic)).nodes[0]?.title)
          .toBe("Edited release intention");
        const palette = page.getByRole("group", { name: "Color", exact: true });
        await palette
          .getByRole("button", { name: "orange", exact: true })
          .click();
        await expect
          .poll(async () => (await readGraph(synthetic)).nodes[0]?.color)
          .toBe("#e35b00");
        await expect(
          palette.getByRole("button", { name: "orange", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("Escape");
      },
    );
    await step("independent remote mutation arrives through SSE", async () => {
      const before = await readGraph(synthetic);
      await sendCommand(synthetic, before.revision, {
        type: "node.put",
        node: {
          id: "release-smoke-remote",
          title: "Remote release intention",
          description: "Synthetic independent HTTP client.",
          project: "release-smoke",
          status: "idea",
          color: "#8672fd",
          sources: [],
        },
      });
      await expect(page.getByRole("application")).toHaveAttribute(
        "data-revision",
        String(before.revision + 1),
      );
      await page.getByLabel("Find intentions").fill("Remote release intention");
      await page.getByLabel("Find intentions").press("Enter");
      await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
        "Remote release intention",
      );
      const palette = page.getByRole("group", { name: "Color", exact: true });
      await expect(
        palette.getByRole("button", { name: "violet", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const painted = await readGraph(synthetic);
      await sendCommand(synthetic, painted.revision, {
        type: "node.paint",
        colors: [{ id: "release-smoke-remote", color: null }],
      });
      await expect(
        palette.getByRole("button", { name: "Status color", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });
    await step("lock revokes access and owner login restores it", async () => {
      await page.getByRole("button", { name: "Lock", exact: true }).click();
      await expect(page.getByLabel("Owner access token")).toBeVisible();
      assert.equal(
        await page.evaluate(async () => (await fetch("/api/graph")).status),
        401,
      );
      await unlock(page);
    });
    await expect
      .poll(
        async () =>
          (await synthetic.json<Layout>("/api/layout")).positions.length,
      )
      .toBe(2);
    const layout = await synthetic.json<Layout>("/api/layout");
    await step("graceful native shutdown flushes the session", () =>
      client!.close(),
    );
    client = undefined;
    client = await step("packaged app restarts through renderer CDP", () =>
      launch(synthetic.origin, userData, captureLog),
    );
    await step(
      "restart restores owner cookie and saved graph layout",
      async () => {
        await live(client!.page);
        await expect(client!.page.getByLabel("Owner access token")).toHaveCount(
          0,
        );
        assert.deepEqual(
          await client!.page.evaluate(async () => {
            const response = await fetch("/api/layout");
            if (!response.ok)
              throw new Error(`Layout read failed (${response.status}).`);
            return response.json();
          }),
          layout,
        );
        await expect(client!.page.getByRole("application")).toHaveAttribute(
          "data-revision",
          String((await readGraph(synthetic)).revision),
        );
        await client!.page
          .getByLabel("Find intentions")
          .fill("Edited release intention");
        await client!.page.getByLabel("Find intentions").press("Enter");
        await expect(
          client!.page
            .getByRole("group", { name: "Color", exact: true })
            .getByRole("button", { name: "orange", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        await client!.page.keyboard.press("Escape");
        await client!.page.keyboard.press("Escape");
        await client!.page.screenshot({
          path: join(artifacts, "release-smoke.png"),
        });
      },
    );
  } catch (error) {
    failure = error;
    console.error(sanitize(String(error)));
    console.error(nativeOutput);
    if (server) console.error(sanitize(server.logs()));
    if (client && !client.page.isClosed())
      await client.page
        .screenshot({ path: join(artifacts, "release-smoke-failure.png") })
        .catch(() => {});
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        await step("final native shutdown", () => client!.close());
      } catch (error) {
        failure ??= error;
        process.exitCode = 1;
        console.error(sanitize(String(error)));
      }
    }
    await server?.stop();
    await rm(userData, { recursive: true, force: true });
    await writeFile(
      join(artifacts, "release-smoke.json"),
      `${JSON.stringify({ passed: failure === undefined, executable: basename(executable), automation: "renderer CDP; no main Node inspector", data: "disposable synthetic loopback server and profile", timings, ...(failure === undefined ? {} : { error: sanitize(String(failure)), nativeOutput }) }, null, 2)}\n`,
    );
  }
}

await main();

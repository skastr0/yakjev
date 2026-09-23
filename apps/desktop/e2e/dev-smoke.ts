#!/usr/bin/env bun
// Real Vite + Electron + disposable server. Uses the checked-in renderer
// configuration, changes no web source, and verifies a live HMR message.
// Build main/preload first, then: bun apps/desktop/e2e/dev-smoke.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer } from "vite";
import desktopConfig from "../electron.vite.config";
import {
  acceptanceToken,
  startServer,
} from "../../../tests/acceptance/harness";
import { launchEnvironment } from "./environment";

const desktopRoot = resolve(import.meta.dir, "..");
const artifacts = join(desktopRoot, "artifacts");
const userData = await mkdtemp(join(tmpdir(), "yakjev-desktop-dev-smoke-"));
const server = await startServer();
assert(desktopConfig.renderer, "desktop renderer configuration must exist");
const vite = await createServer({
  ...desktopConfig.renderer,
  configFile: false,
});
let app: ElectronApplication | undefined;
let page: Page | undefined;
let failure: unknown;
const messages: string[] = [];
const started = performance.now();
let connectedMs: number | undefined;
let hmrMs: number | undefined;
let shutdownMs: number | undefined;

try {
  await mkdir(artifacts, { recursive: true });
  await vite.listen();
  app = await _electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [desktopRoot],
    cwd: desktopRoot,
    env: {
      ...launchEnvironment(userData),
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5174",
      YAKJEV_REMOTE_URL: server.origin,
    },
    timeout: 30_000,
  });
  page = await app.firstWindow();
  page.on("console", (message) => messages.push(message.text()));
  page.on("pageerror", (error) => messages.push(String(error)));
  await expect(page).toHaveURL(`${server.origin}/`);
  await page.getByLabel("Owner access token").fill(acceptanceToken);
  await page.getByRole("button", { name: "Unlock graph" }).click();
  await expect(
    page.locator('.connection-status[data-state="live"]'),
  ).toBeVisible();
  await expect(page.getByRole("application")).toBeVisible();
  await expect(page.locator('script[src="/@vite/client"]')).toHaveCount(1);
  connectedMs = Math.round(performance.now() - started);

  await page.evaluate(async () => {
    const path = "/@vite/client";
    const client = await import(path);
    client
      .createHotContext("/yakjev-smoke")
      .on("yakjev:smoke", (data: unknown) => {
        Object.assign(window, { __yakjevHmrSmoke: data });
      });
  });
  const nonce = crypto.randomUUID();
  const hmrStarted = performance.now();
  await expect
    .poll(
      async () => {
        // Send until the Vite client finishes its connection handshake. The test
        // succeeds only when the browser receives bytes over the real websocket.
        vite.ws.send({ type: "custom", event: "yakjev:smoke", data: nonce });
        return page!.evaluate(
          () => (window as unknown as Record<string, unknown>).__yakjevHmrSmoke,
        );
      },
      { timeout: 10_000 },
    )
    .toBe(nonce);
  hmrMs = Math.round(performance.now() - hmrStarted);
  await page.screenshot({ path: join(artifacts, "desktop-dev-smoke.png") });
  console.log(`PASS dev renderer login and graph (${connectedMs} ms)`);
  console.log(`PASS Vite HMR websocket delivered a custom event (${hmrMs} ms)`);
} catch (error) {
  failure = error;
  console.error(error);
  console.error(messages.join("\n"));
  console.error(server.logs());
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: join(artifacts, "desktop-dev-smoke-failure.png") })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  const closeStarted = performance.now();
  await app?.close().catch(() => {});
  shutdownMs = Math.round(performance.now() - closeStarted);
  console.log(`TIMING dev shutdown (${shutdownMs} ms)`);
  await vite.close();
  await server.stop();
  await rm(userData, { recursive: true, force: true });
  await writeFile(
    join(artifacts, "desktop-dev-smoke.json"),
    `${JSON.stringify(
      {
        passed: failure === undefined,
        connectedMs,
        hmrMs,
        shutdownMs,
        messages,
        ...(failure === undefined ? {} : { error: String(failure) }),
      },
      null,
      2,
    )}\n`,
  );
}

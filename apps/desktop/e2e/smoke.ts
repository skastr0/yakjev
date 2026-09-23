#!/usr/bin/env bun
// Opt-in, real Electron + the existing server on disposable synthetic data.
// Run from the repository root: bun run --cwd apps/desktop smoke
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  _electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { WebPreferences } from "electron";
import type { Layout } from "../../../packages/protocol/src/index";
import { readGraph, sendCommand } from "../../../tests/acceptance/contract";
import {
  acceptanceToken,
  startServer,
} from "../../../tests/acceptance/harness";

const desktopRoot = resolve(import.meta.dir, "..");
const artifacts = join(desktopRoot, "artifacts");
const executablePath: string = createRequire(import.meta.url)("electron");
const timings: { step: string; ms: number }[] = [];

async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await action();
  const ms = Math.round(performance.now() - start);
  timings.push({ step: name, ms });
  console.log(`PASS ${name} (${ms} ms)`);
  return result;
}

function launchEnvironment(userData: string): Record<string, string> {
  // Preserve only OS facilities needed by Electron. Provider, owner, and
  // deployment credentials cannot enter either disposable child process.
  const env: Record<string, string> = {
    NODE_ENV: "test",
    YAKJEV_DESKTOP_USER_DATA: userData,
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function productWindow(
  app: ElectronApplication,
  origin: string,
): Promise<Page> {
  await expect
    .poll(() => app.windows().some((page) => page.url().startsWith(origin)), {
      timeout: 20_000,
      message: "the product window must load at the selected server origin",
    })
    .toBe(true);
  const page = app.windows().find((item) => item.url().startsWith(origin));
  assert(page, "product window disappeared");
  page.setDefaultTimeout(15_000);
  return page;
}

async function unlock(page: Page): Promise<void> {
  await page.getByLabel("Owner access token").fill(acceptanceToken);
  await page.getByRole("button", { name: "Unlock graph" }).click();
  await expect(
    page.locator('.connection-status[data-state="live"]'),
  ).toBeVisible();
  await expect(page.getByRole("application")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
}

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "yakjev-desktop-smoke-"));
  const server = await startServer();
  const navigationRequests: string[] = [];
  const forbiddenTarget = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      navigationRequests.push(request.url);
      return new Response("This origin must never receive a desktop request.");
    },
  });
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let failure: unknown;
  const launch = () =>
    _electron.launch({
      executablePath,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: launchEnvironment(userData),
      timeout: 30_000,
    });
  try {
    await step("first-run connection and owner login", async () => {
      app = await launch();
      const setup = await app.firstWindow();
      page = setup;
      await setup.getByLabel("Server address").fill(server.origin);
      await setup.screenshot({
        path: join(artifacts, "desktop-connection.png"),
      });
      await setup.getByRole("button", { name: "Open Yakjev" }).click();
      page = await productWindow(app, server.origin);
      await unlock(page);
    });
    assert(app && page);
    const desktop = app;
    const product = page;

    await step("product renderer isolation", async () => {
      const paths = await desktop.evaluate(({ app }) => ({
        userData: app.getPath("userData"),
        sessionData: app.getPath("sessionData"),
      }));
      assert.equal(paths.userData, userData);
      assert(
        paths.sessionData === userData ||
          paths.sessionData.startsWith(`${userData}${sep}`),
        "Chromium session data must stay inside the disposable profile",
      );
      const preferences = await desktop.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().startsWith("http"),
        );
        if (!window) throw new Error("no product BrowserWindow");
        // Electron exposes this diagnostic at runtime but omits it from its
        // public types. Fail explicitly if a future Electron removes it.
        const contents = window.webContents as typeof window.webContents & {
          getLastWebPreferences?: () => WebPreferences;
        };
        if (typeof contents.getLastWebPreferences !== "function") {
          throw new Error(
            "Electron no longer exposes its renderer preferences diagnostic",
          );
        }
        const settings = contents.getLastWebPreferences();
        return {
          sandbox: settings.sandbox,
          contextIsolation: settings.contextIsolation,
          nodeIntegration: settings.nodeIntegration,
          webSecurity: settings.webSecurity,
          preload: settings.preload ?? "",
        };
      });
      assert.deepEqual(preferences, {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: "",
      });
      const globals = await product.evaluate(() => ({
        require: typeof (window as unknown as Record<string, unknown>)[
          "require"
        ],
        process: typeof (window as unknown as Record<string, unknown>)[
          "process"
        ],
        bridges: Object.keys(window).filter((key) =>
          /electron|desktop/i.test(key),
        ),
      }));
      assert.deepEqual(globals, {
        require: "undefined",
        process: "undefined",
        bridges: [],
      });
      assert.equal(await product.evaluate(() => document.cookie), "");
    });

    const created = await step(
      "rendered capture writes to the server",
      async () => {
        await product.keyboard.press("c");
        await product
          .getByLabel("Intention", { exact: true })
          .fill("Synthetic desktop intention");
        await product.getByLabel("Intention", { exact: true }).press("Enter");
        await expect
          .poll(async () => (await readGraph(server)).nodes.length)
          .toBe(1);
        const node = (await readGraph(server)).nodes[0];
        assert(node);
        assert.equal(node.title, "Synthetic desktop intention");
        await expect(product.getByLabel("Title", { exact: true })).toHaveValue(
          node.title,
        );
        await product
          .getByLabel("Title", { exact: true })
          .fill("Desktop edited intention");
        await product.getByLabel("Title", { exact: true }).press("Tab");
        await expect
          .poll(async () => (await readGraph(server)).nodes[0]?.title)
          .toBe("Desktop edited intention");
        return node.id;
      },
    );

    await step(
      "remote graph change reaches the renderer over SSE",
      async () => {
        const before = await readGraph(server);
        await sendCommand(server, before.revision, {
          type: "node.put",
          node: {
            id: "desktop-smoke-remote",
            title: "Synthetic remote intention",
            description: "Created by an independent HTTP client.",
            project: "desktop-smoke",
            status: "idea",
            sources: [
              {
                uri: "https://example.com/desktop-smoke",
                label: "Desktop smoke source",
              },
            ],
          },
        });
        const after = await readGraph(server);
        await expect(product.getByRole("application")).toHaveAttribute(
          "data-revision",
          String(after.revision),
        );
        await product
          .getByLabel("Find intentions")
          .fill("Synthetic remote intention");
        await product.getByLabel("Find intentions").press("Enter");
        await expect(product.getByLabel("Title", { exact: true })).toHaveValue(
          "Synthetic remote intention",
        );
        await product.keyboard.press("Escape");
        await product.keyboard.press("Escape");
      },
    );

    const savedLayout = await step(
      "native drag persists layout on the server",
      async () => {
        await expect
          .poll(
            async () =>
              (await server.json<Layout>("/api/layout")).positions.length,
          )
          .toBe(2);
        const before = await server.json<Layout>("/api/layout");
        const initial = before.positions.find((point) => point.id === created);
        assert(initial);
        const point = await product.evaluate(
          (id) => window.__yakjevCanvas?.anchorNode(id),
          created,
        );
        assert(point, "created node must have a rendered canvas position");
        await product.keyboard.down("Alt");
        await product.mouse.move(point.x, point.y);
        await product.mouse.down();
        await product.mouse.move(point.x + 110, point.y + 75, { steps: 12 });
        await product.mouse.up();
        await product.keyboard.up("Alt");
        await expect
          .poll(
            async () => {
              const saved = (
                await server.json<Layout>("/api/layout")
              ).positions.find((item) => item.id === created);
              return saved
                ? Math.hypot(saved.x - initial.x, saved.y - initial.y)
                : 0;
            },
            { timeout: 10_000 },
          )
          .toBeGreaterThan(0.1);
        return server.json<Layout>("/api/layout");
      },
    );

    await step(
      "logout revokes browser access and login restores it",
      async () => {
        await product
          .getByRole("button", { name: "Lock", exact: true })
          .click();
        await expect(product.getByLabel("Owner access token")).toBeVisible();
        assert.equal(
          await product.evaluate(
            async () => (await fetch("/api/graph")).status,
          ),
          401,
        );
        await unlock(product);
      },
    );

    await step(
      "source links use the browser; unsafe navigation and private assets are denied",
      async () => {
        await desktop.evaluate(({ shell }) => {
          const state = globalThis as typeof globalThis & {
            __yakjevSmokeExternal?: {
              calls: string[];
              original: typeof shell.openExternal;
            };
          };
          const calls: string[] = [];
          state.__yakjevSmokeExternal = { calls, original: shell.openExternal };
          shell.openExternal = async (url) => {
            calls.push(url);
          };
        });
        await product
          .getByLabel("Find intentions")
          .fill("Synthetic remote intention");
        await product.getByLabel("Find intentions").press("Enter");
        await product
          .getByRole("link", { name: "Desktop smoke source" })
          .click();
        const originalUrl = product.url();
        const target = `http://127.0.0.1:${forbiddenTarget.port}/forbidden`;
        await product.evaluate((url) => {
          const link = document.createElement("a");
          link.href = url;
          link.textContent = "Synthetic navigation test";
          document.body.append(link);
          link.click();
          link.remove();
          for (const unsafe of [
            "file:///tmp/yakjev-smoke-forbidden",
            "javascript:alert('forbidden')",
            "yakjev://desktop/index.html",
            "https://name:password@example.com/forbidden",
          ])
            window.open(unsafe, "_blank");
        }, target);
        // Allow navigation and window events to be processed before checking the
        // independent server. This is a security observation, not a speed gate.
        await product.waitForTimeout(300);
        assert.equal(product.url(), originalUrl);
        assert.equal(desktop.windows().length, 1);
        assert.deepEqual(navigationRequests, []);
        const external = await desktop.evaluate(({ shell }) => {
          const state = globalThis as typeof globalThis & {
            __yakjevSmokeExternal?: {
              calls: string[];
              original: typeof shell.openExternal;
            };
          };
          const captured = state.__yakjevSmokeExternal;
          if (!captured) throw new Error("missing external-link observation");
          shell.openExternal = captured.original;
          delete state.__yakjevSmokeExternal;
          return captured.calls;
        });
        assert.deepEqual(external, ["https://example.com/desktop-smoke"]);
        for (const path of [
          "/package.json",
          "/.env",
          "/.git/config",
          "/src/main.ts",
          "/%2e%2e%2fpackage.json",
        ]) {
          const status = await product.evaluate(
            async (url) => (await fetch(url)).status,
            path,
          );
          assert(status >= 400, `${path} must be denied, received ${status}`);
        }
        await product.keyboard.press("Escape");
        await product.keyboard.press("Escape");
      },
    );

    await step(
      "restart restores the connection, owner cookie, and saved layout",
      async () => {
        await desktop.close();
        app = await launch();
        page = await productWindow(app, server.origin);
        await expect(
          page.locator('.connection-status[data-state="live"]'),
        ).toBeVisible();
        await expect(page.getByRole("application")).toBeVisible();
        await expect(page.getByLabel("Owner access token")).toHaveCount(0);
        const loadedLayout = await page.evaluate(async () => {
          const response = await fetch("/api/layout");
          if (!response.ok)
            throw new Error(`layout read failed: ${response.status}`);
          return response.json();
        });
        assert.deepEqual(loadedLayout, savedLayout);
        await expect(page.getByRole("application")).toHaveAttribute(
          "data-revision",
          String((await readGraph(server)).revision),
        );
        await page.screenshot({ path: join(artifacts, "desktop-smoke.png") });
      },
    );
  } catch (error) {
    failure = error;
    if (page && !page.isClosed()) {
      await page
        .screenshot({ path: join(artifacts, "desktop-smoke-failure.png") })
        .catch(() => {});
    }
    console.error(error);
    console.error(server.logs());
    process.exitCode = 1;
  } finally {
    await app?.close().catch(() => {});
    await forbiddenTarget.stop(true);
    await server.stop();
    await rm(userData, { recursive: true, force: true });
    await writeFile(
      join(artifacts, "desktop-smoke.json"),
      `${JSON.stringify(
        {
          passed: failure === undefined,
          timings,
          ...(failure === undefined ? {} : { error: String(failure) }),
        },
        null,
        2,
      )}\n`,
    );
  }
}

await main();

#!/usr/bin/env bun
// Real Electron and an independent browser share a disposable synthetic server.
// Build web + desktop first, then: bun apps/desktop/e2e/color-smoke.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron,
  chromium,
  expect,
  type Browser,
  type ElectronApplication,
  type Page,
  type Request as BrowserRequest,
} from "@playwright/test";
import { readGraph, sendCommand } from "../../../tests/acceptance/contract";
import {
  acceptanceToken,
  startServer,
  type ServerHandle,
} from "../../../tests/acceptance/harness";
import { launchEnvironment } from "./environment";

const desktopRoot = resolve(import.meta.dir, "..");
const artifacts = join(desktopRoot, "artifacts");
const legacyKey = "yakjev.nodePaint";
const palette = {
  red: "#ed4968",
  orange: "#e35b00",
  amber: "#b27c00",
  olive: "#7e8f00",
  green: "#159b05",
  jade: "#009969",
  teal: "#00959c",
  sky: "#008ecc",
  blue: "#2c84ff",
  violet: "#8672fd",
  purple: "#bb5ede",
  magenta: "#dd51ad",
} as const;
const ids = {
  browser: "color-browser-legacy",
  desktop: "color-desktop-legacy",
  status: "color-explicit-status",
  explicit: "color-explicit-paint",
};
const titles = {
  browser: "Synthetic browser color",
  desktop: "Synthetic desktop color",
  status: "Synthetic status color",
  explicit: "Synthetic existing color",
};
const unmatchedLegacy = { "unmatched-synthetic-node": palette.red };
const timings: { step: string; ms: number }[] = [];
const diagnostics: string[] = [];
const renderedColors: Record<string, string> = {};
const lockObservations: {
  client: string;
  requestsWhileLocked: string[];
  observedMs: number;
}[] = [];
const shutdowns: {
  phase: "restart" | "final";
  graceful: boolean;
  ms: number;
  reason?: string;
}[] = [];

async function closeDesktop(
  app: ElectronApplication,
  phase: "restart" | "final",
) {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graceful = false;
  let reason = "Graceful shutdown exceeded 15000 ms";
  try {
    graceful = await Promise.race([
      app.close().then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), 15_000);
      }),
    ]);
  } catch (error) {
    reason = String(error);
  } finally {
    clearTimeout(timer);
  }
  if (!graceful) {
    // app.process() is exactly the child this smoke launched, never an installed
    // Yakjev instance. The receipt keeps forced termination separate from color
    // persistence: graph colors must survive either kind of process restart.
    const child = app.process();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit, reject) => {
        const deadline = setTimeout(
          () =>
            reject(
              new Error("Owned Electron child did not exit after SIGKILL"),
            ),
          5_000,
        );
        child.once("exit", () => {
          clearTimeout(deadline);
          resolveExit();
        });
        child.kill("SIGKILL");
      });
    }
    console.warn(
      `LIMITATION ${phase}: ${reason}; terminated only the owned synthetic Electron child`,
    );
  }
  shutdowns.push({
    phase,
    graceful,
    ms: Math.round(performance.now() - started),
    ...(graceful ? {} : { reason }),
  });
}

// Read the screenshot, not Sigma's graph projection or the color algorithm.
// The existing acceptance hook supplies only the on-screen node position.
async function renderedColor(page: Page, id: string): Promise<string> {
  const point = await page.evaluate(
    (id) => window.__yakjevCanvas?.anchorNode(id),
    id,
  );
  assert(point, `node ${id} must have a rendered position`);
  const png = await page.screenshot({
    clip: {
      x: Math.floor(point.x) - 1,
      y: Math.floor(point.y) - 1,
      width: 2,
      height: 2,
    },
    scale: "css",
  });
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(bytes)], { type: "image/png" }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot decoding requires a 2D canvas");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    bitmap.close();
    const channels = [0, 1, 2].map((channel) => {
      let sum = 0;
      for (let index = channel; index < pixels.length; index += 4)
        sum += pixels[index]!;
      return Math.round(sum / (pixels.length / 4))
        .toString(16)
        .padStart(2, "0");
    });
    return `#${channels.join("")}`;
  }, Array.from(png));
}

function colorDistance(left: string, right: string): number {
  return Math.hypot(
    ...[1, 3, 5].map(
      (start) =>
        Number.parseInt(left.slice(start, start + 2), 16) -
        Number.parseInt(right.slice(start, start + 2), 16),
    ),
  );
}

async function clearCanvasOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByLabel("Find intentions").fill("");
  await page.getByLabel("Find intentions").press("Escape");
  await page.mouse.move(10, 10);
}

async function failedLock(
  page: Page,
  server: ServerHandle,
  client: string,
  nativeFault?: (fault: LockFault | undefined) => void,
): Promise<void> {
  await currentRevision(page, server);
  let releaseResponse = () => {};
  const responseReady = new Promise<void>((resolveResponse) => {
    releaseResponse = resolveResponse;
  });
  let requestStarted = () => {};
  const requestReady = new Promise<void>((resolveRequest) => {
    requestStarted = resolveRequest;
  });
  const requests: string[] = [];
  const observeRequest = (request: BrowserRequest) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) requests.push(`${request.method()} ${path}`);
  };
  if (nativeFault) nativeFault({ requests, requestStarted, responseReady });
  else {
    await page.route("**/api/session", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      requestStarted();
      await responseReady;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic sign-out outage" }),
      });
    });
    page.on("request", observeRequest);
  }
  try {
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await Promise.race([
      requestReady,
      page.waitForTimeout(5_000).then(() => {
        throw new Error("Lock did not send DELETE /api/session");
      }),
    ]);
    await expect(page.getByRole("application")).toHaveCount(0);
    await expect(
      page.getByText("Closing your graph…", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Owner access token")).toHaveCount(0);
    // A remote journal event while DELETE is pending must not revive SSE reads.
    await sendCommand(server, (await readGraph(server)).revision, {
      type: "capture",
      capture: {
        id: `lock-probe-${client}`,
        text: "Synthetic event while locked",
        sources: [],
        nodeIds: [],
      },
      nodes: [],
      edges: [],
      autoConnect: false,
    });
    releaseResponse();
    await expect(page.getByRole("alert")).toContainText(
      "server sign-out could not be confirmed",
    );
    await expect(page.getByLabel("Owner access token")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry connection" }),
    ).toBeVisible();
    await expect(page.getByRole("application")).toHaveCount(0);
    await page.evaluate(
      ({ key, paint }) => localStorage.setItem(key, JSON.stringify(paint)),
      {
        key: legacyKey,
        paint: { [ids.status]: palette.green },
      },
    );
    // Observe delayed effects too; this is an inactivity check, not a speed SLA.
    const observed = performance.now();
    await page.waitForTimeout(750);
    await expect(page.getByRole("application")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText(
      "server sign-out could not be confirmed",
    );
    assert.deepEqual(
      requests,
      ["DELETE /api/session"],
      "failed Lock must not resume reads, writes, or migration",
    );
    assert.deepEqual(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
        legacyKey,
      ),
      { [ids.status]: palette.green },
    );
    lockObservations.push({
      client,
      requestsWhileLocked: [...requests],
      observedMs: Math.round(performance.now() - observed),
    });
    await page.screenshot({
      path: join(artifacts, `color-smoke-lock-${client}.png`),
    });
  } finally {
    releaseResponse();
    if (nativeFault) nativeFault(undefined);
    else {
      page.off("request", observeRequest);
      await page.unroute("**/api/session");
    }
  }
  // Only an explicit recovery reconnects the still-valid synthetic server cookie.
  await page.getByRole("button", { name: "Retry connection" }).click();
  await live(page);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), legacyKey))
    .toBe(null);
  await currentRevision(page, server);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByLabel("Owner access token")).toBeVisible();
  await expect(page.getByRole("application")).toHaveCount(0);
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/graph")).status),
    401,
  );
  await unlock(page);
  await currentRevision(page, server);
}

type LockFault = {
  requests: string[];
  requestStarted: () => void;
  responseReady: Promise<void>;
};

async function step(name: string, action: () => Promise<void>): Promise<void> {
  const started = performance.now();
  await action();
  const ms = Math.round(performance.now() - started);
  timings.push({ step: name, ms });
  console.log(`PASS ${name} (${ms} ms)`);
}

async function live(page: Page): Promise<void> {
  await expect(
    page.locator('.connection-status[data-state="live"]'),
  ).toBeVisible();
  await expect(page.getByRole("application")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
}

async function unlock(page: Page): Promise<void> {
  await page.getByLabel("Owner access token").fill(acceptanceToken);
  await page.getByRole("button", { name: "Unlock graph" }).click();
  await live(page);
}

async function select(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByLabel("Find intentions").fill(title);
  await page.getByLabel("Find intentions").press("Enter");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(title);
}

function swatch(page: Page, name: string) {
  return page
    .getByRole("group", { name: "Color", exact: true })
    .getByRole("button", { name, exact: true });
}

async function selected(page: Page, color: string): Promise<void> {
  await expect(swatch(page, color)).toHaveAttribute("aria-pressed", "true");
}

async function currentRevision(
  page: Page,
  server: ServerHandle,
): Promise<void> {
  await expect(page.getByRole("application")).toHaveAttribute(
    "data-revision",
    String((await readGraph(server)).revision),
  );
}

async function expectColor(
  server: ServerHandle,
  id: string,
  color: string | null,
) {
  await expect
    .poll(
      async () =>
        (await readGraph(server)).nodes.find((node) => node.id === id)?.color,
    )
    .toBe(color);
}

function observe(page: Page, label: string) {
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) =>
    diagnostics.push(`${label}: ${String(error)}`),
  );
}

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const profileRoot = await mkdtemp(join(tmpdir(), "yakjev-color-smoke-"));
  const userData = join(profileRoot, "desktop");
  const browserEnvironment = launchEnvironment(join(profileRoot, "browser"));
  const browserExecutable = [
    process.env.YAKJEV_COLOR_BROWSER_EXECUTABLE,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => path !== undefined && existsSync(path));
  let server: ServerHandle | undefined;
  let app: ElectronApplication | undefined;
  let browser: Browser | undefined;
  let desktopPage: Page | undefined;
  let browserPage: Page | undefined;
  let failure: unknown;
  const restart: { closeMs?: number; launchMs?: number; restoreMs?: number } =
    {};
  let shutdownMs: number | undefined;
  let stopProxy: (() => void | Promise<void>) | undefined;

  try {
    assert(
      browserExecutable,
      "Install the existing Playwright browser or set YAKJEV_COLOR_BROWSER_EXECUTABLE",
    );
    server = await startServer();
    const local = server;
    let nativeFault: LockFault | undefined;
    // Electron forwards API traffic in its native session, outside Playwright's
    // renderer request routing. Inject the desktop fault at a real, disposable
    // HTTP boundary; the existing acceptance server remains the only graph store.
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const fault = nativeFault;
        if (fault && url.pathname.startsWith("/api/")) {
          fault.requests.push(`${request.method} ${url.pathname}`);
          if (request.method === "DELETE" && url.pathname === "/api/session") {
            fault.requestStarted();
            await fault.responseReady;
            return Response.json(
              { error: "Synthetic sign-out outage" },
              { status: 503 },
            );
          }
        }
        const headers = new Headers(request.headers);
        headers.delete("host");
        if (headers.has("origin")) headers.set("origin", local.origin);
        return fetch(new URL(`${url.pathname}${url.search}`, local.origin), {
          method: request.method,
          headers,
          redirect: "manual",
          signal: request.signal,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? null
              : await request.arrayBuffer(),
        });
      },
    });
    stopProxy = () => proxy.stop(true);
    const desktopOrigin = `http://127.0.0.1:${proxy.port}`;
    const launch = () =>
      _electron.launch({
        executablePath: createRequire(import.meta.url)("electron"),
        args: [desktopRoot],
        cwd: desktopRoot,
        env: {
          ...launchEnvironment(userData),
          YAKJEV_REMOTE_URL: desktopOrigin,
        },
        timeout: 30_000,
      });
    const product = async (desktop: ElectronApplication) => {
      await expect
        .poll(
          () =>
            desktop
              .windows()
              .some((page) => page.url() === `${desktopOrigin}/`),
          {
            timeout: 20_000,
          },
        )
        .toBe(true);
      const page = desktop
        .windows()
        .find((page) => page.url() === `${desktopOrigin}/`);
      assert(page);
      observe(page, "desktop");
      await page.emulateMedia({ reducedMotion: "reduce" });
      return page;
    };

    await step("seed synthetic graph without providers", async () => {
      const initial = await readGraph(local);
      const relation = initial.taxonomy.relations.find(
        (item) => !item.blocking,
      );
      assert(
        relation,
        "fixture needs a nonblocking relation for color blending",
      );
      await sendCommand(local, initial.revision, {
        type: "capture",
        capture: {
          id: "color-smoke-capture",
          text: "Synthetic color integration",
          sources: [],
          nodeIds: Object.values(ids),
        },
        nodes: (Object.keys(ids) as (keyof typeof ids)[]).map((key) => ({
          id: ids[key],
          title: titles[key],
          description: "Disposable color smoke fixture",
          project: "Color smoke",
          status: "idea",
          sources: [],
          ...(key === "status"
            ? { color: null }
            : key === "explicit"
              ? { color: palette.violet }
              : {}),
        })),
        edges: [
          {
            id: "color-smoke-edge",
            source: ids.browser,
            target: ids.desktop,
            relation: relation.id,
            rationale: "Synthetic blend evidence",
          },
        ],
        autoConnect: false,
      });
      const layoutResponse = await local.fetch("/api/layout", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positions: [
            { id: ids.browser, x: -200, y: 0 },
            { id: ids.desktop, x: 200, y: 0 },
            { id: ids.status, x: -200, y: 240 },
            { id: ids.explicit, x: 200, y: 240 },
          ],
        }),
      });
      assert(layoutResponse.ok, `layout seed failed: ${layoutResponse.status}`);
    });

    await step(
      "desktop migrates its local legacy color to the server",
      async () => {
        app = await launch();
        desktopPage = await product(app);
        await expect(
          desktopPage.getByLabel("Owner access token"),
        ).toBeVisible();
        await desktopPage.evaluate(
          ({ key, paint }) => localStorage.setItem(key, JSON.stringify(paint)),
          {
            key: legacyKey,
            paint: { [ids.desktop]: palette.teal },
          },
        );
        await unlock(desktopPage);
        await expectColor(local, ids.desktop, palette.teal);
        await expect
          .poll(() =>
            desktopPage!.evaluate(
              (key) => localStorage.getItem(key),
              legacyKey,
            ),
          )
          .toBe(null);
        await select(desktopPage, titles.browser);
        await selected(desktopPage, "Status color");
      },
    );
    assert(desktopPage);
    const desktop = desktopPage;

    await step(
      "browser migration crosses SSE and respects existing server colors",
      async () => {
        browser = await chromium.launch({
          executablePath: browserExecutable,
          headless: true,
          env: browserEnvironment,
        });
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          reducedMotion: "reduce",
        });
        browserPage = await context.newPage();
        observe(browserPage, "browser");
        await browserPage.goto(local.origin);
        await expect(
          browserPage.getByLabel("Owner access token"),
        ).toBeVisible();
        await browserPage.evaluate(
          ({ key, paint }) => localStorage.setItem(key, JSON.stringify(paint)),
          {
            key: legacyKey,
            paint: {
              [ids.browser]: palette.red.toUpperCase(),
              [ids.desktop]: palette.green,
              [ids.status]: palette.amber,
              [ids.explicit]: palette.green,
              ...unmatchedLegacy,
            },
          },
        );
        let migrationRejected = false;
        await browserPage.route("**/api/commands", async (route) => {
          const request = route.request().postDataJSON() as {
            command?: { type?: string; onlyIfUnset?: boolean };
          };
          if (
            !migrationRejected &&
            request.command?.type === "node.paint" &&
            request.command.onlyIfUnset
          ) {
            migrationRejected = true;
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "Synthetic migration outage" }),
            });
          } else await route.continue();
        });
        await unlock(browserPage);
        await expect(
          browserPage.getByRole("button", { name: "Retry saving colors" }),
        ).toBeVisible();
        assert(
          migrationRejected,
          "exercise an actual failed migration request",
        );
        assert.equal(
          (await readGraph(local)).nodes.find((node) => node.id === ids.browser)
            ?.color,
          undefined,
        );
        const retained = await browserPage.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          legacyKey,
        );
        assert.equal(retained[ids.browser], palette.red.toUpperCase());
        await browserPage
          .getByRole("button", { name: "Retry saving colors" })
          .click();
        await expectColor(local, ids.browser, palette.red);
        await expect(
          browserPage.getByRole("button", { name: "Retry saving colors" }),
        ).toHaveCount(0);
        await browserPage.unroute("**/api/commands");
        await expectColor(local, ids.desktop, palette.teal);
        await expectColor(local, ids.status, null);
        await expectColor(local, ids.explicit, palette.violet);
        await expect
          .poll(() =>
            browserPage!.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              legacyKey,
            ),
          )
          .toEqual(unmatchedLegacy);
        await selected(desktop, "red");
        await currentRevision(desktop, local);
        await select(browserPage, titles.browser);
        await selected(browserPage, "red");
      },
    );
    assert(browserPage);
    const web = browserPage;

    await step(
      "undoing a legacy import does not resurrect it on reload",
      async () => {
        const before = await readGraph(local);
        await clearCanvasOverlays(web);
        await web.keyboard.press(
          process.platform === "darwin" ? "Meta+z" : "Control+z",
        );
        await expectColor(local, ids.browser, null);
        assert.equal((await readGraph(local)).revision, before.revision + 1);
        await selected(desktop, "Status color");
        // Simulate an older offline client returning with the pre-Undo paint.
        // Explicit null on the server must retire that stale entry as well.
        await web.evaluate(
          ({ key, paint }) => localStorage.setItem(key, JSON.stringify(paint)),
          {
            key: legacyKey,
            paint: { ...unmatchedLegacy, [ids.browser]: palette.red },
          },
        );
        await web.reload();
        await live(web);
        await expect
          .poll(() =>
            web.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              legacyKey,
            ),
          )
          .toEqual(unmatchedLegacy);
        await expectColor(local, ids.browser, null);
        assert.equal((await readGraph(local)).revision, before.revision + 1);
        await select(web, titles.browser);
        await selected(web, "Status color");
      },
    );

    await step(
      "browser picker reaches the live desktop without reload",
      async () => {
        await swatch(web, "orange").click();
        await expectColor(local, ids.browser, palette.orange);
        await selected(desktop, "orange");
        await currentRevision(desktop, local);
        await live(desktop);
      },
    );

    await step("desktop picker reaches the independent browser", async () => {
      await swatch(desktop, "magenta").click();
      await expectColor(local, ids.browser, palette.magenta);
      await selected(web, "magenta");
      await currentRevision(web, local);
    });

    await step("desktop graph undo restores the shared color", async () => {
      const before = await readGraph(local);
      await desktop.keyboard.press("Escape");
      await desktop.keyboard.press("Escape");
      await desktop.keyboard.press(
        process.platform === "darwin" ? "Meta+z" : "Control+z",
      );
      await expectColor(local, ids.browser, palette.orange);
      assert.equal((await readGraph(local)).revision, before.revision + 1);
      await selected(web, "orange");
      await select(desktop, titles.browser);
      await selected(desktop, "orange");
    });

    await step(
      "same-color neighbors retain their actual rendered paint",
      async () => {
        await select(desktop, titles.desktop);
        await swatch(desktop, "orange").click();
        await expectColor(local, ids.desktop, palette.orange);
        await currentRevision(desktop, local);
        await clearCanvasOverlays(desktop);
        for (const id of [ids.browser, ids.desktop]) {
          await expect
            .poll(async () => {
              const color = await renderedColor(desktop, id);
              renderedColors[`same:${id}`] = color;
              return colorDistance(color, palette.orange);
            })
            .toBeLessThan(5);
        }
      },
    );

    await step(
      "status color is explicit and survives stale legacy paint",
      async () => {
        await select(desktop, titles.desktop);
        await swatch(desktop, "Status color").click();
        await expectColor(local, ids.desktop, null);
        await select(web, titles.desktop);
        await selected(web, "Status color");
        await web.evaluate(
          ({ key, paint }) => localStorage.setItem(key, JSON.stringify(paint)),
          {
            key: legacyKey,
            paint: { [ids.desktop]: palette.teal },
          },
        );
        const before = (await readGraph(local)).revision;
        await web.reload();
        await live(web);
        await expect
          .poll(() =>
            web.evaluate((key) => localStorage.getItem(key), legacyKey),
          )
          .toBe(null);
        assert.equal((await readGraph(local)).revision, before);
        await expectColor(local, ids.desktop, null);
      },
    );

    await step("twelve original palette colors remain rendered", async () => {
      await select(desktop, titles.browser);
      const group = desktop.getByRole("group", { name: "Color", exact: true });
      await expect(group.getByRole("button")).toHaveCount(13);
      for (const [name, hex] of Object.entries(palette)) {
        const channels = hex
          .slice(1)
          .match(/../g)!
          .map((channel) => Number.parseInt(channel, 16));
        await expect(swatch(desktop, name)).toHaveCSS(
          "background-color",
          `rgb(${channels.join(", ")})`,
        );
        const box = await swatch(desktop, name).boundingBox();
        assert(box, `${name} swatch must have a rendered box`);
        assert.equal(box.width, 22, `${name} swatch width`);
        assert.equal(box.height, 22, `${name} swatch height`);
        await expect(swatch(desktop, name)).toHaveCSS("border-radius", "50%");
      }
      await selected(desktop, "orange");
      await desktop.screenshot({
        path: join(artifacts, "color-smoke-palette.png"),
      });
    });

    await step(
      "browser failed Lock stays closed until explicit recovery",
      async () => {
        await failedLock(web, local, "browser");
      },
    );
    await step(
      "desktop failed Lock stays closed and normal Lock still revokes access",
      async () => {
        await failedLock(desktop, local, "desktop", (fault) => {
          nativeFault = fault;
        });
      },
    );

    await step(
      "restart retains shared colors and retires local imports",
      async () => {
        assert(app);
        let started = performance.now();
        await closeDesktop(app, "restart");
        app = undefined;
        restart.closeMs = Math.round(performance.now() - started);
        started = performance.now();
        app = await launch();
        restart.launchMs = Math.round(performance.now() - started);
        started = performance.now();
        desktopPage = await product(app);
        await live(desktopPage);
        await expect(desktopPage.getByLabel("Owner access token")).toHaveCount(
          0,
        );
        await select(desktopPage, titles.browser);
        await selected(desktopPage, "orange");
        await select(desktopPage, titles.desktop);
        await selected(desktopPage, "Status color");
        assert.equal(
          await desktopPage.evaluate(
            (key) => localStorage.getItem(key),
            legacyKey,
          ),
          null,
        );
        await currentRevision(desktopPage, local);
        await clearCanvasOverlays(desktopPage);
        await expect
          .poll(async () => {
            renderedColors.isolated = await renderedColor(
              desktopPage!,
              ids.explicit,
            );
            return colorDistance(renderedColors.isolated, palette.violet);
          })
          .toBeLessThan(5);
        renderedColors.blendedOrange = await renderedColor(
          desktopPage,
          ids.browser,
        );
        renderedColors.blendedBlue = await renderedColor(
          desktopPage,
          ids.desktop,
        );
        assert(
          colorDistance(renderedColors.blendedOrange, palette.orange) > 10,
          "orange node must display its neighbor's influence",
        );
        assert(
          colorDistance(renderedColors.blendedBlue, palette.blue) > 10,
          "blue node must display its neighbor's influence",
        );
        assert(
          colorDistance(
            renderedColors.blendedOrange,
            renderedColors.blendedBlue,
          ) > 30,
          "connected nodes retain distinguishable colors",
        );
        await desktopPage.screenshot({
          path: join(artifacts, "color-smoke.png"),
        });
        restart.restoreMs = Math.round(performance.now() - started);
        console.log(`TIMING restart ${JSON.stringify(restart)}`);
      },
    );
    assert.deepEqual(
      diagnostics,
      [],
      "renderers must not raise uncaught errors",
    );
  } catch (error) {
    failure = error;
    process.exitCode = 1;
    console.error(error);
    console.error(diagnostics.join("\n"));
    if (server) console.error(server.logs());
    if (desktopPage && !desktopPage.isClosed()) {
      await desktopPage
        .screenshot({ path: join(artifacts, "color-smoke-failure.png") })
        .catch(() => {});
    }
  } finally {
    const started = performance.now();
    const cleanup = await Promise.allSettled([
      app ? closeDesktop(app, "final") : undefined,
      browser?.close(),
    ]);
    shutdownMs = Math.round(performance.now() - started);
    for (const result of cleanup) {
      if (result.status === "rejected") {
        failure ??= result.reason;
        process.exitCode = 1;
        diagnostics.push(`cleanup: ${String(result.reason)}`);
      }
    }
    await stopProxy?.();
    await server?.stop();
    await rm(profileRoot, { recursive: true, force: true });
    await writeFile(
      join(artifacts, "color-smoke.json"),
      `${JSON.stringify(
        {
          passed: failure === undefined,
          browserExecutable,
          runtime: "local-build",
          timings,
          restart,
          shutdownMs,
          gracefulShutdown: shutdowns.every((item) => item.graceful),
          shutdowns,
          diagnostics,
          renderedColors,
          lockObservations,
          ...(failure === undefined ? {} : { error: String(failure) }),
        },
        null,
        2,
      )}\n`,
    );
  }
}

await main();

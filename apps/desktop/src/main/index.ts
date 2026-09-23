import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { app, dialog, protocol } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";
import { DesktopHost } from "./host";
import { Settings } from "./settings";

app.setName("Yakjev");
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "yakjev",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

async function boot() {
  const userData = process.env.YAKJEV_DESKTOP_USER_DATA;
  if (userData) {
    if (!isAbsolute(userData))
      throw new Error("YAKJEV_DESKTOP_USER_DATA must be an absolute path.");
    // Electron may initialize Chromium during the first await. Set both paths
    // before yielding; this small bootstrap operation never runs interactively.
    mkdirSync(join(userData, "chromium"), { recursive: true, mode: 0o700 });
    app.setPath("userData", userData);
    app.setPath("sessionData", join(userData, "chromium"));
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  const developmentUrl = app.isPackaged
    ? undefined
    : process.env.ELECTRON_RENDERER_URL;
  if (
    developmentUrl &&
    new URL(developmentUrl).origin !== "http://127.0.0.1:5174"
  )
    throw new Error(
      "The desktop development renderer must run on http://127.0.0.1:5174.",
    );

  // One warm runtime owns main-process resources for the app's entire lifetime.
  // Effect fibers provide concurrency/cancellation; CPU work belongs in workers
  // when desktop capabilities are added, never in the renderer or event loop.
  const runtime: ManagedRuntime.ManagedRuntime<DesktopHost, never> =
    ManagedRuntime.make(
      DesktopHost.layer({
        outputRoot: resolve(__dirname, ".."),
        configuredOrigin:
          process.env.YAKJEV_REMOTE_URL ?? process.env.YAKJEV_URL,
        developmentUrl,
        run: (program) => runtime.runPromise(program),
      }).pipe(
        Layer.provide(
          Settings.layer(join(app.getPath("userData"), "connection.json")),
        ),
      ),
    );
  let stopping = false;
  let disposed = false;
  app.on("before-quit", (event) => {
    if (disposed) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void runtime
      .dispose()
      .catch(() => {
        console.error("Yakjev desktop cleanup failed.");
      })
      .finally(() => {
        disposed = true;
        app.quit();
      });
  });
  const focus = () => {
    if (stopping) return;
    void runtime
      .runPromise(Effect.flatMap(DesktopHost, (host) => host.focus))
      .catch(() => {
        dialog.showErrorBox("Yakjev", "Could not reopen the desktop window.");
      });
  };
  app.on("second-instance", focus);
  app.on("activate", focus);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  process.on("SIGINT", () => app.quit());
  process.on("SIGTERM", () => app.quit());
  await runtime.runPromise(Effect.flatMap(DesktopHost, (host) => host.start));
}

void boot().catch(() => {
  dialog.showErrorBox(
    "Yakjev could not start",
    "Check the server URL and desktop data directory, then try again.",
  );
  app.quit();
});

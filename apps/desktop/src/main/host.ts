import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type Session,
  type MenuItemConstructorOptions,
} from "electron";
import { Context, Effect, Layer, Semaphore } from "effect";
import {
  decodeOrigin,
  DesktopError,
  externalUrl,
  rendererPolicy,
  sessionPartition,
} from "./config";
import { Settings } from "./settings";
import { serveRenderer } from "./transport";
import { CONNECT_CHANNEL, type ConnectionResult } from "../shared/connection";

const connectionUrl = "yakjev://desktop/index.html";

interface HostOptions {
  readonly outputRoot: string;
  readonly configuredOrigin: string | undefined;
  readonly developmentUrl: string | undefined;
  readonly run: <A>(program: Effect.Effect<A, DesktopError>) => Promise<A>;
}

export class DesktopHost extends Context.Service<
  DesktopHost,
  {
    readonly start: Effect.Effect<void, DesktopError>;
    readonly focus: Effect.Effect<void, DesktopError>;
  }
>()("@yakjev/desktop/Host") {
  static layer(options: HostOptions) {
    return Layer.effect(
      DesktopHost,
      Effect.gen(function* () {
        const settings = yield* Settings;
        const changes = yield* Semaphore.make(1);
        const shutdown = new AbortController();
        const sessions = new Map<Session, readonly string[]>();
        let workbench: BrowserWindow | undefined;
        let connection: BrowserWindow | undefined;
        let activeOrigin: string | undefined;

        const report = (cause: unknown) => {
          if (!shutdown.signal.aborted)
            dialog.showErrorBox(
              "Yakjev",
              cause instanceof DesktopError
                ? cause.message
                : "The desktop window could not be opened.",
            );
        };
        const launch = (program: Effect.Effect<void, DesktopError>) => {
          void options.run(program).catch(report);
        };
        const protect = (
          window: BrowserWindow,
          allowed: string,
          sources = false,
        ) => {
          window.webContents.setWindowOpenHandler(({ url }) => {
            const target = sources ? externalUrl(url) : undefined;
            if (target) void shell.openExternal(target).catch(report);
            return { action: "deny" };
          });
          window.webContents.on("will-attach-webview", (event) =>
            event.preventDefault(),
          );
          window.webContents.on("will-navigate", (event, target) => {
            if (target !== allowed) event.preventDefault();
          });
          window.webContents.on("will-frame-navigate", (event) => {
            if (!event.isMainFrame || event.url !== allowed)
              event.preventDefault();
          });
          window.webContents.on("will-redirect", (event) =>
            event.preventDefault(),
          );
          window.once("ready-to-show", () => window.show());
          window.webContents.on("render-process-gone", (_event, details) => {
            if (shutdown.signal.aborted || details.reason === "clean-exit")
              return;
            void dialog
              .showMessageBox(window, {
                type: "error",
                message: "The Yakjev window stopped responding.",
                detail: "Reload to reconnect to your server.",
                buttons: ["Reload", "Close"],
              })
              .then(({ response }) => {
                if (window.isDestroyed()) return;
                if (response === 0) window.reload();
                else window.close();
              })
              .catch(report);
          });
        };
        const secureSession = (client: Session) => {
          client.setPermissionRequestHandler(
            (_contents, _permission, callback) => callback(false),
          );
          client.setPermissionCheckHandler(() => false);
          client.setDevicePermissionHandler(() => false);
        };

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            shutdown.abort();
            ipcMain.removeHandler(CONNECT_CHANNEL);
            if (connection && !connection.isDestroyed()) connection.destroy();
            if (workbench && !workbench.isDestroyed()) workbench.destroy();
            for (const [client, schemes] of sessions) {
              for (const scheme of schemes) client.protocol.unhandle(scheme);
              await client.cookies.flushStore();
              await client.closeAllConnections();
            }
            Menu.setApplicationMenu(null);
          }),
        );

        const setupSession = session.fromPartition("yakjev-connection");
        sessions.set(setupSession, ["yakjev"]);
        secureSession(setupSession);
        setupSession.protocol.handle("yakjev", async (request) => {
          const url = new URL(request.url);
          if (
            url.host !== "desktop" ||
            !["/index.html", "/connection.js", "/style.css"].includes(
              url.pathname,
            )
          )
            return new Response("Not found", { status: 404 });
          try {
            const response = await setupSession.fetch(
              pathToFileURL(
                join(options.outputRoot, "connection", url.pathname.slice(1)),
              ).href,
            );
            const headers = new Headers(response.headers);
            headers.set("Content-Security-Policy", rendererPolicy(false));
            headers.set("X-Content-Type-Options", "nosniff");
            return new Response(response.body, { headers });
          } catch {
            return new Response("Not found", { status: 404 });
          }
        });

        const showConnection = Effect.tryPromise({
          try: async () => {
            if (connection && !connection.isDestroyed()) {
              connection.show();
              connection.focus();
              return;
            }
            const window = new BrowserWindow({
              title: "Connect to Yakjev",
              width: 600,
              height: 590,
              minWidth: 480,
              minHeight: 520,
              show: false,
              backgroundColor: "#f5f2e9",
              autoHideMenuBar: true,
              webPreferences: {
                session: setupSession,
                preload: join(options.outputRoot, "preload/index.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                webSecurity: true,
                webviewTag: false,
              },
            });
            connection = window;
            window.on("closed", () => {
              if (connection === window) connection = undefined;
            });
            protect(window, connectionUrl);
            await window.loadURL(connectionUrl);
          },
          catch: () =>
            new DesktopError({
              message: "Could not open the server connection window.",
            }),
        });

        const openWorkbench = Effect.fn("desktop.openWorkbench")(function* (
          origin: string,
        ) {
          const client = session.fromPartition(
            sessionPartition(origin, !!options.developmentUrl),
          );
          if (!sessions.has(client)) {
            sessions.set(client, ["http", "https"]);
            secureSession(client);
            for (const scheme of ["http", "https"]) {
              client.protocol.handle(scheme, (request) =>
                options
                  .run(
                    serveRenderer(request, {
                      origin,
                      session: client,
                      root: join(options.outputRoot, "renderer"),
                      developmentUrl: options.developmentUrl,
                      shutdown: shutdown.signal,
                    }),
                  )
                  .catch(() =>
                    Response.json(
                      { message: "Desktop is closing." },
                      { status: 503 },
                    ),
                  ),
              );
            }
          }
          yield* Effect.tryPromise({
            try: async () => {
              const window = new BrowserWindow({
                title: "Yakjev",
                width: 1440,
                height: 960,
                minWidth: 800,
                minHeight: 600,
                show: false,
                backgroundColor: "#f5f2e9",
                autoHideMenuBar: true,
                webPreferences: {
                  session: client,
                  contextIsolation: true,
                  nodeIntegration: false,
                  sandbox: true,
                  webSecurity: true,
                  webviewTag: false,
                  spellcheck: false,
                },
              });
              protect(window, origin + "/", true);
              const previous = workbench;
              workbench = window;
              window.on("closed", () => {
                if (workbench === window) workbench = undefined;
              });
              try {
                await window.loadURL(origin + "/");
              } catch (cause) {
                workbench = previous;
                window.destroy();
                throw cause;
              }
              activeOrigin = origin;
              if (previous && !previous.isDestroyed()) previous.destroy();
            },
            catch: () =>
              new DesktopError({
                message: "Could not load the Yakjev workbench.",
              }),
          });
        });

        ipcMain.handle(
          CONNECT_CHANNEL,
          async (event, value: unknown): Promise<ConnectionResult> => {
            if (
              !connection ||
              event.sender !== connection.webContents ||
              event.senderFrame !== connection.webContents.mainFrame ||
              event.senderFrame.url !== connectionUrl
            )
              return {
                ok: false,
                message: "This window cannot change the server connection.",
              };
            return options
              .run(
                Effect.gen(function* () {
                  const origin = yield* decodeOrigin(value);
                  yield* settings.save(origin);
                  yield* openWorkbench(origin);
                  // Let invoke deliver its response before closing the invoking renderer.
                  setImmediate(() => {
                    if (connection && !connection.isDestroyed())
                      connection.close();
                  });
                  return { ok: true } as const;
                }).pipe(changes.withPermit),
              )
              .catch((cause) => ({
                ok: false,
                message:
                  cause instanceof DesktopError
                    ? cause.message
                    : "Could not connect to that server.",
              }));
          },
        );

        const menu: MenuItemConstructorOptions[] = [
          ...(process.platform === "darwin"
            ? [{ role: "appMenu" as const }]
            : []),
          {
            label: "File",
            submenu: [
              {
                label: "Connect to Server…",
                click: () => launch(showConnection),
              },
              { type: "separator" },
              { role: process.platform === "darwin" ? "close" : "quit" },
            ],
          },
          { role: "editMenu" },
          {
            label: "View",
            submenu: [
              { role: "reload" },
              { role: "toggleDevTools" },
              { type: "separator" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { type: "separator" },
              { role: "togglefullscreen" },
            ],
          },
          { role: "windowMenu" },
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(menu));

        return {
          start: Effect.gen(function* () {
            const saved =
              options.configuredOrigin === undefined
                ? yield* settings.read.pipe(
                    Effect.catchTag("DesktopError", (error) =>
                      Effect.sync(() => {
                        report(error);
                        return undefined;
                      }),
                    ),
                  )
                : yield* decodeOrigin(options.configuredOrigin);
            if (saved) yield* openWorkbench(saved);
            else yield* showConnection;
          }),
          focus: Effect.suspend(() => {
            const current = connection ?? workbench;
            if (current && !current.isDestroyed())
              return Effect.sync(() => {
                if (current.isMinimized()) current.restore();
                current.show();
                current.focus();
              });
            return activeOrigin ? openWorkbench(activeOrigin) : showConnection;
          }),
        };
      }),
    );
  }
}

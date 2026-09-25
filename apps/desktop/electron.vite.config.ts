import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { cpSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const desktopRoot = __dirname;
const webRoot = resolve(desktopRoot, "../web");
const connectionRoot = resolve(desktopRoot, "src/connection");
const external = ["electron", /^electron\/.+/, /^node:/];

export default defineConfig({
  main: {
    envDir: false,
    // The private server origin comes from the build environment, never source.
    define: {
      "process.env.YAKJEV_SERVER_URL": JSON.stringify(
        process.env.YAKJEV_SERVER_URL ?? "",
      ),
    },
    plugins: [
      {
        name: "desktop-connection-page",
        buildStart() {
          this.addWatchFile(connectionRoot);
          for (const file of readdirSync(connectionRoot, { recursive: true })) {
            if (typeof file === "string") {
              this.addWatchFile(resolve(connectionRoot, file));
            }
          }
        },
        writeBundle() {
          cpSync(connectionRoot, resolve(desktopRoot, "out/connection"), {
            recursive: true,
          });
        },
      },
    ],
    build: {
      // Ship the complete Effect runtime in the bundle, without node_modules.
      externalizeDeps: false,
      outDir: resolve(desktopRoot, "out/main"),
      target: "node24",
      sourcemap: false,
      rollupOptions: {
        input: { index: resolve(desktopRoot, "src/main/index.ts") },
        external,
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    envDir: false,
    build: {
      externalizeDeps: false,
      outDir: resolve(desktopRoot, "out/preload"),
      target: "node24",
      sourcemap: false,
      rollupOptions: {
        input: { index: resolve(desktopRoot, "src/preload/index.ts") },
        external,
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    envDir: false,
    // The desktop renderer is the same source and entry point as the web app.
    root: webRoot,
    publicDir: resolve(webRoot, "public"),
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      hmr: { host: "127.0.0.1", port: 5174 },
    },
    build: {
      outDir: resolve(desktopRoot, "out/renderer"),
      emptyOutDir: true,
      target: "chrome152",
      minify: "esbuild",
      sourcemap: false,
      rollupOptions: { input: resolve(webRoot, "index.html") },
    },
  },
});

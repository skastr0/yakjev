import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { gzipSync } from "node:zlib";
import { allowDevRequest } from "./dev-proxy";

const apiOrigin = "http://127.0.0.1:3210";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "precompress-public-assets",
      apply: "build",
      enforce: "post",
      generateBundle(_, bundle) {
        for (const [fileName, asset] of Object.entries(bundle)) {
          if (!/\.(js|css|svg)$/.test(fileName)) continue;
          this.emitFile({
            type: "asset",
            fileName: `${fileName}.gz`,
            source: gzipSync(
              asset.type === "chunk" ? asset.code : asset.source,
            ),
          });
        }
      },
    },
    {
      name: "synthetic-api-origin-boundary",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith("/api/")) return next();
          if (
            !allowDevRequest(
              {
                host: request.headers.host,
                origin: request.headers.origin,
                method: request.method ?? "GET",
                authorization: request.headers.authorization,
              },
              process.env.PUBLIC_URL,
            )
          ) {
            response.writeHead(403, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                error: "Forbidden",
                message: "Development request origin is not allowed.",
              }),
            );
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: process.env.PUBLIC_URL
      ? [new URL(process.env.PUBLIC_URL).hostname]
      : [],
    proxy: {
      "/healthz": { target: apiOrigin, changeOrigin: true },
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            // Middleware has already validated the original browser Origin.
            if (request.headers.origin)
              proxyRequest.setHeader("Origin", apiOrigin);
          });
        },
      },
    },
  },
});

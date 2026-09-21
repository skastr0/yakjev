import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "./app";

const root = resolve(import.meta.dir, "../../..");
const port = Number(process.env.YAKJEV_LISTEN_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid YAKJEV_LISTEN_PORT");
if (
  process.env.YAKJEV_LISTEN_HOST &&
  process.env.YAKJEV_LISTEN_HOST !== "127.0.0.1"
) {
  throw new Error(
    "Yakjev must listen on loopback; use a trusted proxy for remote access",
  );
}
const configuredOrigin = process.env.YAKJEV_ORIGIN;
if (process.env.NODE_ENV === "production" && !configuredOrigin) {
  throw new Error("Production requires YAKJEV_ORIGIN");
}
const origin = new URL(configuredOrigin ?? `http://127.0.0.1:${port}`);
if (
  origin.origin !== (configuredOrigin ?? origin.origin) ||
  (process.env.NODE_ENV === "production" && origin.protocol !== "https:")
) {
  throw new Error("YAKJEV_ORIGIN must be a bare origin, HTTPS in production");
}
const dataDir = resolve(root, process.env.YAKJEV_DATA_DIR ?? ".data");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const app = createApp({
  databasePath: `${dataDir}/yakjev.sqlite`,
  origin: origin.origin,
  webRoot: `${root}/apps/web/dist`,
});
await app.ready();
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
console.log(`yakjev scaffold listening on http://127.0.0.1:${server.port}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await app.close();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

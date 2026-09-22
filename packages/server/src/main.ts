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
const devAuth = process.env.YAKJEV_DEV_AUTH === "true";
if (
  devAuth &&
  (process.env.NODE_ENV === "production" ||
    !["127.0.0.1", "localhost"].includes(origin.hostname))
) {
  throw new Error("YAKJEV_DEV_AUTH requires a non-production loopback origin");
}
const ownerToken = devAuth
  ? "synthetic-yakjev-owner-token-local-only"
  : process.env.YAKJEV_OWNER_TOKEN;
if (!ownerToken || ownerToken.length < 32) {
  throw new Error(
    "Set YAKJEV_OWNER_TOKEN (at least 32 characters), or explicitly enable synthetic YAKJEV_DEV_AUTH locally",
  );
}
const dataDir = resolve(root, process.env.YAKJEV_DATA_DIR ?? ".data");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const app = createApp({
  databasePath: `${dataDir}/yakjev.sqlite`,
  origin: origin.origin,
  webRoot: `${root}/apps/web/dist`,
  ownerToken,
  ownerId: process.env.YAKJEV_OWNER_ID ?? "owner",
  listenPort: port,
});
await app.ready();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: 1024 * 1024,
  fetch: app.fetch,
});
console.log(`yakjev listening on loopback port ${server.port}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await app.close();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

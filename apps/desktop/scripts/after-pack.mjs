import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  flipFuses,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";
import {
  fuseNames,
  packagePolicy,
  validateFuseWire,
} from "./package-policy.mjs";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const info = context.packager.appInfo;
  if (
    info.productName !== packagePolicy.productName ||
    info.productFilename !== packagePolicy.productName ||
    info.id !== packagePolicy.bundleIdentifier
  ) {
    throw new Error("Unexpected macOS package identity");
  }
  const app = path.resolve(
    context.appOutDir,
    `${packagePolicy.productName}.app`,
  );
  const metadata = await lstat(app);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(app)) !== app
  ) {
    throw new Error("Packaged app must be a canonical non-symlink directory");
  }
  const fuses = {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    strictlyRequireAllFuses: true,
  };
  for (const name of fuseNames())
    fuses[FuseV1Options[name]] = packagePolicy.fuses[name];
  await flipFuses(app, fuses);
  validateFuseWire(await getCurrentFuseWire(app));
}

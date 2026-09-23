import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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

const exec = promisify(execFile);

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
  // Electron supplies permission descriptions for features Yakjev does not use.
  // Remove them before the fuse change resets the source build's ad-hoc signature.
  const infoPath = path.join(app, "Contents", "Info.plist");
  if (
    !(await lstat(infoPath)).isFile() ||
    (await realpath(infoPath)) !== infoPath
  ) {
    throw new Error("Packaged Info.plist must be a regular non-symlink file");
  }
  const { stdout } = await exec("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    infoPath,
  ]);
  const plist = JSON.parse(stdout);
  for (const key of Object.keys(plist)) {
    if (/^NS.*UsageDescription$/u.test(key)) {
      await exec("/usr/bin/plutil", ["-remove", key, infoPath]);
    }
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

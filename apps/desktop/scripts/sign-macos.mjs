import { realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";
import { signingConfig } from "./signing-config.mjs";
import { usesJitEntitlements } from "./package-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function needsJit(relativePath) {
  const executable =
    relativePath === ""
      ? "Contents/MacOS/Yakjev"
      : relativePath.endsWith(".app")
        ? `${relativePath}/Contents/MacOS/${basename(relativePath, ".app")}`
        : relativePath;
  return usesJitEntitlements(executable);
}

export default async function signMac(options) {
  if (options.platform !== "darwin") throw new Error("macOS signing only");
  const app = realpathSync(options.app);
  if (!app.endsWith(`${sep}Yakjev.app`))
    throw new Error("Unexpected app bundle");
  const config = signingConfig();
  await signAsync({
    ...options,
    app,
    identity: config.identity,
    identityValidation: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile(file) {
      const within = relative(app, realpathSync(file));
      if (
        within === ".." ||
        within.startsWith(`..${sep}`) ||
        within.startsWith(sep)
      )
        throw new Error("Signing target escapes the app");
      return {
        entitlements: resolve(
          root,
          "build",
          needsJit(within.split(sep).join("/"))
            ? "entitlements.mac.plist"
            : "entitlements.mac.inherit.plist",
        ),
        hardenedRuntime: true,
      };
    },
  });
}

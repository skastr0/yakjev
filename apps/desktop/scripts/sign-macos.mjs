import { realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";
import { signingConfig } from "./signing-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function needsJit(relativePath) {
  return (
    relativePath === "" ||
    relativePath === "Contents/MacOS/Yakjev" ||
    /^Contents\/Frameworks\/Yakjev Helper(?: \((?:Renderer|GPU)\))?\.app(?:\/Contents\/MacOS\/Yakjev Helper(?: \((?:Renderer|GPU)\))?)?$/.test(
      relativePath,
    )
  );
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

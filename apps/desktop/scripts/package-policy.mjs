import { FuseState, FuseV1Options, FuseVersion } from "@electron/fuses";

export const packagePolicy = Object.freeze({
  bundleIdentifier: "dev.castro.yakjev",
  productName: "Yakjev",
  minimumSystemVersion: "13.0",
  fuses: Object.freeze({
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    // Stock Electron does not ship a browser-specific V8 snapshot.
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false,
    WasmTrapHandlers: true,
  }),
});

export const fuseNames = () => {
  const names = Object.keys(FuseV1Options)
    .filter((name) => Number.isNaN(Number(name)))
    .sort((left, right) => FuseV1Options[left] - FuseV1Options[right]);
  const expected = Object.keys(packagePolicy.fuses);
  if (
    names.length !== expected.length ||
    names.some((name) => !Object.hasOwn(packagePolicy.fuses, name))
  ) {
    throw new Error(
      "Package policy must explicitly configure every Electron fuse",
    );
  }
  return names;
};

export const validateFuseWire = (wire) => {
  const names = fuseNames();
  const indexes = Object.keys(wire)
    .filter((key) => /^\d+$/u.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  if (
    wire.version !== FuseVersion.V1 ||
    indexes.length !== names.length ||
    indexes.some((index, position) => index !== FuseV1Options[names[position]])
  ) {
    throw new Error(
      "Packaged Electron fuse wire differs from the complete known set",
    );
  }
  for (const name of names) {
    const expected = packagePolicy.fuses[name]
      ? FuseState.ENABLE
      : FuseState.DISABLE;
    if (wire[FuseV1Options[name]] !== expected) {
      throw new Error(`Packaged Electron fuse mismatch: ${name}`);
    }
  }
  return packagePolicy.fuses;
};

export const usesJitEntitlements = (relativePath) =>
  [
    "Contents/MacOS/Yakjev",
    "Contents/Frameworks/Yakjev Helper.app/Contents/MacOS/Yakjev Helper",
    "Contents/Frameworks/Yakjev Helper (Renderer).app/Contents/MacOS/Yakjev Helper (Renderer)",
    "Contents/Frameworks/Yakjev Helper (GPU).app/Contents/MacOS/Yakjev Helper (GPU)",
  ].includes(relativePath);

export const validateEntitlements = (entitlements, relativePath) => {
  if (
    entitlements === null ||
    typeof entitlements !== "object" ||
    Array.isArray(entitlements)
  ) {
    throw new Error("Signed entitlements must be an object");
  }
  const keys = Object.keys(entitlements);
  const jit = usesJitEntitlements(relativePath);
  if (
    keys.length !== (jit ? 1 : 0) ||
    (jit && entitlements["com.apple.security.cs.allow-jit"] !== true)
  ) {
    throw new Error(`Unexpected signed entitlements: ${relativePath}`);
  }
};

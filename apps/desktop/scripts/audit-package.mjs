import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, getRawHeader, uncache } from "@electron/asar";
import { getCurrentFuseWire } from "@electron/fuses";
import {
  packagePolicy,
  validateEntitlements,
  validateFuseWire,
} from "./package-policy.mjs";
import { signingConfig } from "./signing-config.mjs";

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};
const run = (command, args, input) =>
  new Promise((resolve, reject) => {
    // Tool output can include local paths or certificate names. Never echo it on failure.
    const child = execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `Package audit command failed: ${path.basename(command)}`,
            ),
          );
        else resolve({ stdout, stderr });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const validatePackagedFile = (name, bytes) => {
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name
      .split("/")
      .some((part) => part === ".." || part === "." || part === "") ||
    !(
      /^(?:package\.json|LICENSE|THIRD_PARTY_NOTICES\.md|out\/build-provenance\.json)$/u.test(
        name,
      ) || /^out\/(?:main|preload|renderer|connection)\//u.test(name)
    ) ||
    /(?:^|\/)(?:\.[^/]+|node_modules|src|test|tests|e2e)(?:\/|$)/u.test(name) ||
    /\.(?:map|[cm]?tsx?|p12|pfx|p8|pem|key|keychain(?:-db)?|log|sqlite(?:3)?|db)$/iu.test(
      name,
    ) ||
    /(?:^|\/)(?:notarization|builder-debug|builder-effective-config)(?:[.-]|$)/iu.test(
      name,
    )
  ) {
    throw new Error(`Unexpected packaged file: ${name}`);
  }
  if (/\.(?:[cm]?js|json|html|css|svg|txt|md)$/iu.test(name)) {
    const text = bytes.toString("utf8");
    if (
      /(?:\/Users\/|\/home\/)[^\s/"'<>]+\//u.test(text) ||
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(text) ||
      /(?:^|\n)\s*\/\/[#@]\s*sourceMappingURL=/u.test(text) ||
      /(?:^|\n)\s*\/\*[#@]\s*sourceMappingURL=/u.test(text)
    ) {
      throw new Error(
        `Private build data or source map in packaged file: ${name}`,
      );
    }
  }
};

export const auditAsar = (asarPath, plist) => {
  uncache(asarPath);
  const { header, headerString } = getRawHeader(asarPath);
  const embedded = plist.ElectronAsarIntegrity?.["Resources/app.asar"];
  if (
    !record(embedded) ||
    embedded.algorithm !== "SHA256" ||
    embedded.hash !== sha256(headerString)
  ) {
    throw new Error("Embedded ASAR integrity does not match packaged app.asar");
  }
  const files = [];
  const visit = (entries, prefix = "") => {
    if (!record(entries)) throw new Error("Invalid ASAR file tree");
    for (const [name, entry] of Object.entries(entries)) {
      if (
        !name ||
        name.includes("/") ||
        name.includes("\\") ||
        name === "." ||
        name === ".." ||
        !record(entry)
      ) {
        throw new Error("Invalid ASAR path");
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.link !== undefined || entry.unpacked)
        throw new Error("ASAR links and unpacked files are not allowed");
      if (entry.files !== undefined) visit(entry.files, relative);
      else {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0)
          throw new Error("Invalid ASAR file size");
        const bytes = extractFile(asarPath, relative);
        if (bytes.length !== entry.size)
          throw new Error("ASAR payload size mismatch");
        validatePackagedFile(relative, bytes);
        if (
          entry.integrity?.algorithm !== "SHA256" ||
          entry.integrity.hash !== sha256(bytes)
        ) {
          throw new Error(`ASAR payload integrity mismatch: ${relative}`);
        }
        files.push(relative);
      }
    }
  };
  visit(header.files);
  for (const required of [
    "package.json",
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
    "out/connection/index.html",
  ]) {
    if (
      !files.includes(required) ||
      extractFile(asarPath, required).length === 0
    )
      throw new Error(`Missing packaged entry: ${required}`);
  }
  const manifest = JSON.parse(
    extractFile(asarPath, "package.json").toString("utf8"),
  );
  if (
    manifest.name !== "@yakjev/desktop" ||
    !["out/main/index.js", "./out/main/index.js"].includes(manifest.main)
  ) {
    throw new Error("Unexpected packaged application manifest");
  }
  if (!files.some((name) => /^out\/renderer\/assets\/.+\.js$/u.test(name)))
    throw new Error("Packaged renderer bundle missing");
  return { files: files.length, asarHeaderSha256: embedded.hash };
};

const machOMagic = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
const inspectBundle = async (appPath) => {
  const binaries = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink()) {
        if (!inside(appPath, await realpath(file)))
          throw new Error("Packaged symlink escapes application bundle");
      } else if (metadata.isDirectory()) await walk(file);
      else if (metadata.isFile()) {
        const handle = await open(file, "r");
        try {
          const magic = Buffer.alloc(4);
          await handle.read(magic, 0, 4, 0);
          if (machOMagic.has(magic.toString("hex")))
            binaries.push(
              path.relative(appPath, file).split(path.sep).join("/"),
            );
        } finally {
          await handle.close();
        }
      } else throw new Error("Unsupported packaged filesystem object");
    }
  };
  await walk(appPath);
  if (!binaries.includes("Contents/MacOS/Yakjev"))
    throw new Error("Packaged main executable is not Mach-O");
  return binaries;
};

const auditSignature = async (file, relative, signing) => {
  const result = await run("/usr/bin/codesign", ["-d", "--verbose=4", file]);
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u);
  const values = (prefix) =>
    lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length));
  if (
    values("TeamIdentifier=").length !== 1 ||
    values("TeamIdentifier=")[0] !== signing.team ||
    values("Authority=")[0] !== signing.identity ||
    values("Signature=").some((value) => value.toLowerCase() === "adhoc") ||
    !lines.some(
      (line) =>
        /^CodeDirectory\b/u.test(line) &&
        /flags=0x[0-9a-f]+\([^)]*\bruntime\b/iu.test(line),
    ) ||
    (relative === "Contents/MacOS/Yakjev" &&
      values("Identifier=")[0] !== packagePolicy.bundleIdentifier)
  )
    throw new Error(
      `Invalid Developer ID or hardened runtime signature: ${relative}`,
    );
  const entitlements = await run("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    ":-",
    file,
  ]);
  // codesign diagnostics go to stderr; an empty entitlement payload is valid for libraries.
  let parsed = {};
  if (entitlements.stdout.trim()) {
    const result = await run(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      entitlements.stdout,
    );
    parsed = JSON.parse(result.stdout);
  }
  validateEntitlements(parsed, relative);
};

export const auditPackage = async (
  requestedPath,
  { signed = false, environment = process.env } = {},
) => {
  if (process.platform !== "darwin")
    throw new Error("macOS package audit requires macOS");
  const signing = signed ? signingConfig(environment) : undefined;
  const requested = path.resolve(requestedPath);
  const metadata = await lstat(requested);
  if (
    path.basename(requested) !== `${packagePolicy.productName}.app` ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  )
    throw new Error(
      "Package audit requires a non-symlink Yakjev.app directory",
    );
  const appPath = await realpath(requested);
  const binaries = await inspectBundle(appPath);
  for (const relative of [
    "Contents/Info.plist",
    "Contents/Resources/app.asar",
    "Contents/MacOS/Yakjev",
  ]) {
    const file = await lstat(path.join(appPath, relative));
    if (!file.isFile() || file.isSymbolicLink() || !file.size)
      throw new Error(`Missing regular bundle entry: ${relative}`);
  }
  const { stdout } = await run("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path.join(appPath, "Contents/Info.plist"),
  ]);
  const plist = JSON.parse(stdout);
  if (
    plist.CFBundleIdentifier !== packagePolicy.bundleIdentifier ||
    plist.CFBundleExecutable !== packagePolicy.productName ||
    plist.LSMinimumSystemVersion !== packagePolicy.minimumSystemVersion
  )
    throw new Error(
      "Packaged Info.plist identity or minimum macOS differs from policy",
    );
  if (Object.keys(plist).some((key) => /^NS.*UsageDescription$/u.test(key)))
    throw new Error(
      "Yakjev has no feature requiring macOS privacy usage descriptions",
    );
  const asar = auditAsar(
    path.join(appPath, "Contents/Resources/app.asar"),
    plist,
  );
  const fuses = validateFuseWire(await getCurrentFuseWire(appPath));
  if (signing) {
    await run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath,
    ]);
    for (const relative of binaries)
      await auditSignature(path.join(appPath, relative), relative, signing);
  }
  // Public-safe receipt: no absolute paths, certificate identity, or credentials.
  return {
    ok: true,
    product: packagePolicy.productName,
    signing: signed ? "developer-id" : "source-build",
    ...asar,
    fuses,
    machOCount: binaries.length,
  };
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [appPath, option, ...extra] = process.argv.slice(2);
  if (
    !appPath ||
    (option !== undefined && option !== "--signed") ||
    extra.length
  ) {
    console.error(
      "Usage: bun scripts/audit-package.mjs /path/to/Yakjev.app [--signed]",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(
        JSON.stringify(
          await auditPackage(appPath, { signed: option === "--signed" }),
        ),
      );
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Package audit failed",
      );
      process.exitCode = 1;
    }
  }
}

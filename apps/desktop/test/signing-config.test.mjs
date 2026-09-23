import { describe, expect, test } from "bun:test";
import { buildEnvironment, signingConfig } from "../scripts/signing-config.mjs";
import { needsJit } from "../scripts/sign-macos.mjs";

describe("explicit macOS signing", () => {
  test("requires an explicit matching team and identity", () => {
    const team = "ABCDEFGHIJ";
    const identity = `Developer ID Application: Synthetic Fixture (${team})`;
    expect(() => signingConfig({})).toThrow();
    expect(() => signingConfig({ YAKJEV_MAC_TEAM_ID: team })).toThrow();
    expect(() =>
      signingConfig({
        YAKJEV_MAC_TEAM_ID: "AAAAAAAAAA",
        YAKJEV_MAC_SIGNING_IDENTITY: identity,
      }),
    ).toThrow();
    expect(
      signingConfig({
        YAKJEV_MAC_TEAM_ID: team,
        YAKJEV_MAC_SIGNING_IDENTITY: identity,
      }),
    ).toEqual({
      team,
      identity,
      builderIdentity: `Synthetic Fixture (${team})`,
    });
    expect(() =>
      signingConfig({
        YAKJEV_MAC_TEAM_ID: team,
        YAKJEV_MAC_SIGNING_IDENTITY: identity + "\n",
      }),
    ).toThrow();
  });
  test("build children receive no credentials or bundler injection", () => {
    expect(
      buildEnvironment({
        PATH: "/synthetic/bin",
        HOME: "/synthetic/home",
        YAKJEV_OWNER_TOKEN: "synthetic",
        APPLE_API_KEY: "synthetic",
        NODE_OPTIONS: "--inspect",
        BUN_OPTIONS: "--preload",
        VITE_TOKEN: "synthetic",
        CSC_NAME: "automatic",
      }),
    ).toEqual({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      PATH: "/synthetic/bin",
      HOME: "/synthetic/home",
    });
  });
  test("only Electron execution processes receive JIT", () => {
    expect(needsJit("")).toBe(true);
    expect(needsJit("Contents/Frameworks/Yakjev Helper (Renderer).app")).toBe(
      true,
    );
    expect(
      needsJit(
        "Contents/Frameworks/Yakjev Helper (GPU).app/Contents/MacOS/Yakjev Helper (GPU)",
      ),
    ).toBe(true);
    expect(needsJit("Contents/Frameworks/Yakjev Helper (Plugin).app")).toBe(
      false,
    );
    expect(needsJit("Contents/Frameworks/Electron Framework.framework")).toBe(
      false,
    );
  });
});

import type { ExpoConfig } from "expo/config";

const appleTeamId = process.env.YAKJEV_APPLE_TEAM_ID?.trim();

const config: ExpoConfig = {
  name: "yakjev",
  slug: "yakjev",
  scheme: "yakjev",
  version: "0.1.0",
  icon: "./assets/icon.png",
  orientation: "default",
  userInterfaceStyle: "light",
  platforms: ["ios"],
  ios: {
    bundleIdentifier: "engineer.castro.yakjev",
    ...(appleTeamId ? { appleTeamId } : {}),
    buildNumber: process.env.YAKJEV_IOS_BUILD_NUMBER ?? "1",
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      CADisableMinimumFrameDurationOnPhone: true,
      NSLocalNetworkUsageDescription:
        "Connect to your local Yakjev development server.",
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-splash-screen", { backgroundColor: "#f5f2e9" }],
  ],
  experiments: { typedRoutes: true },
};

export default config;

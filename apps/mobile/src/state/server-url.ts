import Constants from "expo-constants";

// The private server origin comes from YAKJEV_SERVER_URL through Expo config at
// build time. Public source names no live server.
const configured: unknown = Constants.expoConfig?.extra?.serverUrl;
export const SERVER_URL =
  typeof configured === "string" && configured ? configured : undefined;

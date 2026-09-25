// Public source names no live server: the tailnet origin stays private. Client
// builds read it from YAKJEV_SERVER_URL; without it, the connect screen asks.
export const RETIRED_SERVER_URLS: readonly string[] = [
  "https://yakjev-production.up.railway.app",
];

// A connection saved against a retired server moves to the build's server. The
// owner token moved with the graph, so a saved session keeps working.
export function currentServerUrl(
  saved: string,
  serverUrl: string | undefined,
): string {
  return serverUrl && RETIRED_SERVER_URLS.includes(saved) ? serverUrl : saved;
}

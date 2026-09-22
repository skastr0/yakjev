// This boundary exists only in Vite development. Production serves the built UI
// at the API's configured HTTPS origin and never rewrites Origin headers.
export function allowDevRequest(
  input: {
    host: string | undefined;
    origin: string | undefined;
    method: string;
    authorization: string | undefined;
  },
  publicUrl?: string,
): boolean {
  const portal = publicUrl ? new URL(publicUrl) : null;
  if (!input.host) return false;
  let host: URL;
  try {
    host = new URL(`http://${input.host}`);
  } catch {
    return false;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname);
  if (!local && host.host !== portal?.host) return false;
  if (input.origin) {
    try {
      const origin = new URL(input.origin);
      return (
        origin.origin === input.origin &&
        origin.host === input.host &&
        (local
          ? ["http:", "https:"].includes(origin.protocol)
          : origin.origin === portal?.origin)
      );
    } catch {
      return false;
    }
  }
  return (
    ["GET", "HEAD", "OPTIONS"].includes(input.method) ||
    Boolean(input.authorization?.startsWith("Bearer "))
  );
}

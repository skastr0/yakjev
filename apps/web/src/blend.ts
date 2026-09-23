export * from "@yakjev/client/blend";

const STORAGE_KEY = "yakjev.nodePaint";

export function readPaint(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && /^#[0-9a-fA-F]{6}$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function writePaint(
  current: Record<string, string>,
  id: string,
  hex: string,
): Record<string, string> {
  const next = { ...current, [id]: hex };
  if (typeof localStorage !== "undefined")
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

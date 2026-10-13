export type DragIntent = "link" | "jev" | "move";

// Asking Jev costs a provider call, so it must never happen by accident. The
// gesture decides, once, when the drag starts: a plain drag only moves, a key
// held during the drag asks Jev, and Shift draws a link the owner picks the
// relation for. A touch drag has no keys at all, so it only moves.
export function dragIntent(
  mouse: { shiftKey: boolean; altKey: boolean } | null,
): DragIntent {
  if (mouse?.shiftKey) return "link";
  if (mouse?.altKey) return "jev";
  return "move";
}

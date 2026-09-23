import type { Node } from "@yakjev/protocol";

type EditableContent = Pick<
  Node,
  "title" | "description" | "project" | "status" | "sources"
>;

// Paint and placement can change independently while a text draft is open.
// Only the content the editor will save participates in its conflict check.
export function sameNodeContent(left: EditableContent, right: EditableContent) {
  return (
    left.title === right.title &&
    left.description === right.description &&
    left.project === right.project &&
    left.status === right.status &&
    left.sources.length === right.sources.length &&
    left.sources.every(
      (source, index) =>
        source.uri === right.sources[index]?.uri &&
        source.label === right.sources[index]?.label,
    )
  );
}

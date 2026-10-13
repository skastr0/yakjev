import { describe, expect, test } from "bun:test";
import { dragIntent } from "./drag-intent";

const mouse = (init: Partial<{ shiftKey: boolean; altKey: boolean }> = {}) => ({
  shiftKey: false,
  altKey: false,
  ...init,
});

describe("drag intent", () => {
  test("a plain drag only moves, so it never asks Jev", () => {
    expect(dragIntent(mouse())).toBe("move");
  });

  test("holding Option is what asks Jev", () => {
    expect(dragIntent(mouse({ altKey: true }))).toBe("jev");
  });

  test("holding Shift chooses the link instead of asking Jev", () => {
    expect(dragIntent(mouse({ shiftKey: true }))).toBe("link");
  });

  test("Shift wins when both keys are held", () => {
    expect(dragIntent(mouse({ shiftKey: true, altKey: true }))).toBe("link");
  });

  test("a drag with no keyboard only moves", () => {
    expect(dragIntent(null)).toBe("move");
  });
});

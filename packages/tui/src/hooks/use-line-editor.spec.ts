import { describe, it, expect } from "vitest";
import { normalizeInkKeystroke } from "./use-line-editor.js";
import type { Key } from "ink";

// ── Helpers ─────────────────────────────────────────────────────────────────

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

// ── Ink key normalization ───────────────────────────────────────────────────

describe("normalizeInkKeystroke", () => {
  it("normalizes ctrl+letter", () => {
    expect(normalizeInkKeystroke("a", key({ ctrl: true }))).toBe("ctrl+a");
  });

  it("normalizes meta+letter", () => {
    expect(normalizeInkKeystroke("f", key({ meta: true }))).toBe("meta+f");
  });

  it("normalizes return", () => {
    expect(normalizeInkKeystroke("", key({ return: true }))).toBe("return");
  });

  it("normalizes arrows", () => {
    expect(normalizeInkKeystroke("", key({ upArrow: true }))).toBe("up");
    expect(normalizeInkKeystroke("", key({ downArrow: true }))).toBe("down");
    expect(normalizeInkKeystroke("", key({ leftArrow: true }))).toBe("left");
    expect(normalizeInkKeystroke("", key({ rightArrow: true }))).toBe("right");
  });

  it("normalizes meta+arrows", () => {
    expect(normalizeInkKeystroke("", key({ leftArrow: true, meta: true }))).toBe("meta+left");
    expect(normalizeInkKeystroke("", key({ rightArrow: true, meta: true }))).toBe("meta+right");
  });

  it("normalizes backspace/delete", () => {
    expect(normalizeInkKeystroke("", key({ backspace: true }))).toBe("backspace");
    expect(normalizeInkKeystroke("", key({ delete: true }))).toBe("delete");
  });

  it("normalizes tab", () => {
    expect(normalizeInkKeystroke("", key({ tab: true }))).toBe("tab");
  });

  it("normalizes escape", () => {
    expect(normalizeInkKeystroke("", key({ escape: true }))).toBe("escape");
  });

  it("returns null for plain characters", () => {
    expect(normalizeInkKeystroke("a", key())).toBeNull();
  });

  it("returns null for ctrl without input", () => {
    expect(normalizeInkKeystroke("", key({ ctrl: true }))).toBeNull();
  });

  it("returns null for meta without input", () => {
    expect(normalizeInkKeystroke("", key({ meta: true }))).toBeNull();
  });

  it("return takes priority over ctrl modifier", () => {
    expect(normalizeInkKeystroke("m", key({ return: true, ctrl: true }))).toBe("return");
  });

  it("up arrow takes priority over meta", () => {
    expect(normalizeInkKeystroke("", key({ upArrow: true, meta: true }))).toBe("up");
  });
});

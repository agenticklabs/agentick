import { describe, it, expect } from "vitest";
import {
  actions,
  findWordBoundaryForward,
  findWordBoundaryBackward,
  normalizeKeystroke,
  DEFAULT_BINDINGS,
  type LineEditorState,
} from "./use-line-editor.js";
import type { Key } from "ink";

// ── Helpers ─────────────────────────────────────────────────────────────────

function state(value: string, cursor?: number): LineEditorState {
  return { value, cursor: cursor ?? value.length };
}

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

// ── Word boundaries ─────────────────────────────────────────────────────────

describe("findWordBoundaryForward", () => {
  it("skips to end of word", () => {
    expect(findWordBoundaryForward("hello world", 0)).toBe(5);
  });

  it("skips whitespace then word", () => {
    expect(findWordBoundaryForward("hello world", 5)).toBe(11);
  });

  it("returns length at end", () => {
    expect(findWordBoundaryForward("hello", 5)).toBe(5);
  });

  it("handles punctuation as non-word", () => {
    expect(findWordBoundaryForward("foo.bar", 0)).toBe(3);
  });

  it("handles multiple spaces", () => {
    expect(findWordBoundaryForward("foo   bar", 3)).toBe(9);
  });
});

describe("findWordBoundaryBackward", () => {
  it("skips to start of word", () => {
    expect(findWordBoundaryBackward("hello world", 11)).toBe(6);
  });

  it("skips whitespace then word", () => {
    expect(findWordBoundaryBackward("hello world", 6)).toBe(0);
  });

  it("returns 0 at start", () => {
    expect(findWordBoundaryBackward("hello", 0)).toBe(0);
  });

  it("handles punctuation as non-word", () => {
    expect(findWordBoundaryBackward("foo.bar", 7)).toBe(4);
  });
});

// ── Key normalization ───────────────────────────────────────────────────────

describe("normalizeKeystroke", () => {
  it("normalizes ctrl+letter", () => {
    expect(normalizeKeystroke("a", key({ ctrl: true }))).toBe("ctrl+a");
  });

  it("normalizes meta+letter", () => {
    expect(normalizeKeystroke("f", key({ meta: true }))).toBe("meta+f");
  });

  it("normalizes return", () => {
    expect(normalizeKeystroke("", key({ return: true }))).toBe("return");
  });

  it("normalizes arrows", () => {
    expect(normalizeKeystroke("", key({ upArrow: true }))).toBe("up");
    expect(normalizeKeystroke("", key({ downArrow: true }))).toBe("down");
    expect(normalizeKeystroke("", key({ leftArrow: true }))).toBe("left");
    expect(normalizeKeystroke("", key({ rightArrow: true }))).toBe("right");
  });

  it("normalizes meta+arrows", () => {
    expect(normalizeKeystroke("", key({ leftArrow: true, meta: true }))).toBe("meta+left");
    expect(normalizeKeystroke("", key({ rightArrow: true, meta: true }))).toBe("meta+right");
  });

  it("normalizes backspace/delete", () => {
    expect(normalizeKeystroke("", key({ backspace: true }))).toBe("backspace");
    expect(normalizeKeystroke("", key({ delete: true }))).toBe("delete");
  });

  it("returns null for plain characters", () => {
    expect(normalizeKeystroke("a", key())).toBeNull();
  });
});

// ── Bindings coverage ───────────────────────────────────────────────────────

describe("DEFAULT_BINDINGS", () => {
  it("all bindings map to existing actions", () => {
    for (const [binding, actionName] of Object.entries(DEFAULT_BINDINGS)) {
      if (!actions[actionName]) {
        throw new Error(`binding "${binding}" → action "${actionName}" missing`);
      }
    }
  });
});

// ── Actions ─────────────────────────────────────────────────────────────────

describe("actions", () => {
  // Movement
  describe("lineStart", () => {
    it("moves cursor to 0", () => {
      expect(actions.lineStart!(state("hello", 3), [])).toEqual({ cursor: 0 });
    });
  });

  describe("lineEnd", () => {
    it("moves cursor to end", () => {
      expect(actions.lineEnd!(state("hello", 0), [])).toEqual({ cursor: 5 });
    });
  });

  describe("charForward", () => {
    it("moves cursor right by one", () => {
      expect(actions.charForward!(state("hello", 2), [])).toEqual({ cursor: 3 });
    });

    it("clamps at end", () => {
      expect(actions.charForward!(state("hello", 5), [])).toEqual({ cursor: 5 });
    });
  });

  describe("charBackward", () => {
    it("moves cursor left by one", () => {
      expect(actions.charBackward!(state("hello", 2), [])).toEqual({ cursor: 1 });
    });

    it("clamps at 0", () => {
      expect(actions.charBackward!(state("hello", 0), [])).toEqual({ cursor: 0 });
    });
  });

  describe("wordForward", () => {
    it("jumps to end of next word", () => {
      expect(actions.wordForward!(state("hello world", 0), [])).toEqual({ cursor: 5 });
    });
  });

  describe("wordBackward", () => {
    it("jumps to start of previous word", () => {
      expect(actions.wordBackward!(state("hello world", 11), [])).toEqual({ cursor: 6 });
    });
  });

  // Deletion
  describe("deleteForward", () => {
    it("deletes character at cursor", () => {
      expect(actions.deleteForward!(state("hello", 2), [])).toEqual({ value: "helo" });
    });

    it("no-op at end of line", () => {
      expect(actions.deleteForward!(state("hello", 5), [])).toEqual({});
    });
  });

  describe("deleteBackward", () => {
    it("deletes character before cursor", () => {
      expect(actions.deleteBackward!(state("hello", 2), [])).toEqual({ value: "hllo", cursor: 1 });
    });

    it("no-op at start of line", () => {
      expect(actions.deleteBackward!(state("hello", 0), [])).toEqual({});
    });
  });

  // Kill & yank
  describe("killToEnd", () => {
    it("kills from cursor to end", () => {
      expect(actions.killToEnd!(state("hello world", 5), [])).toEqual({
        value: "hello",
        killed: " world",
      });
    });

    it("no-op at end", () => {
      expect(actions.killToEnd!(state("hello", 5), [])).toEqual({});
    });
  });

  describe("killToStart", () => {
    it("kills from start to cursor", () => {
      expect(actions.killToStart!(state("hello world", 5), [])).toEqual({
        value: " world",
        cursor: 0,
        killed: "hello",
      });
    });

    it("no-op at start", () => {
      expect(actions.killToStart!(state("hello", 0), [])).toEqual({});
    });
  });

  describe("killWordBackward", () => {
    it("kills previous word", () => {
      expect(actions.killWordBackward!(state("hello world", 11), [])).toEqual({
        value: "hello ",
        cursor: 6,
        killed: "world",
      });
    });

    it("kills word and spaces", () => {
      expect(actions.killWordBackward!(state("hello   world", 8), [])).toEqual({
        value: "world",
        cursor: 0,
        killed: "hello   ",
      });
    });

    it("no-op at start", () => {
      expect(actions.killWordBackward!(state("hello", 0), [])).toEqual({});
    });
  });

  describe("killWordForward", () => {
    it("kills next word", () => {
      expect(actions.killWordForward!(state("hello world", 6), [])).toEqual({
        value: "hello ",
        killed: "world",
      });
    });

    it("no-op at end", () => {
      expect(actions.killWordForward!(state("hello", 5), [])).toEqual({});
    });
  });

  describe("yank", () => {
    it("pastes last killed text", () => {
      expect(actions.yank!(state("hello", 5), ["world"])).toEqual({
        value: "helloworld",
        cursor: 10,
      });
    });

    it("pastes at cursor position", () => {
      expect(actions.yank!(state("hd", 1), ["ello worl"])).toEqual({
        value: "hello world",
        cursor: 10,
      });
    });

    it("uses most recent kill", () => {
      expect(actions.yank!(state("", 0), ["first", "second"])).toEqual({
        value: "second",
        cursor: 6,
      });
    });

    it("no-op with empty kill ring", () => {
      expect(actions.yank!(state("hello", 5), [])).toEqual({});
    });
  });

  // Transposition
  describe("transpose", () => {
    it("swaps char before and at cursor", () => {
      expect(actions.transpose!(state("abcd", 2), [])).toEqual({
        value: "acbd",
        cursor: 3,
      });
    });

    it("swaps last two chars at end of line", () => {
      expect(actions.transpose!(state("abcd", 4), [])).toEqual({
        value: "abdc",
        cursor: 4,
      });
    });

    it("no-op at position 0", () => {
      expect(actions.transpose!(state("abcd", 0), [])).toEqual({});
    });

    it("no-op with less than 2 chars", () => {
      expect(actions.transpose!(state("a", 1), [])).toEqual({});
    });
  });
});

// ── Kill ring accumulation ──────────────────────────────────────────────────

describe("kill ring", () => {
  it("accumulates kills and yank uses the most recent", () => {
    const killRing: string[] = [];

    // Kill "world" from "hello world"
    const r1 = actions.killToEnd!(state("hello world", 5), killRing);
    expect(r1.killed).toBe(" world");
    killRing.push(r1.killed!);

    // Kill "he" from "hello"
    const r2 = actions.killToStart!(state("hello", 2), killRing);
    expect(r2.killed).toBe("he");
    killRing.push(r2.killed!);

    // Yank should paste "he" (most recent)
    const r3 = actions.yank!(state("llo", 0), killRing);
    expect(r3.value).toBe("hello");
  });
});

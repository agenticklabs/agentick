import { describe, it, expect, vi } from "vitest";
import {
  LineEditor,
  actions,
  findWordBoundaryForward,
  findWordBoundaryBackward,
  DEFAULT_BINDINGS,
  type LineEditorSnapshot,
} from "../line-editor";

// ── Helpers ─────────────────────────────────────────────────────────────────

function snap(value: string, cursor?: number): LineEditorSnapshot {
  return { value, cursor: cursor ?? value.length };
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
      expect(actions.lineStart!(snap("hello", 3), [])).toEqual({ cursor: 0 });
    });
  });

  describe("lineEnd", () => {
    it("moves cursor to end", () => {
      expect(actions.lineEnd!(snap("hello", 0), [])).toEqual({ cursor: 5 });
    });
  });

  describe("charForward", () => {
    it("moves cursor right by one", () => {
      expect(actions.charForward!(snap("hello", 2), [])).toEqual({ cursor: 3 });
    });

    it("clamps at end", () => {
      expect(actions.charForward!(snap("hello", 5), [])).toEqual({ cursor: 5 });
    });
  });

  describe("charBackward", () => {
    it("moves cursor left by one", () => {
      expect(actions.charBackward!(snap("hello", 2), [])).toEqual({ cursor: 1 });
    });

    it("clamps at 0", () => {
      expect(actions.charBackward!(snap("hello", 0), [])).toEqual({ cursor: 0 });
    });
  });

  describe("wordForward", () => {
    it("jumps to end of next word", () => {
      expect(actions.wordForward!(snap("hello world", 0), [])).toEqual({ cursor: 5 });
    });
  });

  describe("wordBackward", () => {
    it("jumps to start of previous word", () => {
      expect(actions.wordBackward!(snap("hello world", 11), [])).toEqual({ cursor: 6 });
    });
  });

  // Deletion
  describe("deleteForward", () => {
    it("deletes character at cursor", () => {
      expect(actions.deleteForward!(snap("hello", 2), [])).toEqual({ value: "helo" });
    });

    it("no-op at end of line", () => {
      expect(actions.deleteForward!(snap("hello", 5), [])).toEqual({});
    });
  });

  describe("deleteBackward", () => {
    it("deletes character before cursor", () => {
      expect(actions.deleteBackward!(snap("hello", 2), [])).toEqual({ value: "hllo", cursor: 1 });
    });

    it("no-op at start of line", () => {
      expect(actions.deleteBackward!(snap("hello", 0), [])).toEqual({});
    });
  });

  // Kill & yank
  describe("killToEnd", () => {
    it("kills from cursor to end", () => {
      expect(actions.killToEnd!(snap("hello world", 5), [])).toEqual({
        value: "hello",
        killed: " world",
      });
    });

    it("no-op at end", () => {
      expect(actions.killToEnd!(snap("hello", 5), [])).toEqual({});
    });
  });

  describe("killToStart", () => {
    it("kills from start to cursor", () => {
      expect(actions.killToStart!(snap("hello world", 5), [])).toEqual({
        value: " world",
        cursor: 0,
        killed: "hello",
      });
    });

    it("no-op at start", () => {
      expect(actions.killToStart!(snap("hello", 0), [])).toEqual({});
    });
  });

  describe("killWordBackward", () => {
    it("kills previous word", () => {
      expect(actions.killWordBackward!(snap("hello world", 11), [])).toEqual({
        value: "hello ",
        cursor: 6,
        killed: "world",
      });
    });

    it("kills word and spaces", () => {
      expect(actions.killWordBackward!(snap("hello   world", 8), [])).toEqual({
        value: "world",
        cursor: 0,
        killed: "hello   ",
      });
    });

    it("no-op at start", () => {
      expect(actions.killWordBackward!(snap("hello", 0), [])).toEqual({});
    });
  });

  describe("killWordForward", () => {
    it("kills next word", () => {
      expect(actions.killWordForward!(snap("hello world", 6), [])).toEqual({
        value: "hello ",
        killed: "world",
      });
    });

    it("no-op at end", () => {
      expect(actions.killWordForward!(snap("hello", 5), [])).toEqual({});
    });
  });

  describe("yank", () => {
    it("pastes last killed text", () => {
      expect(actions.yank!(snap("hello", 5), ["world"])).toEqual({
        value: "helloworld",
        cursor: 10,
      });
    });

    it("pastes at cursor position", () => {
      expect(actions.yank!(snap("hd", 1), ["ello worl"])).toEqual({
        value: "hello world",
        cursor: 10,
      });
    });

    it("uses most recent kill", () => {
      expect(actions.yank!(snap("", 0), ["first", "second"])).toEqual({
        value: "second",
        cursor: 6,
      });
    });

    it("no-op with empty kill ring", () => {
      expect(actions.yank!(snap("hello", 5), [])).toEqual({});
    });
  });

  // Transposition
  describe("transpose", () => {
    it("swaps char before and at cursor", () => {
      expect(actions.transpose!(snap("abcd", 2), [])).toEqual({
        value: "acbd",
        cursor: 3,
      });
    });

    it("swaps last two chars at end of line", () => {
      expect(actions.transpose!(snap("abcd", 4), [])).toEqual({
        value: "abdc",
        cursor: 4,
      });
    });

    it("no-op at position 0", () => {
      expect(actions.transpose!(snap("abcd", 0), [])).toEqual({});
    });

    it("no-op with less than 2 chars", () => {
      expect(actions.transpose!(snap("a", 1), [])).toEqual({});
    });
  });
});

// ── Kill ring accumulation ──────────────────────────────────────────────────

describe("kill ring", () => {
  it("accumulates kills and yank uses the most recent", () => {
    const killRing: string[] = [];

    const r1 = actions.killToEnd!(snap("hello world", 5), killRing);
    expect(r1.killed).toBe(" world");
    killRing.push(r1.killed!);

    const r2 = actions.killToStart!(snap("hello", 2), killRing);
    expect(r2.killed).toBe("he");
    killRing.push(r2.killed!);

    const r3 = actions.yank!(snap("llo", 0), killRing);
    expect(r3.value).toBe("hello");
  });
});

// ── LineEditor class ────────────────────────────────────────────────────────

describe("LineEditor", () => {
  it("starts with empty state", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    expect(editor.state).toEqual({ value: "", cursor: 0 });
    editor.destroy();
  });

  it("inserts text on null keystroke", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    editor.handleInput(null, "hello");
    expect(editor.state).toEqual({ value: "hello", cursor: 5 });
    editor.destroy();
  });

  it("notifies listeners on state change", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    const listener = vi.fn();
    editor.onStateChange(listener);

    editor.handleInput(null, "a");
    expect(listener).toHaveBeenCalledTimes(1);

    editor.handleInput(null, "b");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(editor.state.value).toBe("ab");
    editor.destroy();
  });

  it("unsubscribe stops notifications", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    const listener = vi.fn();
    const unsub = editor.onStateChange(listener);

    editor.handleInput(null, "a");
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    editor.handleInput(null, "b");
    expect(listener).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it("destroy clears all listeners", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    const listener = vi.fn();
    editor.onStateChange(listener);

    editor.destroy();
    editor.handleInput(null, "a");
    expect(listener).not.toHaveBeenCalled();
  });

  it("snapshot is referentially stable when unchanged", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    const s1 = editor.state;
    // Tab is a no-op — no state change
    editor.handleInput("tab", "");
    const s2 = editor.state;
    expect(s1).toBe(s2);
    editor.destroy();
  });

  it("submits trimmed value on return", () => {
    const onSubmit = vi.fn();
    const editor = new LineEditor({ onSubmit });

    editor.handleInput(null, "  hello  ");
    editor.handleInput("return", "");

    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(editor.state).toEqual({ value: "", cursor: 0 });
    editor.destroy();
  });

  it("does not submit empty input", () => {
    const onSubmit = vi.fn();
    const editor = new LineEditor({ onSubmit });

    editor.handleInput("return", "");
    expect(onSubmit).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("handles bindings (ctrl+a → lineStart)", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    editor.handleInput(null, "hello");
    expect(editor.state.cursor).toBe(5);

    editor.handleInput("ctrl+a", "");
    expect(editor.state.cursor).toBe(0);
    editor.destroy();
  });

  it("history navigation with up/down", () => {
    const onSubmit = vi.fn();
    const editor = new LineEditor({ onSubmit });

    editor.handleInput(null, "first");
    editor.handleInput("return", "");
    editor.handleInput(null, "second");
    editor.handleInput("return", "");

    // Up → "second"
    editor.handleInput("up", "");
    expect(editor.state.value).toBe("second");

    // Up → "first"
    editor.handleInput("up", "");
    expect(editor.state.value).toBe("first");

    // Down → "second"
    editor.handleInput("down", "");
    expect(editor.state.value).toBe("second");

    // Down → back to empty (saved input was "")
    editor.handleInput("down", "");
    expect(editor.state.value).toBe("");
    editor.destroy();
  });

  it("preserves in-progress input during history nav", () => {
    const onSubmit = vi.fn();
    const editor = new LineEditor({ onSubmit });

    editor.handleInput(null, "old");
    editor.handleInput("return", "");

    editor.handleInput(null, "work in progress");
    editor.handleInput("up", "");
    expect(editor.state.value).toBe("old");

    editor.handleInput("down", "");
    expect(editor.state.value).toBe("work in progress");
    editor.destroy();
  });

  it("setValue sets value and cursor to end", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    editor.setValue("hello");
    expect(editor.state).toEqual({ value: "hello", cursor: 5 });
    editor.destroy();
  });

  it("clear resets to empty", () => {
    const editor = new LineEditor({ onSubmit: () => {} });
    editor.handleInput(null, "hello");
    editor.clear();
    expect(editor.state).toEqual({ value: "", cursor: 0 });
    editor.destroy();
  });

  it("supports custom bindings", () => {
    const editor = new LineEditor({
      onSubmit: () => {},
      bindings: { "ctrl+x": "lineStart" },
    });
    editor.handleInput(null, "hello");
    editor.handleInput("ctrl+x", "");
    expect(editor.state.cursor).toBe(0);

    // Default binding should NOT work
    editor.handleInput("ctrl+a", "");
    expect(editor.state.cursor).toBe(0); // still 0 — ctrl+a inserted nothing because it's unbound
    editor.destroy();
  });
});

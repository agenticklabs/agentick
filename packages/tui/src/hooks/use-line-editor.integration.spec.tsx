/**
 * Integration tests for useLineEditor + RichTextInput.
 *
 * These tests render a real Ink component, simulate keystrokes via stdin.write,
 * and verify the rendered output. They test the full pipeline:
 *   stdin → Ink key parser → useInput → handleInput → RichTextInput → frame
 *
 * The test harness owns useInput and routes all keys to editor.handleInput,
 * matching the centralized input routing pattern used in production.
 *
 * Cursor position is verified indirectly: move the cursor, type a character,
 * check where it was inserted.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text, useInput } from "ink";
import { useLineEditor } from "./use-line-editor.js";
import { RichTextInput } from "../components/RichTextInput.js";
import { flush, waitFor } from "../testing.js";

// ── Terminal escape sequences ───────────────────────────────────────────────
// These are the raw bytes that terminals send for each key combination.

const K = {
  // Ctrl sequences (ASCII control chars)
  ctrlA: "\x01",
  ctrlB: "\x02",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlF: "\x06",
  ctrlK: "\x0b",
  ctrlT: "\x14",
  ctrlU: "\x15",
  ctrlW: "\x17",
  ctrlY: "\x19",

  // Special keys
  enter: "\r",
  // In a real terminal, Backspace sends \x7f which Ink maps to key.backspace.
  // But ink-testing-library doesn't wire up Node's readline keypress parser,
  // so \x7f maps to key.delete instead. Use Ctrl+H (\x08) which our bindings
  // map to deleteBackward — same end result, works in both environments.
  backspace: "\x08",
  delete: "\x1b[3~",

  // Arrow keys (ANSI escape sequences)
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",

  // Alt/Meta sequences (escape prefix + char)
  altF: "\x1bf",
  altB: "\x1bb",
  altD: "\x1bd",
};

// ── Test harness ────────────────────────────────────────────────────────────

function TestEditor({
  onSubmit,
  onValue,
}: {
  onSubmit: (v: string) => void;
  onValue?: (v: string, cursor: number) => void;
}) {
  const editor = useLineEditor({ onSubmit });

  // The harness owns useInput and routes all keys to the editor
  useInput((input, key) => {
    editor.handleInput(input, key);
  });

  // Expose value/cursor to tests via callback
  if (onValue) onValue(editor.value, editor.cursor);

  return (
    <Box>
      <Text>{">"}</Text>
      <RichTextInput value={editor.value} cursor={editor.cursor} />
    </Box>
  );
}

// Helper: type text and flush
async function type(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await flush();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("useLineEditor integration", () => {
  // ── Basic input ─────────────────────────────────────────────────────────

  it("accepts typed characters", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");

    expect(lastFrame()!).toContain("hello");
  });

  it("submits on Enter and clears input", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.enter);

    expect(onSubmit).toHaveBeenCalledWith("hello world");
    await waitFor(() => {
      expect(lastFrame()!).not.toContain("hello");
    });
  });

  it("trims whitespace on submit", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, "  hello  ");
    await type(stdin, K.enter);

    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it("does not submit empty input", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, K.enter);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit whitespace-only input", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, "   ");
    await type(stdin, K.enter);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  // ── Cursor movement ─────────────────────────────────────────────────────
  // Strategy: move cursor, type a character, verify insertion position.

  it("Ctrl+A moves cursor to start of line", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.ctrlA);
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("xhello");
    });
  });

  it("Ctrl+E moves cursor to end of line", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.ctrlA); // go to start
    await type(stdin, K.ctrlE); // go back to end
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("hellox");
    });
  });

  it("Ctrl+F moves cursor forward one character", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.ctrlA); // cursor at 0
    await type(stdin, K.ctrlF); // cursor at 1
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("hxello");
    });
  });

  it("Ctrl+B moves cursor backward one character", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.ctrlB); // cursor at 4
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("hellxo");
    });
  });

  it("left arrow moves cursor backward", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.left);
    await type(stdin, K.left);
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("helxlo");
    });
  });

  it("right arrow moves cursor forward", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.ctrlA);
    await type(stdin, K.right);
    await type(stdin, K.right);
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("hexllo");
    });
  });

  it("Alt+F moves cursor forward by word", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.ctrlA); // cursor at 0
    await type(stdin, K.altF); // cursor at 5 (end of "hello")
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("hellox world");
    });
  });

  it("Alt+B moves cursor backward by word", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.altB); // cursor at 6 (start of "world")
    await type(stdin, "x");

    await waitFor(() => {
      expect(lastFrame()!).toContain("hello xworld");
    });
  });

  // ── Deletion ────────────────────────────────────────────────────────────

  it("Backspace deletes character before cursor", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.backspace);

    await waitFor(() => {
      expect(lastFrame()!).toContain("hell");
      expect(lastFrame()!).not.toContain("hello");
    });
  });

  it("Ctrl+D deletes character at cursor (forward delete)", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.ctrlA); // cursor at 0
    await type(stdin, K.ctrlD); // delete 'h'

    await waitFor(() => {
      expect(lastFrame()!).toContain("ello");
      expect(lastFrame()!).not.toContain("hello");
    });
  });

  it("Delete key also deletes backward (same as Backspace in Ink)", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    await type(stdin, K.delete); // at end, deletes 'o'

    await waitFor(() => {
      expect(lastFrame()!).toContain("hell");
      expect(lastFrame()!).not.toContain("hello");
    });
  });

  // ── Kill & Yank ─────────────────────────────────────────────────────────

  it("Ctrl+K kills from cursor to end of line", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.ctrlA);
    // Move to position 5 (after "hello")
    for (let i = 0; i < 5; i++) await type(stdin, K.ctrlF);
    await type(stdin, K.ctrlK);

    await waitFor(() => {
      expect(lastFrame()!).toContain("hello");
      expect(lastFrame()!).not.toContain("world");
    });
  });

  it("Ctrl+U kills from start of line to cursor", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    // cursor is at 11 (end). Move back to position 6
    for (let i = 0; i < 5; i++) await type(stdin, K.ctrlB);
    await type(stdin, K.ctrlU);

    await waitFor(() => {
      expect(lastFrame()!).toContain("world");
      expect(lastFrame()!).not.toContain("hello");
    });
  });

  it("Ctrl+W kills word backward", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.ctrlW); // kills "world"

    await waitFor(() => {
      expect(lastFrame()!).toContain("hello");
      expect(lastFrame()!).not.toContain("world");
    });
  });

  it("Alt+D kills word forward", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.ctrlA); // cursor at 0
    await type(stdin, K.altD); // kills "hello"

    await waitFor(() => {
      expect(lastFrame()!).toContain("world");
      expect(lastFrame()!).not.toContain("hello");
    });
  });

  it("Ctrl+Y yanks the last killed text", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.ctrlW); // kill "world"

    await waitFor(() => {
      expect(lastFrame()!).not.toContain("world");
    });

    await type(stdin, K.ctrlY); // yank "world" back

    await waitFor(() => {
      expect(lastFrame()!).toContain("world");
    });
  });

  it("Ctrl+K then Ctrl+Y round-trips killed text", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello world");
    await type(stdin, K.ctrlA);
    // Move to position 5
    for (let i = 0; i < 5; i++) await type(stdin, K.ctrlF);

    await type(stdin, K.ctrlK); // kill " world"
    await waitFor(() => {
      expect(lastFrame()!).not.toContain("world");
    });

    await type(stdin, K.ctrlE); // cursor to end (which is after "hello")
    await type(stdin, K.ctrlY); // yank " world"

    await waitFor(() => {
      expect(lastFrame()!).toContain("hello world");
    });
  });

  // ── Transpose ───────────────────────────────────────────────────────────

  it("Ctrl+T transposes characters at end of line", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "ab");
    await type(stdin, K.ctrlT); // swap 'a' and 'b' → "ba"

    await waitFor(() => {
      expect(lastFrame()!).toContain("ba");
    });
  });

  it("Ctrl+T transposes characters mid-line", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "abcd");
    await type(stdin, K.ctrlA);
    await type(stdin, K.ctrlF); // cursor at 1
    await type(stdin, K.ctrlT); // swap 'a' and 'b' → "bacd"

    await waitFor(() => {
      expect(lastFrame()!).toContain("bacd");
    });
  });

  // ── History ─────────────────────────────────────────────────────────────

  it("Up arrow recalls previous submission", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, "first");
    await type(stdin, K.enter);
    await flush();

    await type(stdin, "second");
    await type(stdin, K.enter);
    await flush();

    // Press Up → should show "second"
    await type(stdin, K.up);

    await waitFor(() => {
      expect(lastFrame()!).toContain("second");
    });
  });

  it("Up arrow twice recalls older submission", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, "first");
    await type(stdin, K.enter);
    await flush();

    await type(stdin, "second");
    await type(stdin, K.enter);
    await flush();

    await type(stdin, K.up); // "second"
    await type(stdin, K.up); // "first"

    await waitFor(() => {
      expect(lastFrame()!).toContain("first");
    });
  });

  it("Down arrow returns to newer entry then current input", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, "first");
    await type(stdin, K.enter);
    await flush();

    await type(stdin, "second");
    await type(stdin, K.enter);
    await flush();

    // Type something, then navigate history, then come back
    await type(stdin, "current");
    await type(stdin, K.up); // "second"
    await type(stdin, K.up); // "first"
    await type(stdin, K.down); // "second"

    await waitFor(() => {
      expect(lastFrame()!).toContain("second");
    });

    await type(stdin, K.down); // back to "current"

    await waitFor(() => {
      expect(lastFrame()!).toContain("current");
    });
  });

  it("history preserves input that was being typed", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TestEditor onSubmit={onSubmit} />);
    await flush();

    await type(stdin, "old");
    await type(stdin, K.enter);
    await flush();

    await type(stdin, "work in progress");
    await type(stdin, K.up); // "old"
    await type(stdin, K.down); // back to "work in progress"

    await waitFor(() => {
      expect(lastFrame()!).toContain("work in progress");
    });
  });

  // ── Ctrl+C passthrough ────────────────────────────────────────────────

  it("does not consume Ctrl+C", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    // Ctrl+C should not affect the input
    stdin.write("\x03");
    await flush();

    expect(lastFrame()!).toContain("hello");
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("handles rapid sequential edits", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "abcde");
    await type(stdin, K.ctrlA);
    await type(stdin, K.ctrlD); // delete 'a'
    await type(stdin, K.ctrlD); // delete 'b'
    await type(stdin, K.ctrlD); // delete 'c'

    await waitFor(() => {
      expect(lastFrame()!).toContain("de");
    });
  });

  it("backspace at start of line is a no-op", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hi");
    await type(stdin, K.ctrlA);
    await type(stdin, K.backspace); // should do nothing

    await waitFor(() => {
      expect(lastFrame()!).toContain("hi");
    });
  });

  it("Ctrl+D at end of line is a no-op", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hi");
    await type(stdin, K.ctrlD); // cursor at end, should do nothing

    await waitFor(() => {
      expect(lastFrame()!).toContain("hi");
    });
  });

  it("handles paste (multi-character input)", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    // Simulate paste — Ink delivers it as a single multi-char input
    await type(stdin, "hello world foo bar");

    expect(lastFrame()!).toContain("hello world foo bar");
  });

  it("cursor clamps when value is empty", async () => {
    const { stdin, lastFrame } = render(<TestEditor onSubmit={() => {}} />);
    await flush();

    await type(stdin, "hello");
    // Kill entire line
    await type(stdin, K.ctrlU);

    await waitFor(() => {
      expect(lastFrame()!).not.toContain("hello");
    });

    // Type new text — should work normally
    await type(stdin, "world");

    await waitFor(() => {
      expect(lastFrame()!).toContain("world");
    });
  });
});

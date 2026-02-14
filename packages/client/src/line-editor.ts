/**
 * LineEditor — framework-agnostic readline-quality line editor.
 *
 * Manages buffer, cursor, kill ring, history, and keybindings.
 * Accepts normalized keystroke strings — each UI layer provides
 * its own normalizer (e.g., Ink's Key → "ctrl+a").
 *
 * Follows the same snapshot + onStateChange pattern as MessageSteering
 * and ChatSession for easy integration with useSyncExternalStore.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface LineEditorOptions {
  onSubmit: (value: string) => void;
  bindings?: Record<string, string>;
}

export interface LineEditorSnapshot {
  readonly value: string;
  readonly cursor: number;
}

export interface EditorUpdate {
  value?: string;
  cursor?: number;
  killed?: string;
}

// ── Word boundaries ─────────────────────────────────────────────────────────

export function findWordBoundaryForward(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && !/\w/.test(value[i]!)) i++;
  while (i < value.length && /\w/.test(value[i]!)) i++;
  return i;
}

export function findWordBoundaryBackward(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !/\w/.test(value[i - 1]!)) i--;
  while (i > 0 && /\w/.test(value[i - 1]!)) i--;
  return i;
}

// ── Actions (pure functions of editor state) ────────────────────────────────

export const actions: Record<
  string,
  (state: LineEditorSnapshot, killRing: string[]) => EditorUpdate
> = {
  lineStart: () => ({ cursor: 0 }),
  lineEnd: (s) => ({ cursor: s.value.length }),
  charForward: (s) => ({ cursor: Math.min(s.cursor + 1, s.value.length) }),
  charBackward: (s) => ({ cursor: Math.max(s.cursor - 1, 0) }),
  wordForward: (s) => ({ cursor: findWordBoundaryForward(s.value, s.cursor) }),
  wordBackward: (s) => ({ cursor: findWordBoundaryBackward(s.value, s.cursor) }),

  deleteForward: (s) => {
    if (s.cursor >= s.value.length) return {};
    return {
      value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1),
    };
  },

  deleteBackward: (s) => {
    if (s.cursor === 0) return {};
    return {
      value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor),
      cursor: s.cursor - 1,
    };
  },

  killToEnd: (s) => {
    if (s.cursor >= s.value.length) return {};
    const killed = s.value.slice(s.cursor);
    return { value: s.value.slice(0, s.cursor), killed };
  },

  killToStart: (s) => {
    if (s.cursor === 0) return {};
    const killed = s.value.slice(0, s.cursor);
    return { value: s.value.slice(s.cursor), cursor: 0, killed };
  },

  killWordBackward: (s) => {
    if (s.cursor === 0) return {};
    const boundary = findWordBoundaryBackward(s.value, s.cursor);
    const killed = s.value.slice(boundary, s.cursor);
    return {
      value: s.value.slice(0, boundary) + s.value.slice(s.cursor),
      cursor: boundary,
      killed,
    };
  },

  killWordForward: (s) => {
    if (s.cursor >= s.value.length) return {};
    const boundary = findWordBoundaryForward(s.value, s.cursor);
    const killed = s.value.slice(s.cursor, boundary);
    return {
      value: s.value.slice(0, s.cursor) + s.value.slice(boundary),
      killed,
    };
  },

  yank: (s, killRing) => {
    if (killRing.length === 0) return {};
    const text = killRing[killRing.length - 1]!;
    return {
      value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor),
      cursor: s.cursor + text.length,
    };
  },

  transpose: (s) => {
    if (s.value.length < 2) return {};
    if (s.cursor === 0) return {};
    let i: number;
    let j: number;
    if (s.cursor >= s.value.length) {
      i = s.cursor - 2;
      j = s.cursor - 1;
    } else {
      i = s.cursor - 1;
      j = s.cursor;
    }
    const chars = [...s.value];
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    return {
      value: chars.join(""),
      cursor: j + 1,
    };
  },
};

// ── Default bindings ────────────────────────────────────────────────────────

export const DEFAULT_BINDINGS: Record<string, string> = {
  "ctrl+a": "lineStart",
  "ctrl+e": "lineEnd",
  "ctrl+f": "charForward",
  "ctrl+b": "charBackward",
  "meta+f": "wordForward",
  "meta+b": "wordBackward",
  "meta+right": "wordForward",
  "meta+left": "wordBackward",
  left: "charBackward",
  right: "charForward",
  "ctrl+d": "deleteForward",
  "ctrl+h": "deleteBackward",
  backspace: "deleteBackward",
  delete: "deleteBackward",
  "ctrl+k": "killToEnd",
  "ctrl+u": "killToStart",
  "ctrl+w": "killWordBackward",
  "meta+d": "killWordForward",
  "ctrl+y": "yank",
  "ctrl+t": "transpose",
};

// ── LineEditor class ────────────────────────────────────────────────────────

const EMPTY_SNAPSHOT: LineEditorSnapshot = { value: "", cursor: 0 };

export class LineEditor {
  private _value = "";
  private _cursor = 0;
  private _killRing: string[] = [];
  private _history: string[] = [];
  private _historyIndex = -1;
  private _savedInput = "";

  private readonly _bindings: Record<string, string>;
  private readonly _onSubmit: (value: string) => void;

  private _snapshot: LineEditorSnapshot = EMPTY_SNAPSHOT;
  private _listeners = new Set<() => void>();

  constructor(options: LineEditorOptions) {
    this._onSubmit = options.onSubmit;
    this._bindings = options.bindings ?? DEFAULT_BINDINGS;
  }

  get state(): LineEditorSnapshot {
    return this._snapshot;
  }

  /**
   * Process a keystroke. `keystroke` is a normalized string like "ctrl+a",
   * "return", "up", "tab", etc., or `null` for regular text input.
   * `text` is the raw input string (used for character insertion).
   */
  handleInput(keystroke: string | null, text: string): void {
    const val = this._value;
    const cur = Math.min(this._cursor, val.length);

    // Enter → submit
    if (keystroke === "return") {
      const trimmed = val.trim();
      if (trimmed) {
        this._history.push(val);
        this._historyIndex = -1;
        this._savedInput = "";
        this._onSubmit(trimmed);
        this._update("", 0);
      }
      return;
    }

    // History navigation
    if (keystroke === "up") {
      const history = this._history;
      if (history.length === 0) return;
      if (this._historyIndex === -1) {
        this._savedInput = val;
        this._historyIndex = history.length - 1;
      } else if (this._historyIndex > 0) {
        this._historyIndex--;
      } else {
        return; // already at oldest
      }
      const entry = history[this._historyIndex]!;
      this._update(entry, entry.length);
      return;
    }

    if (keystroke === "down") {
      if (this._historyIndex === -1) return;
      const history = this._history;
      if (this._historyIndex < history.length - 1) {
        this._historyIndex++;
        const entry = history[this._historyIndex]!;
        this._update(entry, entry.length);
      } else {
        this._historyIndex = -1;
        const saved = this._savedInput;
        this._update(saved, saved.length);
      }
      return;
    }

    // Tab and escape — pass through for now (future: completion)
    if (keystroke === "tab" || keystroke === "escape") return;

    // Check bindings
    if (keystroke) {
      const actionName = this._bindings[keystroke];
      if (actionName) {
        const action = actions[actionName];
        if (action) {
          const snap: LineEditorSnapshot = { value: val, cursor: cur };
          const result = action(snap, this._killRing);
          const newValue = result.value ?? val;
          const newCursor = result.cursor ?? cur;
          if (result.killed) {
            this._killRing.push(result.killed);
          }
          this._update(newValue, newCursor);
          return;
        }
      }
    }

    // Regular character input
    if (!keystroke && text.length > 0) {
      const newValue = val.slice(0, cur) + text + val.slice(cur);
      this._update(newValue, cur + text.length);
    }
  }

  setValue(value: string): void {
    this._update(value, value.length);
  }

  clear(): void {
    this._update("", 0);
  }

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._listeners.clear();
  }

  private _update(value: string, cursor: number): void {
    this._value = value;
    this._cursor = cursor;
    this._snapshot = { value, cursor };
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // Listeners should not throw
      }
    }
  }
}

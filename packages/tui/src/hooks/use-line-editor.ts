/**
 * useLineEditor — readline-quality line editing for Ink.
 *
 * Manages buffer, cursor, kill ring, history, and keybindings.
 * Uses Ink's useInput internally. No rendering — pure editing logic.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useInput } from "ink";
import type { Key } from "ink";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UseLineEditorOptions {
  value?: string;
  onChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  isActive?: boolean;
}

export interface LineEditorState {
  value: string;
  cursor: number;
}

export interface LineEditorResult {
  value: string;
  cursor: number;
  setValue: (value: string) => void;
  clear: () => void;
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

export const actions: Record<string, (state: LineEditorState, killRing: string[]) => EditorUpdate> =
  {
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
      // At position 0, nothing to transpose
      if (s.cursor === 0) return {};
      // At end of line or mid-line: swap char before cursor with char at cursor (or the two before if at end)
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

// ── Key normalization ───────────────────────────────────────────────────────

export function normalizeKeystroke(input: string, key: Key): string | null {
  if (key.return) return "return";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return key.meta ? "meta+left" : "left";
  if (key.rightArrow) return key.meta ? "meta+right" : "right";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";
  if (key.tab) return "tab";
  if (key.escape) return "escape";
  if (key.ctrl && input) return `ctrl+${input}`;
  if (key.meta && input) return `meta+${input}`;
  return null;
}

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
  // Ink maps both key.backspace and key.delete to the physical Backspace key
  // (\x7f on macOS). ink-text-input treats both as backward delete, and so do we.
  // Forward delete is Ctrl+D (standard readline).
  backspace: "deleteBackward",
  delete: "deleteBackward",
  "ctrl+k": "killToEnd",
  "ctrl+u": "killToStart",
  "ctrl+w": "killWordBackward",
  "meta+d": "killWordForward",
  "ctrl+y": "yank",
  "ctrl+t": "transpose",
};

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLineEditor({
  value: controlledValue,
  onChange,
  onSubmit,
  isActive = true,
}: UseLineEditorOptions): LineEditorResult {
  const isControlled = controlledValue !== undefined && onChange !== undefined;

  const [internalValue, setInternalValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const killRingRef = useRef<string[]>([]);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef("");

  const currentValue = isControlled ? controlledValue : internalValue;

  // Clamp cursor when controlled value changes externally (e.g., parent clears input)
  useEffect(() => {
    setCursor((prev) => Math.min(prev, currentValue.length));
  }, [currentValue]);

  const updateValue = useCallback(
    (newValue: string, newCursor: number) => {
      if (isControlled) {
        onChange(newValue);
      } else {
        setInternalValue(newValue);
      }
      setCursor(newCursor);
    },
    [isControlled, onChange],
  );

  const setValue = useCallback(
    (newValue: string) => {
      updateValue(newValue, newValue.length);
    },
    [updateValue],
  );

  const clear = useCallback(() => {
    updateValue("", 0);
  }, [updateValue]);

  useInput(
    (input, key) => {
      // Let Ctrl+C pass through — never consume it
      if (key.ctrl && input === "c") return;
      // Let Ctrl+L pass through (clear screen)
      if (key.ctrl && input === "l") return;

      // Clamp cursor in case controlled value changed externally
      const cur = Math.min(cursor, currentValue.length);

      const keystroke = normalizeKeystroke(input, key);

      // Enter → submit
      if (keystroke === "return") {
        const trimmed = currentValue.trim();
        if (trimmed) {
          historyRef.current.push(currentValue);
          historyIndexRef.current = -1;
          savedInputRef.current = "";
          onSubmit(trimmed);
          updateValue("", 0);
        }
        return;
      }

      // History navigation
      if (keystroke === "up") {
        const history = historyRef.current;
        if (history.length === 0) return;
        if (historyIndexRef.current === -1) {
          savedInputRef.current = currentValue;
          historyIndexRef.current = history.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current--;
        } else {
          return; // already at oldest
        }
        const entry = history[historyIndexRef.current]!;
        updateValue(entry, entry.length);
        return;
      }

      if (keystroke === "down") {
        if (historyIndexRef.current === -1) return;
        const history = historyRef.current;
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current++;
          const entry = history[historyIndexRef.current]!;
          updateValue(entry, entry.length);
        } else {
          // Restore saved input
          historyIndexRef.current = -1;
          const saved = savedInputRef.current;
          updateValue(saved, saved.length);
        }
        return;
      }

      // Tab and escape — pass through for now (future: completion)
      if (keystroke === "tab" || keystroke === "escape") return;

      // Check bindings
      if (keystroke) {
        const actionName = DEFAULT_BINDINGS[keystroke];
        if (actionName) {
          const action = actions[actionName];
          if (action) {
            const state: LineEditorState = { value: currentValue, cursor: cur };
            const update = action(state, killRingRef.current);
            const newValue = update.value ?? currentValue;
            const newCursor = update.cursor ?? cur;
            if (update.killed) {
              killRingRef.current.push(update.killed);
            }
            updateValue(newValue, newCursor);
            return;
          }
        }
      }

      // Regular character input (not a recognized binding)
      if (!keystroke && input.length > 0) {
        const newValue = currentValue.slice(0, cur) + input + currentValue.slice(cur);
        updateValue(newValue, cur + input.length);
      }
    },
    { isActive },
  );

  // Clamp for the render before the effect fires
  const clampedCursor = Math.min(cursor, currentValue.length);

  return { value: currentValue, cursor: clampedCursor, setValue, clear };
}

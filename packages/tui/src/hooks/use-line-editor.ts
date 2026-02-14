/**
 * useLineEditor — Ink-specific wrapper around @agentick/client's LineEditor.
 *
 * Converts Ink's (input, Key) pairs to normalized keystroke strings,
 * then delegates to the framework-agnostic LineEditor class.
 */

import { useMemo, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import type { Key } from "ink";
import { LineEditor } from "@agentick/client";
import type { CompletionState, CompletedRange } from "@agentick/client";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UseLineEditorOptions {
  onSubmit: (value: string) => void;
  bindings?: Record<string, string>;
}

export interface LineEditorResult {
  value: string;
  cursor: number;
  completion: CompletionState | null;
  completedRanges: readonly CompletedRange[];
  setValue: (value: string) => void;
  clear: () => void;
  handleInput: (input: string, key: Key) => void;
  editor: LineEditor;
}

// ── Ink key normalization ───────────────────────────────────────────────────

export function normalizeInkKeystroke(input: string, key: Key): string | null {
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

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLineEditor({ onSubmit, bindings }: UseLineEditorOptions): LineEditorResult {
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const editor = useMemo(
    () => new LineEditor({ onSubmit: (v) => onSubmitRef.current(v), bindings }),
    [],
  );

  useEffect(() => () => editor.destroy(), [editor]);

  const state = useSyncExternalStore(
    useCallback((cb) => editor.onStateChange(cb), [editor]),
    () => editor.state,
  );

  const handleInput = useCallback(
    (input: string, key: Key) => {
      // Let Ctrl+C pass through — never consume it
      if (key.ctrl && input === "c") return;
      // Let Ctrl+L pass through (clear screen)
      if (key.ctrl && input === "l") return;

      const keystroke = normalizeInkKeystroke(input, key);
      editor.handleInput(keystroke, input);
    },
    [editor],
  );

  return {
    value: state.value,
    cursor: state.cursor,
    completion: state.completion,
    completedRanges: state.completedRanges,
    setValue: useCallback((v: string) => editor.setValue(v), [editor]),
    clear: useCallback(() => editor.clear(), [editor]),
    handleInput,
    editor,
  };
}

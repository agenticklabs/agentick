/**
 * useLineEditor — React wrapper around @agentick/client's LineEditor.
 *
 * For web consumers. No key normalization included — the caller normalizes
 * DOM KeyboardEvent to keystroke strings and calls editor.handleInput directly,
 * or uses the returned LineEditor instance for full control.
 */

import { useMemo, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { LineEditor, type LineEditorOptions, type LineEditorSnapshot } from "@agentick/client";

export interface UseLineEditorOptions {
  onSubmit: (value: string) => void;
  bindings?: LineEditorOptions["bindings"];
}

export interface UseLineEditorResult {
  value: string;
  cursor: number;
  setValue: (value: string) => void;
  clear: () => void;
  /** Process a normalized keystroke. See LineEditor.handleInput. */
  handleInput: (keystroke: string | null, text: string) => void;
  /** Direct access to the underlying LineEditor instance. */
  editor: LineEditor;
}

const EMPTY: LineEditorSnapshot = { value: "", cursor: 0 };

export function useLineEditor(options: UseLineEditorOptions): UseLineEditorResult {
  const onSubmitRef = useRef(options.onSubmit);
  onSubmitRef.current = options.onSubmit;

  const editor = useMemo(
    () =>
      new LineEditor({
        onSubmit: (v) => onSubmitRef.current(v),
        bindings: options.bindings,
      }),
    [],
  );

  useEffect(() => () => editor.destroy(), [editor]);

  const state = useSyncExternalStore(
    useCallback((cb) => editor.onStateChange(cb), [editor]),
    () => editor.state,
    () => EMPTY,
  );

  return {
    value: state.value,
    cursor: state.cursor,
    setValue: useCallback((v: string) => editor.setValue(v), [editor]),
    clear: useCallback(() => editor.clear(), [editor]),
    handleInput: useCallback(
      (keystroke: string | null, text: string) => editor.handleInput(keystroke, text),
      [editor],
    ),
    editor,
  };
}

import { useEffect, useRef } from "react";
import type { LifecycleModelGenerateEnd } from "@agentick/spec";
import { useLifecycleDispatch } from "../lifecycle-context.js";

/**
 * `useOnModelGenerateEnd` — register a callback fired when a model
 * call finishes successfully (`model:generate` /
 * `model:generate_stream`, ADR 89 §1). A provider failure surfaces via
 * `useOnError` (`phase: "model"`) instead. Projected from
 * `onAfterModelGenerate[Stream]` via the session's per-send
 * call-scoped forwarders (ADR 89 §4).
 *
 * Fires on BOTH tick paths (streaming `model:generate_stream` and the
 * non-streaming `fx.run` composing through `model:generate`, ADR 89 §1);
 * see `useOnModelGenerateStart`.
 *
 * No catch-up.
 *
 * @example
 * useOnModelGenerateEnd((e) => setThinking(false));
 */
export function useOnModelGenerateEnd(
  callback: (event: LifecycleModelGenerateEnd) => void | Promise<void>,
): void {
  const dispatch = useLifecycleDispatch();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return dispatch.register("model-generate-end", (event) => ref.current(event));
  }, [dispatch]);
}

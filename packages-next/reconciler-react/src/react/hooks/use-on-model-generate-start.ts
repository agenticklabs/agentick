import { useEffect, useRef } from "react";
import type { LifecycleModelGenerateStart } from "@agentick/spec-next";
import { useLifecycleDispatch } from "../lifecycle-context.js";

/**
 * `useOnModelGenerateStart` — register a callback fired when a model
 * call starts (`model:generate` / `model:generate_stream`, ADR 89 §1).
 * Projected from `onBeforeModelGenerate[Stream]` via the session's
 * per-send call-scoped forwarders (ADR 89 §4), so it fires for
 * WHICHEVER executor instance runs the tick — including a per-tick
 * `<Model>`-swapped executor (ADR 56).
 *
 * NOTE: today only the STREAMING tick path mints the command — the
 * non-streaming `fx.run` bypasses it (TODO(adr-89-phase-next) in the
 * model executor), so this fires on streaming ticks only.
 *
 * No catch-up. Components that mount after the call started observe
 * the next one normally.
 *
 * @example
 * useOnModelGenerateStart((e) => setThinking(true));
 */
export function useOnModelGenerateStart(
  callback: (event: LifecycleModelGenerateStart) => void | Promise<void>,
): void {
  const dispatch = useLifecycleDispatch();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return dispatch.register("model-generate-start", (event) => ref.current(event));
  }, [dispatch]);
}

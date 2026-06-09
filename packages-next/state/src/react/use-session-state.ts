/**
 * `useSessionState` — session-internal reactive state.
 *
 * v2 analog of v1's `useComState`. Wraps the session's `StateHarness`
 * so component state survives across re-mounts / hibernate-resume.
 * Unlike `useKnob`, the values are NOT visible to the model — the
 * executor's `set_knob` tool does not reach here.
 *
 * Per ADR 26, `set` is an async Operation on the StateHarness; this
 * hook fires it fire-and-forget so the React setter API stays sync.
 * The initial value is seeded via an async set fired in `useEffect`;
 * `getSnapshot` falls back to `initial` until that set's microtask
 * resolves and the subscriber fires.
 *
 * @see packages/spec/src/protocol/state-harness.ts
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useBridges } from "@agentick/reconciler-react-next";

export function useSessionState<T>(key: string, initial: T): readonly [T, (value: T) => void] {
  const { state } = useBridges();

  // Seed the initial value if no entry yet exists. Fire-and-forget the
  // async Operation; subscribers fire on completion and useSyncExternal-
  // Store re-reads the now-present value. Until then `getSnapshot`
  // falls back to `initial`.
  useEffect(() => {
    if (!state.has(key)) {
      void state.set({ key, value: initial });
    }
  }, [state, key, initial]);

  const subscribe = useCallback(
    (listener: () => void) => state.subscribe(key, listener),
    [state, key],
  );
  const getSnapshot = useCallback(
    () => (state.has(key) ? (state.get(key) as T) : initial),
    [state, key, initial],
  );
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const set = useCallback(
    (next: T) => {
      void state.set({ key, value: next });
    },
    [state, key],
  );

  return [value, set] as const;
}

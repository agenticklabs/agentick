/**
 * `useSessionState` — session-internal reactive state.
 *
 * v2 analog of v1's `useComState`. Wraps a session-level key-value bag
 * (the `StateBridge`) so component state survives across re-mounts /
 * hibernate-resume. Unlike `useKnob`, the values are NOT visible to the
 * model — the executor's `set_knob` tool does not reach here.
 *
 * The hook owns initial registration: the first render registers the
 * initial value if no entry yet exists for `key`. Subsequent writes from
 * anywhere (other components, external `bridge.set`) trigger re-renders
 * of subscribed components via `useSyncExternalStore`.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §StateBridge
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D1
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useBridges } from "../bridge-context.js";

export function useSessionState<T>(key: string, initial: T): readonly [T, (value: T) => void] {
  const { state } = useBridges();

  const registered = useRef(false);
  if (!registered.current) {
    if (!state.has(key)) state.set(key, initial);
    registered.current = true;
  }

  const subscribe = useCallback(
    (listener: () => void) => state.subscribe(key, listener),
    [state, key],
  );
  const getSnapshot = useCallback(() => state.get(key) as T, [state, key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const set = useCallback(
    (next: T) => {
      state.set(key, next);
    },
    [state, key],
  );

  return [value, set] as const;
}

/**
 * `useKnob` — model-visible, reactive state managed by the harness.
 *
 * The hook owns initial registration: the first render of a component
 * calling `useKnob(id, initial)` registers `initial` if no value yet
 * exists for `id`. Subsequent updates from anywhere (other components,
 * external `bridge.set`, the `set_knob` tool) trigger re-renders of
 * components consuming the knob via `useSyncExternalStore`.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §KnobBridge
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useBridges } from "../bridge-context.js";

export function useKnob<T>(id: string, initial: T): readonly [T, (value: T) => void] {
  const { knobs } = useBridges();

  // Register initial value on first encounter of this id. Subsequent
  // renders see `registered.current` and skip.
  const registered = useRef(false);
  if (!registered.current) {
    if (knobs.get(id) === undefined) knobs.set(id, initial);
    registered.current = true;
  }

  const subscribe = useCallback(
    (listener: () => void) => knobs.subscribe(id, listener),
    [knobs, id],
  );
  const getSnapshot = useCallback(() => knobs.get(id) as T, [knobs, id]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const set = useCallback(
    (next: T) => {
      knobs.set(id, next);
    },
    [knobs, id],
  );

  return [value, set] as const;
}

/**
 * `useOnTickStart` — register a callback fired at tick-start.
 *
 * Components that mount mid-tick do NOT miss the current tick-start:
 * the per-mount `LifecycleDispatch` catches them up by invoking the
 * handler immediately on registration when a tick-start is active.
 *
 * The callback runs after React commits the render that registered
 * it. Catch-up fires inside `useEffect` and may trigger React state
 * updates that the render-until-stable loop will pick up on the next
 * iteration.
 *
 * @see packages-next/compiler/src/lifecycle-dispatch.ts
 */

import { useEffect, useRef } from "react";
import type { LifecycleTickStart } from "@agentick/spec-next";
import { useLifecycleDispatch } from "../lifecycle-context.js";

export function useOnTickStart(
  callback: (event: LifecycleTickStart) => void | Promise<void>,
): void {
  const dispatch = useLifecycleDispatch();
  // Capture the latest callback in a ref so the effect only registers
  // once per component instance, while still calling the freshest
  // closure on each invocation.
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return dispatch.register("tick-start", (event) => ref.current(event));
  }, [dispatch]);
}

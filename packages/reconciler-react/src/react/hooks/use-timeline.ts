/**
 * `useTimeline` — read the session's timeline as a reactive snapshot.
 *
 * Read-only. Writes go through session commands; the bridge is purely
 * an accessor. Backed by `useSyncExternalStore` so components re-render
 * when the timeline's `version` advances.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §TimelineBridge
 */

import { useCallback, useSyncExternalStore } from "react";
import type { TimelineSnapshot } from "@agentick/spec";
import { useBridges } from "../bridge-context.js";

export function useTimeline(): TimelineSnapshot {
  const { timeline } = useBridges();
  const subscribe = useCallback((listener: () => void) => timeline.subscribe(listener), [timeline]);
  const getSnapshot = useCallback(() => timeline.read(), [timeline]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

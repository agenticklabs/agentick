/**
 * `useTimeline` — read the session's timeline projection as a reactive
 * snapshot.
 *
 * Read-only from the React side. Writes go through session commands or
 * directly through the TimelineHarness's Operations (`append`, `compact`,
 * `replaceProjection`, `resetProjection`). Backed by `useSyncExternalStore`
 * so components re-render when the projection's `version` advances.
 *
 * Returns the projection (what's currently model-visible). For the
 * uncompacted durable log, call `bridges.timeline.readPersisted()` via
 * `useBridges()`.
 *
 * @see packages/spec/src/protocol/timeline-harness.ts
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

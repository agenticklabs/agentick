import type { COMTimelineEntry } from "../com/types.js";
import { useRuntimeStore } from "./runtime-context.js";

export function useTimeline() {
  const store = useRuntimeStore();
  return {
    /** Current timeline entries (session's full history) */
    entries: store.getSessionTimeline(),
    /** Replace the entire timeline */
    set: (entries: COMTimelineEntry[]) => store.setSessionTimeline(entries),
    /** Transform the timeline via a function */
    update: (fn: (entries: COMTimelineEntry[]) => COMTimelineEntry[]) =>
      store.setSessionTimeline(fn(store.getSessionTimeline())),
  };
}

/**
 * Timeline append-event domain + subscriber query helper.
 */

import { describe, expect, it } from "vitest";
import {
  TIMELINE_APPEND_EVENT_NAME,
  TIMELINE_APPEND_VERB,
  TIMELINE_SURFACE,
  timelineEventQuery,
} from "../data/timeline.js";

describe("timeline append event naming", () => {
  it("pins the surface, verb, and the derived op-name event name", () => {
    expect(TIMELINE_SURFACE).toBe("timeline");
    expect(TIMELINE_APPEND_VERB).toBe("timeline:append");
    // The verb `timeline:append` maps to `<surface>:command:<rest>` on the bus.
    expect(TIMELINE_APPEND_EVENT_NAME).toBe("timeline:command:append");
  });

  it("timelineEventQuery selects the entries-carrying (requested) append envelope", () => {
    expect(timelineEventQuery()).toEqual({
      surface: "timeline",
      name: { exact: "timeline:command:append" },
      phase: "requested",
    });
  });

  it("the query FQN agrees with TIMELINE_APPEND_EVENT_NAME (one source of truth)", () => {
    const q = timelineEventQuery();
    expect(q.name).toEqual({ exact: TIMELINE_APPEND_EVENT_NAME });
  });
});

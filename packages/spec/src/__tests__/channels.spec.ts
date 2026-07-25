/**
 * Channel event-name domain + subscriber query helper.
 */

import { describe, expect, it } from "vitest";
import {
  CHANNEL_NAME_DOMAIN,
  CHANNEL_SURFACE,
  channelEventName,
  channelEventQuery,
} from "../data/channels.js";

describe("channel event naming", () => {
  it("builds the canonical session:channel:<name> FQN", () => {
    expect(channelEventName("knobs-state")).toBe("session:channel:knobs-state");
    expect(channelEventName("task-status")).toBe("session:channel:task-status");
    expect(CHANNEL_SURFACE).toBe("session");
    expect(CHANNEL_NAME_DOMAIN).toBe("channel");
  });

  it("channelEventQuery matches exactly one channel on the session surface", () => {
    expect(channelEventQuery("knobs-state")).toEqual({
      surface: "session",
      name: { exact: "session:channel:knobs-state" },
    });
  });

  it("the query FQN agrees with channelEventName (one source of truth)", () => {
    const q = channelEventQuery("task-status");
    expect(q.name).toEqual({ exact: channelEventName("task-status") });
  });
});

import { describe, expect, it } from "vitest";

import { anthropic } from "../index.js";

describe("the cache record", () => {
  it("states what the provider publishes about a cached prefix", () => {
    expect(anthropic("claude-sonnet-4-5").target.capabilities?.cache).toEqual({
      ttlMs: 300_000,
      extendedTtlMs: 3_600_000,
      refreshedOnRead: true,
      explicit: { kind: "breakpoint", maxBoundaries: 4 },
    });
  });
});

import { describe, expect, it } from "vitest";

import { openai } from "../index.js";

describe("the cache record", () => {
  it("states what the provider publishes about a cached prefix", () => {
    expect(openai("gpt-4o-mini").target.capabilities?.cache).toEqual({
      ttlMs: 300_000,
      extendedTtlMs: 86_400_000,
      refreshedOnRead: true,
    });
  });
});

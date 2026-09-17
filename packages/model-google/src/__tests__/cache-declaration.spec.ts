import { describe, expect, it } from "vitest";

import { google } from "../index.js";

describe("the cache record", () => {
  it("states what the provider publishes about a cached prefix", () => {
    expect(google("gemini-3.5-flash").target.capabilities?.cache).toEqual({});
  });
});

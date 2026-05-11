import { describe, expect, it } from "vitest";
import { SPEC_VERSION } from "../version.js";

describe("SPEC_VERSION", () => {
  it("is a date string in YYYY-MM-DD format", () => {
    expect(SPEC_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

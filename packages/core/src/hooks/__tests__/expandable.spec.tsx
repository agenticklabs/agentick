import { describe, it, expect } from "vitest";
import { Expandable } from "../../hooks";
import { Knobs } from "../../hooks";
import { compileAgent } from "../../testing";

describe("Expandable minimal", () => {
  it("should compile without infinite loop", async () => {
    function Agent() {
      return (
        <>
          <Expandable name="test-expand" summary="Test">
            Hidden
          </Expandable>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { InputBar } from "./InputBar.js";
import { flush } from "../testing.js";

describe("InputBar", () => {
  it("renders with default placeholder when enabled", async () => {
    const { lastFrame } = render(<InputBar onSubmit={() => {}} />);
    await flush();

    expect(lastFrame()!).toContain("Type a message...");
  });

  it("renders disabled placeholder when isDisabled", async () => {
    const { lastFrame } = render(<InputBar onSubmit={() => {}} isDisabled />);
    await flush();

    expect(lastFrame()!).toContain("Waiting for response...");
  });

  it("renders custom placeholder", async () => {
    const { lastFrame } = render(<InputBar onSubmit={() => {}} placeholder="Custom text..." />);
    await flush();

    expect(lastFrame()!).toContain("Custom text...");
  });

  it("renders custom placeholder even when disabled", async () => {
    const { lastFrame } = render(
      <InputBar onSubmit={() => {}} isDisabled placeholder="Confirm above..." />,
    );
    await flush();

    expect(lastFrame()!).toContain("Confirm above...");
  });
});

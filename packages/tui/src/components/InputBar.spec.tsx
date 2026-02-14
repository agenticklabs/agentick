import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { InputBar } from "./InputBar.js";
import { flush } from "../testing.js";

describe("InputBar", () => {
  it("renders value text", async () => {
    const { lastFrame } = render(<InputBar value="hello world" cursor={11} />);
    await flush();

    expect(lastFrame()!).toContain("hello world");
  });

  it("renders default placeholder when active and empty", async () => {
    const { lastFrame } = render(<InputBar value="" cursor={0} />);
    await flush();

    expect(lastFrame()!).toContain("Type a message...");
  });

  it("renders disabled placeholder when not active", async () => {
    const { lastFrame } = render(<InputBar value="" cursor={0} isActive={false} />);
    await flush();

    expect(lastFrame()!).toContain("Waiting for response...");
  });

  it("renders custom placeholder", async () => {
    const { lastFrame } = render(<InputBar value="" cursor={0} placeholder="Custom text..." />);
    await flush();

    expect(lastFrame()!).toContain("Custom text...");
  });

  it("renders custom placeholder even when not active", async () => {
    const { lastFrame } = render(
      <InputBar value="" cursor={0} isActive={false} placeholder="Confirm above..." />,
    );
    await flush();

    expect(lastFrame()!).toContain("Confirm above...");
  });
});

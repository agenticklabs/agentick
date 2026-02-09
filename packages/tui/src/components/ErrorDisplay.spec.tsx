import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ErrorDisplay } from "./ErrorDisplay.js";
import { flush } from "../testing.js";

describe("ErrorDisplay", () => {
  it("renders error message string", async () => {
    const { lastFrame } = render(<ErrorDisplay error="Something went wrong" />);
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("Error");
    expect(frame).toContain("Something went wrong");
  });

  it("renders Error object message", async () => {
    const { lastFrame } = render(<ErrorDisplay error={new Error("Connection failed")} />);
    await flush();

    expect(lastFrame()!).toContain("Connection failed");
  });

  it("returns null when error is null", async () => {
    const { lastFrame } = render(<ErrorDisplay error={null} />);
    await flush();

    // lastFrame() may be empty string or contain no error box
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Error");
  });

  it("shows dismiss hint when onDismiss is provided", async () => {
    const onDismiss = vi.fn();
    const { lastFrame } = render(<ErrorDisplay error="Oops" onDismiss={onDismiss} />);
    await flush();

    expect(lastFrame()!).toContain("Press any key to dismiss");
  });

  it("calls onDismiss on keypress", async () => {
    const onDismiss = vi.fn();
    const { stdin } = render(<ErrorDisplay error="Oops" onDismiss={onDismiss} />);
    await flush();

    stdin.write("x");
    await flush();

    expect(onDismiss).toHaveBeenCalled();
  });

  it("does not show dismiss hint without onDismiss", async () => {
    const { lastFrame } = render(<ErrorDisplay error="Oops" />);
    await flush();

    expect(lastFrame()!).not.toContain("Press any key to dismiss");
  });
});

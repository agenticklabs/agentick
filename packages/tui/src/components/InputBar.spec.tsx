import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { InputBar } from "./InputBar.js";
import { flush } from "../testing.js";

describe("InputBar", () => {
  // ── Uncontrolled mode (backwards compatible) ────────────────────────────

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

  // ── Controlled mode ─────────────────────────────────────────────────────

  it("renders controlled value", async () => {
    const { lastFrame } = render(
      <InputBar value="hello world" onChange={() => {}} onSubmit={() => {}} />,
    );
    await flush();

    expect(lastFrame()!).toContain("hello world");
  });

  it("calls onChange when typing in controlled mode", async () => {
    const onChange = vi.fn();
    const { stdin } = render(<InputBar value="" onChange={onChange} onSubmit={() => {}} />);
    await flush();

    stdin.write("a");
    await flush();

    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("calls onChange with empty string on submit in controlled mode", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar value="test" onChange={onChange} onSubmit={onSubmit} />);
    await flush();

    stdin.write("\r");
    await flush();

    expect(onSubmit).toHaveBeenCalledWith("test");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("does not submit empty input in controlled mode", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar value="   " onChange={() => {}} onSubmit={onSubmit} />);
    await flush();

    stdin.write("\r");
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit when disabled in controlled mode", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBar value="test" onChange={() => {}} onSubmit={onSubmit} isDisabled />,
    );
    await flush();

    stdin.write("\r");
    await flush();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders controlled placeholder", async () => {
    const { lastFrame } = render(
      <InputBar value="" onChange={() => {}} onSubmit={() => {}} placeholder="Streaming..." />,
    );
    await flush();

    expect(lastFrame()!).toContain("Streaming...");
  });
});

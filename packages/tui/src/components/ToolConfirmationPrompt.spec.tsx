import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ToolConfirmationPrompt } from "./ToolConfirmationPrompt.js";
import type { ToolConfirmationRequest } from "@agentick/client";
import { flush } from "../testing.js";

function makeRequest(overrides: Partial<ToolConfirmationRequest> = {}): ToolConfirmationRequest {
  return {
    toolUseId: "tool-1",
    name: "delete_file",
    arguments: { path: "/tmp/test.txt" },
    ...overrides,
  };
}

describe("ToolConfirmationPrompt", () => {
  let cleanup: (() => void) | undefined;
  afterEach(async () => {
    cleanup?.();
    cleanup = undefined;
    await flush();
  });

  it("renders tool name and arguments", async () => {
    const onRespond = vi.fn();
    const inst = render(<ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />);
    cleanup = inst.unmount;
    await flush();

    const frame = inst.lastFrame()!;
    expect(frame).toContain("delete_file");
    expect(frame).toContain("/tmp/test.txt");
    expect(frame).toContain("[Y] Approve");
    expect(frame).toContain("[N] Reject");
  });

  it("Y key calls onRespond with approved: true", async () => {
    const onRespond = vi.fn();
    const inst = render(<ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />);
    cleanup = inst.unmount;
    await flush();

    inst.stdin.write("y");
    await flush();

    expect(onRespond).toHaveBeenCalledWith({ approved: true });
  });

  it("N key calls onRespond with approved: false", async () => {
    const onRespond = vi.fn();
    const inst = render(<ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />);
    cleanup = inst.unmount;
    await flush();

    inst.stdin.write("n");
    await flush();

    expect(onRespond).toHaveBeenCalledWith({
      approved: false,
      reason: "rejected by user",
    });
  });

  it("A key calls onRespond with approved: true", async () => {
    const onRespond = vi.fn();
    const inst = render(<ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />);
    cleanup = inst.unmount;
    await flush();

    inst.stdin.write("a");
    await flush();

    expect(onRespond).toHaveBeenCalledWith({ approved: true });
  });

  it("shows message when present in request", async () => {
    const onRespond = vi.fn();
    const request = makeRequest({ message: "This will delete an important file" });
    const inst = render(<ToolConfirmationPrompt request={request} onRespond={onRespond} />);
    cleanup = inst.unmount;
    await flush();

    expect(inst.lastFrame()!).toContain("This will delete an important file");
  });

  it("truncates long arguments", async () => {
    const onRespond = vi.fn();
    const longArgs: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      longArgs[`key_${i}`] = `value_${i}`;
    }
    const request = makeRequest({ arguments: longArgs });
    const inst = render(<ToolConfirmationPrompt request={request} onRespond={onRespond} />);
    cleanup = inst.unmount;
    await flush();

    expect(inst.lastFrame()!).toContain("...");
  });
});

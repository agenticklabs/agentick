import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ToolConfirmationPrompt } from "./ToolConfirmationPrompt.js";
import type { ToolConfirmationRequest } from "@agentick/client";
import { flush, waitFor } from "../testing.js";

function makeRequest(overrides: Partial<ToolConfirmationRequest> = {}): ToolConfirmationRequest {
  return {
    toolUseId: "tool-1",
    name: "delete_file",
    arguments: { path: "/tmp/test.txt" },
    ...overrides,
  };
}

describe("ToolConfirmationPrompt", () => {
  it("renders tool name and arguments", async () => {
    const onRespond = vi.fn();
    const { lastFrame } = render(
      <ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />,
    );
    await flush();

    const frame = lastFrame()!;
    expect(frame).toContain("delete_file");
    expect(frame).toContain("/tmp/test.txt");
    expect(frame).toContain("[Y] Approve");
    expect(frame).toContain("[N] Reject");
  });

  it("Y key calls onRespond with approved: true", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />,
    );
    await flush();

    stdin.write("y");
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith({ approved: true }));
  });

  it("N key calls onRespond with approved: false", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />,
    );
    await flush();

    stdin.write("n");
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith({
        approved: false,
        reason: "rejected by user",
      }),
    );
  });

  it("A key calls onRespond with approved: true", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <ToolConfirmationPrompt request={makeRequest()} onRespond={onRespond} />,
    );
    await flush();

    stdin.write("a");
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith({ approved: true }));
  });

  it("shows message when present in request", async () => {
    const onRespond = vi.fn();
    const request = makeRequest({ message: "This will delete an important file" });
    const { lastFrame } = render(
      <ToolConfirmationPrompt request={request} onRespond={onRespond} />,
    );
    await flush();

    expect(lastFrame()!).toContain("This will delete an important file");
  });

  it("truncates long arguments", async () => {
    const onRespond = vi.fn();
    const longArgs: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      longArgs[`key_${i}`] = `value_${i}`;
    }
    const request = makeRequest({ arguments: longArgs });
    const { lastFrame } = render(
      <ToolConfirmationPrompt request={request} onRespond={onRespond} />,
    );
    await flush();

    expect(lastFrame()!).toContain("...");
  });
});

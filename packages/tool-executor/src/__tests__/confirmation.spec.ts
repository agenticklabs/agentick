/**
 * Confirmation flow tests (4a.5 + 4a.7, refactored onto BaseHarness.request).
 *
 * Tools declared `annotations.requiresConfirmation: true` pause after
 * validation and wait for an inbound `request-response` inbox message
 * routed by correlationId. Tests subscribe to the bus to capture the
 * outbound request envelope (which carries the correlationId in
 * metadata), then deliver a `request-response` to the harness's inbox.
 *
 * Approve → handler runs (modifiedArguments re-validated when set).
 * Deny    → DispatchResult{ succeeded: false, content: [denial] }.
 * Abort   → denial-shaped result with reason extracted from the abort
 *           reason (controller.signal.reason).
 * Timeout → ToolConfirmationTimeoutError (typed failure).
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";

import type {
  DispatchInput,
  MessageEnvelope,
  ToolConfirmationResponse,
  ToolRegistration,
} from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";

function confirmTool(name = "delete-file"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "risky",
      inputSchema: { type: "object" },
      exposure: ["model"],
      annotations: { requiresConfirmation: true },
    },
    handlerRef: `h.${name}`,
  };
}

function dispatchOf(
  name: string,
  toolCallId: string,
  input: unknown = {},
  overrides: Partial<DispatchInput> = {},
): DispatchInput {
  return {
    toolCallId,
    name,
    input,
    context: { via: "model" },
    ...overrides,
  };
}

/**
 * Wait for the next request envelope on `session:channel:tool_confirmation`
 * and return its `correlationId` + `replyTo`. The harness publishes a
 * request envelope when the confirmation gate trips.
 */
async function captureRequest(
  bus: { subscribe: (q: unknown) => Stream.Stream<unknown, unknown, never> },
): Promise<{ correlationId: string; replyTo: string }> {
  const chunk = await Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: "session:channel:tool_confirmation" },
        }) as Stream.Stream<{ metadata?: Record<string, unknown> }, unknown, never>,
        1,
      ),
    ),
  );
  const ev = Array.from(Chunk.toReadonlyArray(chunk))[0]!;
  const meta = ev.metadata ?? {};
  return {
    correlationId: meta.correlationId as string,
    replyTo: meta.replyTo as string,
  };
}

/**
 * Deliver a `request-response` inbox message — the generic shape
 * routed by `BaseHarness.dispatchMessage`.
 */
function deliverResponse(
  inbox: { send: (addr: string, msg: MessageEnvelope) => Effect.Effect<unknown, unknown, never> },
  replyTo: string,
  correlationId: string,
  response: ToolConfirmationResponse,
) {
  const msg: MessageEnvelope = {
    addressedTo: replyTo,
    type: "request-response",
    messageId: `m_${correlationId}`,
    timestamp: Date.now(),
    payload: { correlationId, response },
  };
  return Effect.runPromise(inbox.send(replyTo, msg));
}

describe("ToolExecutorHarness — confirmation flow", () => {
  it("approve: handler runs after request-response arrives", async () => {
    let handlerRan = 0;
    const { harness, inbox, bus } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => {
            handlerRan++;
            return [{ type: "text", text: "deleted" }];
          },
        },
      ],
    });

    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-1"));
    const { correlationId, replyTo } = await captureRequest(bus);
    await deliverResponse(inbox, replyTo, correlationId, {
      toolUseId: "tc-1",
      approved: true,
    });

    const result = await dispatchP;
    expect(result.succeeded).toBe(true);
    expect(handlerRan).toBe(1);
    expect((result.content[0] as { text: string }).text).toBe("deleted");
  });

  it("deny: succeeded=false with denial content; handler never runs", async () => {
    let handlerRan = 0;
    const { harness, inbox, bus } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => {
            handlerRan++;
            return [{ type: "text", text: "deleted" }];
          },
        },
      ],
    });

    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-2"));
    const { correlationId, replyTo } = await captureRequest(bus);
    await deliverResponse(inbox, replyTo, correlationId, {
      toolUseId: "tc-2",
      approved: false,
      reason: "user said no",
    });

    const result = await dispatchP;
    expect(result.succeeded).toBe(false);
    expect(handlerRan).toBe(0);
    expect((result.content[0] as { text: string }).text).toContain("denied");
    expect((result.content[0] as { text: string }).text).toContain(
      "user said no",
    );
  });

  it("modifiedArguments: handler receives the edited input", async () => {
    let receivedInput: unknown = null;
    const { harness, inbox, bus } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async (input) => {
            receivedInput = input;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const dispatchP = harness.dispatch(
      dispatchOf("delete-file", "tc-3", { path: "/tmp/risky" }),
    );
    const { correlationId, replyTo } = await captureRequest(bus);
    await deliverResponse(inbox, replyTo, correlationId, {
      toolUseId: "tc-3",
      approved: true,
      modifiedArguments: { path: "/tmp/safe" },
    });

    await dispatchP;
    expect(receivedInput).toEqual({ path: "/tmp/safe" });
  });

  it("always: subsequent dispatches of the same tool skip the gate", async () => {
    let handlerRan = 0;
    const { harness, inbox, bus } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => {
            handlerRan++;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const first = harness.dispatch(dispatchOf("delete-file", "tc-4"));
    const { correlationId, replyTo } = await captureRequest(bus);
    await deliverResponse(inbox, replyTo, correlationId, {
      toolUseId: "tc-4",
      approved: true,
      always: true,
    });
    await first;
    expect(handlerRan).toBe(1);

    // No inbox response delivered for the second call — should NOT pause.
    const second = await harness.dispatch(dispatchOf("delete-file", "tc-5"));
    expect(second.succeeded).toBe(true);
    expect(handlerRan).toBe(2);
  });

  it("abort during wait: dispatch resolves as denial-shaped result", async () => {
    const { harness } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => [{ type: "text", text: "never" }],
        },
      ],
    });

    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-6"));
    setTimeout(() => {
      void harness.abort({ toolCallId: "tc-6", reason: "session closed" });
    }, 10);

    const result = await dispatchP;
    expect(result.succeeded).toBe(false);
    // The denial message carries the abort _tag (extracted by
    // stringifyAbortReason since reason came in as a tagged object).
    expect((result.content[0] as { text: string }).text).toContain(
      "ToolAbortedError",
    );
  });

  it("timeout: per-dispatch confirmationTimeoutMs trips ToolConfirmationTimeoutError", async () => {
    const { harness } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => [{ type: "text", text: "never" }],
        },
      ],
    });

    await expect(
      harness.dispatch(
        dispatchOf("delete-file", "tc-7", {}, { confirmationTimeoutMs: 50 }),
      ),
    ).rejects.toMatchObject({
      _tag: "ToolConfirmationTimeoutError",
      toolName: "delete-file",
    });
  });
});

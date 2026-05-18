/**
 * Confirmation flow tests (4a.5 + 4a.7).
 *
 * Tools declared `annotations.requiresConfirmation: true` pause after
 * validation and wait for an inbound `confirmation-response` inbox
 * message. Approve → handler runs. Deny → DispatchResult with
 * `succeeded: false` and a denial-message content block. Abort or
 * timeout → typed failures.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

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

function deliverResponse(
  inbox: { send: (addr: string, msg: MessageEnvelope) => Effect.Effect<unknown, unknown, never> },
  address: string,
  response: ToolConfirmationResponse,
) {
  const msg: MessageEnvelope = {
    addressedTo: address,
    type: "confirmation-response",
    messageId: `m_${response.toolUseId}`,
    timestamp: Date.now(),
    payload: { type: "confirmation-response", response },
  };
  return Effect.runPromise(inbox.send(address, msg));
}

describe("ToolExecutorHarness — confirmation flow", () => {
  // `address` is protected on BaseHarness; tests reconstruct it.
  const addrFor = (scopeId: string) => `tool:${scopeId}`;

  it("approve: handler runs after confirmation response arrives", async () => {
    let handlerRan = 0;
    const scopeId = "scope-approve";
    const { harness, inbox } = await createTestHarness({
      scopeId,
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
    // Give the dispatch a tick to register its pending confirmation.
    await new Promise((r) => setImmediate(r));

    await deliverResponse(inbox, addrFor(scopeId), {
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
    const scopeId = "scope-deny";
    const { harness, inbox } = await createTestHarness({
      scopeId,
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
    await new Promise((r) => setImmediate(r));

    await deliverResponse(inbox, addrFor(scopeId), {
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
    const scopeId = "scope-modify";
    const { harness, inbox } = await createTestHarness({
      scopeId,
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
    await new Promise((r) => setImmediate(r));

    await deliverResponse(inbox, addrFor(scopeId), {
      toolUseId: "tc-3",
      approved: true,
      modifiedArguments: { path: "/tmp/safe" },
    });

    await dispatchP;
    expect(receivedInput).toEqual({ path: "/tmp/safe" });
  });

  it("always: subsequent dispatches of the same tool skip the gate", async () => {
    let handlerRan = 0;
    const scopeId = "scope-always";
    const { harness, inbox } = await createTestHarness({
      scopeId,
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
    await new Promise((r) => setImmediate(r));
    await deliverResponse(inbox, addrFor(scopeId), {
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
    // Cancel after a tick — abort during the confirmation wait.
    setTimeout(() => {
      void harness.abort({ toolCallId: "tc-6", reason: "session closed" });
    }, 10);

    const result = await dispatchP;
    expect(result.succeeded).toBe(false);
    expect((result.content[0] as { text: string }).text).toContain("aborted");
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

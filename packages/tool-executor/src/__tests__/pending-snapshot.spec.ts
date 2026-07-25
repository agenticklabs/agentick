/**
 * ToolExecutorHarness — pending client-call enumeration (§6.1, the live-only
 * defect fix).
 *
 * The `session:channel:tool_call` request channel becomes SNAPSHOT-FIRST: the
 * harness implements {@link ChannelSnapshotProvider}, so a client subscribing
 * MID-CALL receives the outstanding client-handled call in frame one instead of
 * nothing. These prove the harness half:
 *
 *   - `snapshotChannel` names the channel; the harness is a provider.
 *   - a suspended `requiresResponse` client call appears in the snapshot frame,
 *     mirroring the live relay delta (correlationId / replyTo / payload).
 *   - a fire-and-forget notify (no correlation) leaves nothing pending.
 *   - answering the call drops it from the snapshot.
 */

import { describe, expect, it } from "vitest";
import { waitFor } from "@agentick/utils/testing";
import {
  isChannelSnapshotProvider,
  jsonSchema,
  type DispatchInput,
  type ToolAnnotations,
  type ToolRegistration,
} from "@agentick/spec";

import { TOOL_CALL_CHANNEL } from "../tool-call-schema.js";
import { createTestHarness } from "../testing/index.js";

/** A CLIENT-HANDLED tool — no `handlerRef`. */
function clientTool(name: string, annotations: ToolAnnotations = {}): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "client-handled",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations,
    },
    binding: { scope: "runtime" },
  };
}

function dispatchOf(name: string, toolCallId: string, input: unknown = {}): DispatchInput {
  return { toolCallId, name, input, context: { via: "model" } };
}

describe("ToolExecutorHarness — pending client-call snapshot (§6.1)", () => {
  it("is a ChannelSnapshotProvider for the tool_call channel", async () => {
    const { harness } = await createTestHarness({ tools: [] });
    expect(isChannelSnapshotProvider(harness)).toBe(true);
    expect(harness.snapshotChannel).toBe(TOOL_CALL_CHANNEL);
    expect(harness.channelSnapshotPayload()).toEqual({ kind: "snapshot", requests: [] });
    await harness.close();
  });

  it("MID-CALL: a suspended requiresResponse call appears in the snapshot frame", async () => {
    const { harness } = await createTestHarness({
      tools: [clientTool("open_file", { requiresResponse: true })],
    });

    // Dispatch but do NOT await — the client-handled call suspends on
    // `this.request(TOOL_CALL_CHANNEL, …)`, so it stays pending.
    void harness.dispatch(dispatchOf("open_file", "tc-1", { path: "/etc/hosts" }));
    await waitFor(() => harness.channelSnapshotPayload().requests.length === 1);

    const frame = harness.channelSnapshotPayload();
    expect(frame.kind).toBe("snapshot");
    const [req] = frame.requests;
    // Mirrors the live relay delta a subscriber reads: correlationId + replyTo
    // off the envelope metadata, the ToolCallRequestPayload as the body.
    expect(typeof req!.correlationId).toBe("string");
    expect(req!.replyTo).toBe(harness.address);
    expect(req!.payload).toMatchObject({
      toolCallId: "tc-1",
      name: "open_file",
      input: { path: "/etc/hosts" },
    });

    await harness.close();
  });

  it("fire-and-forget (no requiresResponse) leaves NOTHING pending", async () => {
    const { harness } = await createTestHarness({
      tools: [clientTool("notify_client", { defaultResult: [{ type: "text", text: "ok" }] })],
    });

    // Fire-and-forget resolves immediately (one-way notify, no Deferred) — there
    // is no pending request to enumerate.
    await harness.dispatch(dispatchOf("notify_client", "tc-2"));
    expect(harness.channelSnapshotPayload().requests).toHaveLength(0);
    await harness.close();
  });

  it("drops an answered call from the snapshot (the pending set shrinks)", async () => {
    const { harness, inbox } = await createTestHarness({
      tools: [clientTool("open_file", { requiresResponse: true })],
    });

    const pending = harness.dispatch(dispatchOf("open_file", "tc-3"));
    await waitFor(() => harness.channelSnapshotPayload().requests.length === 1);
    const correlationId = harness.channelSnapshotPayload().requests[0]!.correlationId;

    // Relay the client's result back through the inbox (the respond path the
    // wire's `session/respond_to_tool_call` uses).
    await harness.respondToToolCall({ correlationId, result: [{ type: "text", text: "done" }] });
    await pending;
    void inbox;

    await waitFor(() => harness.channelSnapshotPayload().requests.length === 0);
    expect(harness.channelSnapshotPayload()).toEqual({ kind: "snapshot", requests: [] });
    await harness.close();
  });
});

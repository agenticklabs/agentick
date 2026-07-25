/**
 * `clientToolCallsHandle` — the B2 `ClientHandle` conformance suite (core +
 * Enumerable + Respondable + the listed-item round-trip + the `set` write verb).
 * Client tool calls are a REQUEST-SHAPED Enumerable, twin of elicitations:
 * `list()` yields ITEM handles (data + `.respond(result)`), seeded snapshot-first
 * so a client connecting mid-call sees the pending call.
 *
 * @see docs/proposals/v2/client-handles.md §4
 */

import { runClientHandleConformance, spyClientTransport } from "@agentick/client-core/testing";
import type { ToolResultInput } from "@agentick/spec";

import {
  clientToolCallsHandle,
  type ClientToolCallHandle,
  type ClientToolCallsHandle,
} from "../client/client-tool-calls.js";
import { TOOL_CALL_CHANNEL, type PendingToolCall } from "../tool-call-schema.js";

const pendingCall = (correlationId: string): PendingToolCall => ({
  correlationId,
  replyTo: `reply:${correlationId}`,
  payload: { toolCallId: `tc_${correlationId}`, name: "do_thing", input: { x: 1 } },
});

const snapshot = (...requests: PendingToolCall[]) => ({ kind: "snapshot", requests }) as const;

/** Spy of the replies routed to the server, projected to `{ id }`. */
function repliesOf(spy: ReturnType<typeof spyClientTransport>) {
  return () =>
    spy
      .requests()
      .filter((r) => r.method === "session/respond_to_tool_call")
      .map((r) => ({ id: (r.params as { correlationId: string }).correlationId }));
}

const sampleResult: ToolResultInput = [{ type: "text", text: "ok" }];

runClientHandleConformance<ClientToolCallsHandle, ClientToolCallHandle, string, ToolResultInput>({
  label: "clientToolCallsHandle",
  setup() {
    const spy = spyClientTransport();
    const handle = clientToolCallsHandle(spy, "sess_1");
    let n = 0;
    const calls: PendingToolCall[] = [];
    return {
      handle,
      // Each change re-seeds a CUMULATIVE snapshot with one more pending call.
      change: () => {
        calls.push(pendingCall(`corr_${++n}`));
        spy.emit(TOOL_CALL_CHANNEL, snapshot(...calls));
      },
      teardown: () => spy.endStream(),
    };
  },
  respondable: {
    withPendingRequest: async () => {
      const spy = spyClientTransport();
      const handle = clientToolCallsHandle(spy, "sess_1");
      spy.emit(TOOL_CALL_CHANNEL, snapshot(pendingCall("corr_1")));
      return { handle, id: "corr_1", responded: repliesOf(spy), teardown: () => spy.endStream() };
    },
    sampleInput: sampleResult,
    unknownId: "corr_never",
    listedItemRoundTrip: {
      connect: async () => {
        const spy = spyClientTransport();
        const handle = clientToolCallsHandle(spy, "sess_1");
        spy.emit(TOOL_CALL_CHANNEL, snapshot(pendingCall("corr_1")));
        return { handle, id: "corr_1", responded: repliesOf(spy), teardown: () => spy.endStream() };
      },
      invoke: (item) => (item as ClientToolCallHandle).respond(sampleResult),
    },
  },
  enumerable: {
    connectAfterSeed: async () => {
      const spy = spyClientTransport();
      const handle = clientToolCallsHandle(spy, "sess_1");
      spy.emit(TOOL_CALL_CHANNEL, snapshot(pendingCall("corr_1")));
      return { handle, id: "corr_1", teardown: () => spy.endStream() };
    },
    absentId: "corr_never",
  },
  writeVerbs: [
    {
      verb: "set",
      method: "session/set_client_tools",
      run: async () => {
        const spy = spyClientTransport();
        const handle = clientToolCallsHandle(spy, "sess_1");
        await handle.set([]);
        const r = spy.lastRequest()!;
        return { method: r.method, params: r.params };
      },
      boundAddress: { sessionId: "sess_1" },
    },
  ],
});

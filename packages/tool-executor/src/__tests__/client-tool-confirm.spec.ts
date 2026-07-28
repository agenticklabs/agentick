/**
 * Client-side tool-confirmation POLICY (stage 3).
 *
 * A stub `ClientProtocol` pushes `session:channel:elicitation` frames (the
 * shape the executor's confirmation gate publishes — `hints.kind ===
 * "tool_confirmation"`, `metadata.{toolName,toolUseId,arguments,preview}`) and
 * records outbound `client.request(...)` calls. Verifies:
 *
 *   1. `"approve"` → `session/respond_to_elicitation` accept `{ approved: true }`.
 *   2. `"deny"` → decline.
 *   3. A predicate on the arguments decides.
 *   4. A NON-confirmation elicitation is left UNTOUCHED (never answered).
 */

import { describe, expect, it } from "vitest";
import type {
  ClientElicitationHandle,
  Cursor,
  EventFrame,
  ProtocolEvent,
  SubscriptionStream,
  WireMethod,
  WireParams,
} from "@agentick/spec";
import type { ElicitationClient } from "@agentick/elicitation/client";
import { ELICITATION_CHANNEL_FQN } from "@agentick/elicitation";
import { waitFor } from "@agentick/utils/testing";

import { TOOL_CONFIRMATION_KIND } from "../confirmation-schema.js";
import { confirmClientTools, toolConfirmation } from "../client/confirm.js";

interface PushStream extends SubscriptionStream {
  emit(payload: unknown, correlationId: string): void;
}

function pushStream(): PushStream {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let closed = false;
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(payload: unknown, correlationId: string): void {
      const f: EventFrame = {
        cursor: { value: ++n } as unknown as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: ELICITATION_CHANNEL_FQN,
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload,
          metadata: { requestType: "request", correlationId, replyTo: "inbox:x" },
        } as unknown as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

interface RequestRecord {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function stubClient(stream: SubscriptionStream): {
  client: ElicitationClient;
  seen: RequestRecord[];
} {
  const seen: RequestRecord[] = [];
  const client: ElicitationClient = {
    transport: {
      subscribe(): SubscriptionStream {
        return stream;
      },
      request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        seen.push({ method, params: params as Record<string, unknown> });
        return Promise.resolve(null);
      },
    } as ElicitationClient["transport"],
  };
  return { client, seen };
}

/** A tool-confirmation elicitation payload the gate publishes. */
function confirmationPayload(args: unknown, preview?: unknown): unknown {
  return {
    mode: "form",
    message: 'Approve tool "write_file"?',
    hints: { kind: "tool_confirmation" },
    metadata: {
      toolUseId: "tc-9",
      toolName: "write_file",
      arguments: args,
      ...(preview !== undefined ? { preview } : {}),
    },
  };
}

describe("confirmClientTools — literal policies", () => {
  it('"approve" accepts with { approved: true }', async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const unsub = confirmClientTools(client, "s1", "approve");

    stream.emit(confirmationPayload({ path: "/tmp/x" }), "corr:a");
    await waitFor(() => seen.length === 1);

    expect(seen[0]!.method).toBe("session/respond_to_elicitation");
    expect(seen[0]!.params).toEqual({
      sessionId: "s1",
      correlationId: "corr:a",
      outcome: "accepted",
      value: { approved: true },
    });
    unsub();
  });

  it('"deny" declines', async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const unsub = confirmClientTools(client, "s1", "deny");

    stream.emit(confirmationPayload({ path: "/etc/passwd" }), "corr:d");
    await waitFor(() => seen.length === 1);

    expect(seen[0]!.params.outcome).toBe("declined");
    expect(seen[0]!.params.correlationId).toBe("corr:d");
    unsub();
  });
});

describe("confirmClientTools — predicate policy", () => {
  it("decides per the confirmation request (toolName + arguments + preview)", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const seenReq: unknown[] = [];
    const unsub = confirmClientTools(client, "s1", (req) => {
      seenReq.push(req);
      return (req.arguments as { safe?: boolean }).safe === true;
    });

    stream.emit(confirmationPayload({ safe: true }, { diff: "+1" }), "corr:ok");
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.params.outcome).toBe("accepted");

    stream.emit(confirmationPayload({ safe: false }), "corr:no");
    await waitFor(() => seen.length === 2);
    expect(seen[1]!.params.outcome).toBe("declined");

    expect(seenReq[0]).toEqual({
      toolName: "write_file",
      toolUseId: "tc-9",
      arguments: { safe: true },
      message: 'Approve tool "write_file"?',
      preview: { diff: "+1" },
    });
    unsub();
  });
});

describe("toolConfirmation — the narrowing reader", () => {
  /**
   * A REAL `ClientElicitationHandle` — the value `session.elicitations.list()`
   * yields. Passing it to `toolConfirmation` with no cast is the assignability
   * claim (enforced by `tsc`, not by an assertion).
   */
  function listedElicitation(fields: {
    readonly message: string;
    readonly hints?: Readonly<Record<string, unknown>>;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): ClientElicitationHandle {
    return {
      correlationId: "corr:1",
      replyTo: "inbox:x",
      mode: "form",
      receivedAt: 0,
      ...fields,
      accept: async () => undefined,
      decline: async () => undefined,
      cancel: async () => undefined,
    };
  }

  it("returns undefined when the elicitation is not a tool confirmation", () => {
    expect(
      toolConfirmation(
        listedElicitation({ message: "What is your name?", hints: { kind: "mcp_elicitation" } }),
      ),
    ).toBeUndefined();
    expect(toolConfirmation(listedElicitation({ message: "no hints at all" }))).toBeUndefined();
  });

  it("maps a confirmation to the full ConfirmRequest — preview INCLUDED", () => {
    const req = toolConfirmation(
      listedElicitation({
        message: 'Approve tool "write_file"?',
        hints: { kind: TOOL_CONFIRMATION_KIND },
        metadata: {
          toolUseId: "tc-9",
          toolName: "write_file",
          arguments: { path: "/tmp/x" },
          preview: { diff: "+1 line" },
        },
      }),
    );

    expect(req).toEqual({
      toolName: "write_file",
      toolUseId: "tc-9",
      arguments: { path: "/tmp/x" },
      message: 'Approve tool "write_file"?',
      preview: { diff: "+1 line" },
    });
  });

  it("omits absent fields rather than materializing them as undefined", () => {
    const req = toolConfirmation(
      listedElicitation({
        message: "Approve?",
        hints: { kind: TOOL_CONFIRMATION_KIND },
        metadata: { toolName: "echo" },
      }),
    );

    expect(req).toEqual({ toolName: "echo", message: "Approve?" });
    expect(Object.keys(req!)).toEqual(["toolName", "message"]);
  });
});

describe("confirmClientTools — coordination", () => {
  it("leaves a NON-confirmation elicitation untouched", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const unsub = confirmClientTools(client, "s1", "approve");

    // A plain elicitation (no tool_confirmation hint) — the policy must ignore it.
    stream.emit(
      { mode: "form", message: "What is your name?", hints: { kind: "mcp_elicitation" } },
      "corr:other",
    );
    // A confirmation right after — proves the stream is live and the first was skipped.
    stream.emit(confirmationPayload({ ok: 1 }), "corr:conf");
    await waitFor(() => seen.length === 1);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.params.correlationId).toBe("corr:conf");
    unsub();
  });
});

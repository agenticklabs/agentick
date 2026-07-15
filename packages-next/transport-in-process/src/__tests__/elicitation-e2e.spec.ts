/**
 * Full-stack elicitation round-trip — closes the loop.
 *
 * Exercises the entire client ↔ server elicitation arc through the
 * real `GatewayHarness` adapter (no stub `JSON-RPC` handler):
 *
 *   1. Server triggers `session.elicitation.elicit(...)`. The harness
 *      publishes a request envelope on `session:channel:elicitation`.
 *   2. Client subscription via `session.elicitations()` parses the
 *      envelope into a `ClientElicitationHandle` and yields it.
 *   3. Client calls `elic.accept({...})`. The handle's typed
 *      convenience routes through `session/respond_to_elicitation` —
 *      the new wire method — which `dispatchRequest` routes to
 *      `sess.elicitation.respond({...})` on the gateway side.
 *   4. The server-side `elicit()` Promise resolves with the typed
 *      `ElicitationResult` — proving the entire round-trip is wired.
 *
 * Side-effect import of `@agentick/elicitation-next` registers the
 * `SessionHarnessProtocol.elicitation` slot augmentation that
 * `dispatchRequest`'s typed cast relies on at runtime.
 */

import "@agentick/elicitation-next";

import { describe, expect, it } from "vitest";

// ADR 87 — contributes `session.elicitations()` / `.respondToElicitation()`.
import "@agentick/elicitation-next/client";
import { createClient } from "@agentick/client-core-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { createGateway } from "@agentick/gateway-next";
import { fakeReconciler } from "@agentick/reconciler-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  jsonSchema,
  type ContentBlock,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@agentick/spec-next";
import { dispatchRequest, type DispatchSink } from "@agentick/transport-next";

import { inProcessTransport } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPROVAL_SCHEMA = jsonSchema<{ readonly approved: boolean }>(
  {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
  },
  {
    validator: (raw) => {
      if (
        raw !== null &&
        typeof raw === "object" &&
        typeof (raw as { approved?: unknown }).approved === "boolean"
      ) {
        return { value: { approved: (raw as { approved: boolean }).approved } };
      }
      return { issues: [{ message: "missing required boolean `approved`" }] };
    },
  },
);

async function makeStack(replyText = "ok") {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-elic-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: replyText } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "elic-app",
    rootElement: null,
    options: { executor, reconciler: fakeReconciler() },
  });
  // AppHarness.createSession returns a real SessionHarnessProtocol<P>
  // — its `elicitation` slot is added by the elicitation-next module
  // augmentation (loaded above).
  const session = await app.createSession({ sessionId: "elic-session" });

  // Per-handler-invocation sink: each RPC gets a fresh sink whose
  // sendNotification is the callback the transport passed for THAT
  // invocation. Subscribe holds a closure reference to its own
  // sendNotification — notifications fired later (after the handler
  // returns) still route correctly because each invocation's callback
  // is the one wired to that frame's response path on the transport
  // side. A single shared forwarder would get overwritten by the next
  // RPC and silently drop subscription events.
  const handler = async (
    req: JsonRpcRequest,
    sendNotification: (n: { method: string; params?: unknown }) => void,
  ): Promise<JsonRpcResponse> => {
    const sink: DispatchSink = {
      sendNotification,
      registerSubscription: () => {},
      unregisterSubscription: () => {},
      registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
      unregisterInFlight: () => {},
    };
    return dispatchRequest(gateway, req, sink);
  };

  const client = await createClient({ transport: inProcessTransport({ handler }) });
  await client.connect();

  return {
    client,
    gateway,
    app,
    session,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

/**
 * `LocalEventBus.subscribe()` returns a Stream whose subscription is
 * established when the consumer's fiber starts running. The
 * gateway-side `busAsyncIterator` uses `Effect.runFork(...)`, which
 * schedules the consumer fiber asynchronously — so an event published
 * before that fiber registers with the bus is missed. In production
 * the client subscribes long before any elicitation fires; in tests
 * we need a small barrier to let the subscribe-fiber land.
 */
const SUBSCRIBE_BARRIER_MS = 20;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SUBSCRIBE_BARRIER_MS));

describe("elicitation end-to-end — client ↔ gateway ↔ session", () => {
  it("accept: server elicit() resolves with the value the client sent", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    // Start the client subscription FIRST so the bus subscriber is
    // live before the server publishes the request envelope.
    const stream = client.session(sessionId).elicitations();
    const iterator = stream[Symbol.asyncIterator]();
    const firstP = iterator.next();
    await settle();

    // Kick off the server-side elicit. The harness publishes the
    // envelope and awaits a response on its inbox.
    const elicitP = session.elicitation.elicit(
      {
        message: "Approve calling delete_file?",
        schema: APPROVAL_SCHEMA,
        hints: { kind: "tool_confirmation" },
        metadata: { toolName: "delete_file" },
      },
      { timeoutMs: 5_000 },
    );

    const next = await firstP;
    expect(next.done).toBeFalsy();
    const elic = next.value!;
    expect(elic.message).toBe("Approve calling delete_file?");
    expect(elic.hints?.kind).toBe("tool_confirmation");
    expect(elic.metadata).toEqual({ toolName: "delete_file" });
    expect(typeof elic.correlationId).toBe("string");
    expect(elic.mode).toBe("form");
    expect(elic.schema).toBeDefined();

    // Client accepts — routes through session/respond_to_elicitation,
    // which the gateway routes to sess.elicitation.respond(...).
    await elic.accept({ approved: true });

    const result = await elicitP;
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.value).toEqual({ approved: true });
    }

    await stream.close();
    await cleanup();
  });

  it("decline: server elicit() resolves with { outcome: 'declined', reason }", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    const stream = client.session(sessionId).elicitations();
    const iterator = stream[Symbol.asyncIterator]();
    const firstP = iterator.next();
    await settle();

    const elicP = session.elicitation.elicit(
      {
        message: "Approve risky op?",
        schema: APPROVAL_SCHEMA,
        hints: { kind: "tool_confirmation" },
      },
      { timeoutMs: 5_000 },
    );

    const next = await firstP;
    const elic = next.value!;
    await elic.decline("user clicked Deny");

    const result = await elicP;
    expect(result.outcome).toBe("declined");
    if (result.outcome === "declined") {
      expect(result.reason).toBe("user clicked Deny");
    }

    await stream.close();
    await cleanup();
  });

  it("cancel: server elicit() resolves with { outcome: 'cancelled', reason }", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    const stream = client.session(sessionId).elicitations();
    const iterator = stream[Symbol.asyncIterator]();
    const firstP = iterator.next();
    await settle();

    const elicP = session.elicitation.elicit(
      { message: "Open form?", schema: APPROVAL_SCHEMA },
      { timeoutMs: 5_000 },
    );

    const next = await firstP;
    const elic = next.value!;
    await elic.cancel("modal dismissed");

    const result = await elicP;
    expect(result.outcome).toBe("cancelled");
    if (result.outcome === "cancelled") {
      expect(result.reason).toBe("modal dismissed");
    }

    await stream.close();
    await cleanup();
  });

  it("schema violation: invalid accepted value surfaces as failed/schema_violation", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    const stream = client.session(sessionId).elicitations();
    const iterator = stream[Symbol.asyncIterator]();
    const firstP = iterator.next();
    await settle();

    const elicP = session.elicitation.elicit(
      { message: "Approve?", schema: APPROVAL_SCHEMA },
      { timeoutMs: 5_000 },
    );

    const next = await firstP;
    const elic = next.value!;
    // Client sends a malformed accept — `approved` is missing.
    await client.session(sessionId).respondToElicitation({
      correlationId: elic.correlationId,
      outcome: "accepted",
      value: { unrelated: true },
    });

    const result = await elicP;
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.failure.kind).toBe("schema_violation");
      expect(result.failure.issues).toBeDefined();
      expect(result.failure.issues!.length).toBeGreaterThan(0);
    }

    await stream.close();
    await cleanup();
  });

  it("unknown correlationId: respondToElicitation is a silent no-op", async () => {
    const { client, sessionId, cleanup } = await makeStack();
    await expect(
      client.session(sessionId).respondToElicitation({
        correlationId: "req:does-not-exist",
        outcome: "declined",
      }),
    ).resolves.toBeUndefined();
    await cleanup();
  });

  it("concurrent elicitations: client receives both, responses route by correlationId", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    const stream = client.session(sessionId).elicitations();
    const iterator = stream[Symbol.asyncIterator]();

    const firstP = iterator.next();
    await settle();
    const elic1P = session.elicitation.elicit(
      { message: "First prompt", schema: APPROVAL_SCHEMA },
      { timeoutMs: 5_000 },
    );

    const elic1Frame = await firstP;
    const elic1 = elic1Frame.value!;

    const secondP = iterator.next();
    const elic2P = session.elicitation.elicit(
      { message: "Second prompt", schema: APPROVAL_SCHEMA },
      { timeoutMs: 5_000 },
    );

    const elic2Frame = await secondP;
    const elic2 = elic2Frame.value!;

    expect(elic1.correlationId).not.toBe(elic2.correlationId);
    expect(elic1.message).toBe("First prompt");
    expect(elic2.message).toBe("Second prompt");

    // Respond OUT OF ORDER — second elicit answered first.
    await elic2.accept({ approved: false });
    await elic1.accept({ approved: true });

    const [r1, r2] = await Promise.all([elic1P, elic2P]);
    expect(r1.outcome).toBe("accepted");
    expect(r2.outcome).toBe("accepted");
    if (r1.outcome === "accepted") expect(r1.value).toEqual({ approved: true });
    if (r2.outcome === "accepted") expect(r2.value).toEqual({ approved: false });

    await stream.close();
    await cleanup();
  });
});

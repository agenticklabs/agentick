/**
 * Full-stack `session/abort` — client → in-process transport → gateway →
 * session → loop → the in-flight model call, and the cancellation reason all
 * the way down.
 *
 * The verb used to be a stub: it resolved the session, discarded
 * `params.reason`, and returned success while the execution kept running
 * (#251). Cross-wire cancellation worked ONLY through
 * `notifications/cancelled` against a specific in-flight `session/send` — so a
 * caller holding just a session id (a second connection, a supervisor, a UI
 * that reconnected after the send's connection dropped) had no way to stop
 * anything, and got a success telling it that it had.
 *
 * The executor here parks its model call on the execution's merged abort
 * signal and reports `canceled` when it fires — what a provider adapter that
 * honors the signal does — so the abort is observed at the deepest point the
 * reason travels to, not at the tick boundary above it. The send passes
 * `stream: false` to pin the non-streaming executor edge (`fx.run`); the
 * session would otherwise default to streaming, because the fake exposes
 * `executeStream`.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  ExecutorFx,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  LanguageModelExecutionResult,
  LanguageModelInput,
} from "@agentick/spec";
import { dispatchRequest, type DispatchSink } from "@agentick/transport";

import { inProcessTransport } from "../index.js";

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("abort-exec", journal, bus, inbox);
  await executor.ready;

  // The model call parks until the execution's merged signal fires, then
  // reports the cancellation the way a signal-honoring provider does. Both
  // halves of the round trip are captured here: that the call was REACHED
  // (`entered`) and what reason arrived on the signal.
  let announceEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    announceEntered = resolve;
  });
  let observedReason: unknown;

  const baseFx = executor.fx;
  const parkedFx: ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> = {
    ...baseFx,
    run: (input) =>
      Effect.promise(async () => {
        const signal = input.signal;
        announceEntered?.();
        if (signal !== undefined && !signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        observedReason = signal?.reason;
        return { outcome: "canceled", reason: signal?.reason } as const;
      }),
  };
  Object.defineProperty(executor, "fx", { configurable: true, get: () => parkedFx });

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "abort-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  const session = await app.createSession({ sessionId: "abort-session" });

  const sink: DispatchSink = {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
    unregisterInFlight: () => {},
  };
  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> =>
    dispatchRequest(gateway, req, sink);

  const client = await createClient({ transport: inProcessTransport({ handler }) });
  await client.connect();

  return {
    client,
    sessionId: session.id,
    entered,
    observedReason: () => observedReason,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("session/abort — full client → gateway → loop roundtrip", () => {
  it("terminates the in-flight execution and delivers the reason to the model call", async () => {
    const { client, sessionId, entered, observedReason, cleanup } = await makeStack();

    const handle = client
      .session(sessionId)
      .send({ messages: [{ role: "user", content: "go" }], stream: false });
    await entered;

    // The standalone verb — a session id and a reason, no in-flight RPC to
    // correlate against.
    await client.session(sessionId).abort("user pressed stop");

    const result = await handle.result;
    expect(result.stopReason).toBe("aborted");
    // The reason crossed the wire, the gateway, the session, and the loop's
    // per-execution controller to reach the call that was actually running.
    expect(observedReason()).toBe("user pressed stop");

    await cleanup();
  });

  it("aborting an idle session is a quiet no-op", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    // Nothing is running: there is no execution to cancel and no error to
    // raise. A caller racing a naturally-finished turn lands here.
    await expect(client.session(sessionId).abort("nothing to stop")).resolves.toBeUndefined();

    await cleanup();
  });
});

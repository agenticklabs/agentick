/**
 * A typed domain failure survives the whole wire, tag intact.
 *
 * The regression this pins, captured from production: a `prompts/invoke`
 * missing a required argument came back as
 *
 *   {"error":{"code":-32603,"message":"internal error",
 *     "data":{"reason":"inbox message handler failed: PromptArgumentMissing: …"}}}
 *
 * — an internal-error code for a caller mistake, a message that says nothing,
 * and the one actionable sentence demoted to free text inside `data.reason`.
 * Two erasures stacked up on the way out:
 *
 *   1. `BaseHarness` wraps every inbox command failure in `HandlerError` (its
 *      channel is typed to `MessageHandlerError`), so the typed error survives
 *      only as `.cause`.
 *   2. The dynamic command lane ran the ask with `Effect.runPromise`, which
 *      rejects with a `FiberFailure` — a plain `Error` whose message is the
 *      pretty-printed cause. By the dispatcher's catch, `isAgentickError` was
 *      false and there was nothing left to map.
 *
 * The fixes are general, not prompt-shaped: the lane rejects with the failure
 * VALUE (`runPromiseExit` + `Cause.squash`), and the dispatcher reports the
 * typed error dug out of the `cause` chain, preferring one the code table has a
 * specific answer for so a verdict-bearing wrapper is still honored.
 *
 * @see packages/gateway/src/dynamic-commands.ts (`runAsk`)
 * @see packages/transport/src/server/dispatch.ts (`domainErrorOf`)
 * @see packages/transport/src/__tests__/rpc-error-fidelity.spec.ts — the client
 *   half: the same payload reaching a console readably
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { hydrateFrom, withPrompts } from "@agentick/prompts";
import {
  ErrorCode,
  PromptArgumentMissing,
  type ContentBlock,
  type WireMethod,
} from "@agentick/spec";

import { inProcessTransport } from "../index.js";

/** A prompt with two required arguments — invoking it short is the fault. */
const COST_REPORT = {
  declaration: {
    name: "tm_change_order_actual_cost",
    description: "Actual cost for a change order.",
    arguments: [
      { name: "job", required: true },
      { name: "phase", required: true },
    ],
    render: (args: Readonly<Record<string, unknown>>): string =>
      `job ${String(args.job)} phase ${String(args.phase)}`,
  },
};

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("typed-error-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "typed-error-app",
    rootElement: null,
    options: {
      modelExecutor: executor,
      compiler: fakeCompiler(),
      extensions: [withPrompts({ hydrate: hydrateFrom([COST_REPORT]) })],
    },
  });
  const session = await app.createSession({ sessionId: "typed-error-session" });
  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  return {
    client,
    sessionId: session.id,
    cleanup: async (): Promise<void> => {
      await client.close();
      await gateway.close();
    },
  };
}

/** The raw wire envelope: `client.transport.request` skips rehydration. */
type WireFailure = {
  readonly kind: string;
  readonly message: string;
  readonly error: { readonly code: number; readonly message: string; readonly data: unknown };
};

describe("a typed domain error crosses the wire intact", () => {
  it("prompts/invoke missing a required argument answers InvalidParams, not internal error", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const caught = (await client.transport
      .request(
        "prompts/invoke" as WireMethod,
        {
          sessionId,
          name: "tm_change_order_actual_cost",
          args: { job: "Cabin renovation" },
        } as never,
      )
      .then(() => undefined)
      .catch((e: unknown) => e)) as WireFailure;

    // The code says whose fault it is: the caller's, not the server's.
    expect(caught.error.code).toBe(ErrorCode.InvalidParams);
    // The message is the domain error's own — no "internal error", no
    // "inbox message handler failed" wrapper.
    expect(caught.error.message).toBe("prompt tm_change_order_actual_cost missing argument: phase");
    expect(caught.error.message).not.toContain("inbox message handler failed");
    // …and it reaches a console readably (the client half of the fix).
    expect(caught.message).toContain("missing argument: phase");

    await cleanup();
  });

  it("the tag and its fields ride in error.data — the failure stays discriminable", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const caught = (await client.transport
      .request(
        "prompts/invoke" as WireMethod,
        {
          sessionId,
          name: "tm_change_order_actual_cost",
          args: { job: "Cabin renovation" },
        } as never,
      )
      .catch((e: unknown) => e)) as WireFailure;

    expect(caught.error.data).toMatchObject({
      _tag: "PromptArgumentMissing",
      promptName: "tm_change_order_actual_cost",
      argument: "phase",
    });

    await cleanup();
  });

  it("through client.request the failure rehydrates to the typed class", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    // The rehydrating door: `_tag` in `error.data` is what makes this work, and
    // the wrapper used to eat it — so `instanceof` held on the server side of
    // the wire and nowhere else.
    const caught = await client
      .request(
        "prompts/invoke" as WireMethod,
        {
          sessionId,
          name: "tm_change_order_actual_cost",
          args: { job: "Cabin renovation" },
        } as never,
      )
      .catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PromptArgumentMissing);
    expect((caught as PromptArgumentMissing).argument).toBe("phase");
    expect((caught as PromptArgumentMissing).promptName).toBe("tm_change_order_actual_cost");

    await cleanup();
  });

  it("an unknown prompt still maps to its own code — the table is not bypassed", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const caught = (await client.transport
      .request(
        "prompts/invoke" as WireMethod,
        {
          sessionId,
          name: "no_such_prompt",
        } as never,
      )
      .catch((e: unknown) => e)) as WireFailure;

    expect(caught.error.code).toBe(ErrorCode.MethodNotFound);
    expect(caught.error.message).toContain("no_such_prompt");
    expect((caught.error.data as { _tag?: string })._tag).toBe("PromptNotFound");

    await cleanup();
  });
});

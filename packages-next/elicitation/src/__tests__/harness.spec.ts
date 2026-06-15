/**
 * ElicitationHarness — impl-specific tests.
 *
 * Cross-impl invariants (round-trip, schema validation, async
 * validators, declined/cancelled, timeout, abort, idempotence,
 * concurrent elicitations, close() cancels pending) are exercised by
 * the exported conformance suite — see `conformance.spec.ts`. This
 * file covers ONLY things specific to this concrete impl:
 *
 *   - Wire envelope shape (channel name, payload structure, schema
 *     JSON-Schema projection, metadata routing fields)
 *   - `harness.id` / `harness.ready` invariants
 *   - `respond()` routing through the inbox (not bypassing it)
 *   - `fakeElicitation()` close cleanup
 */

import { afterEach, describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import type { ProtocolEvent, StandardSchemaV1 } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import type { LocalEventBus } from "@agentick/runtime-next";

import { ELICITATION_CHANNEL_FQN } from "../channel.js";
import { fakeElicitation, type FakeElicitationBundle } from "../testing/fake-elicitation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Resolves with the next elicitation request envelope. Call BEFORE
 * `elicit(...)` so the subscription is live by publish time.
 */
function nextRequestEnvelope(bus: LocalEventBus): Promise<EnvelopeWithMetadata> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: ELICITATION_CHANNEL_FQN },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        1,
      ),
    ),
  ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);
}

function lenientObject(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return jsonSchema<Record<string, unknown>>(
    { type: "object", additionalProperties: true },
    {
      validator: (raw) =>
        raw !== null && typeof raw === "object"
          ? { value: raw as Record<string, unknown> }
          : { issues: [{ message: "expected an object" }] },
    },
  );
}

// ---------------------------------------------------------------------------
// Wire envelope shape
// ---------------------------------------------------------------------------

describe("ElicitationHarness — wire envelope shape", () => {
  let bundle: FakeElicitationBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("publishes on session:channel:elicitation with correlationId + replyTo metadata", async () => {
    bundle = await fakeElicitation();
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit(
      { message: "ok?", schema: lenientObject() },
      { timeoutMs: 500 },
    );
    const env = await envP;
    expect(env.name).toBe(ELICITATION_CHANNEL_FQN);
    expect(env.surface).toBe("session");
    expect(env.phase).toBe("delta");
    expect(env.metadata?.requestType).toBe("request");
    expect(env.metadata?.correlationId).toMatch(/^req:/);
    expect(typeof env.metadata?.replyTo).toBe("string");
    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await pending;
  });

  it("payload carries message, hints, metadata, and a JSON Schema projection of `schema`", async () => {
    bundle = await fakeElicitation();
    const envP = nextRequestEnvelope(bundle.bus);
    const schema = jsonSchema<{ a: number }>(
      { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
      { validator: (raw) => ({ value: raw as { a: number } }) },
    );
    const pending = bundle.harness.elicit(
      {
        message: "Confirm the action",
        schema,
        hints: { confirmLabel: "Approve", kind: "tool_confirmation" },
        metadata: { toolName: "calc" },
      },
      { timeoutMs: 500 },
    );
    const env = await envP;
    const payload = env.payload as {
      message: string;
      schema: Record<string, unknown>;
      hints?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
    expect(payload.message).toBe("Confirm the action");
    expect(payload.hints).toEqual({ confirmLabel: "Approve", kind: "tool_confirmation" });
    expect(payload.metadata).toEqual({ toolName: "calc" });

    // schema MUST be a JSON Schema object on the wire, NOT the live
    // StandardSchemaV1 (which carries a function).
    expect(payload.schema).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
    expect(typeof (payload.schema as { "~standard"?: unknown })["~standard"]).toBe("undefined");

    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await pending;
  });
});

// ---------------------------------------------------------------------------
// Identity + lifecycle invariants
// ---------------------------------------------------------------------------

describe("ElicitationHarness — identity + lifecycle", () => {
  it("`id` matches the constructor scopeId", async () => {
    const b = await fakeElicitation({ harnessId: "specific-id-1" });
    try {
      expect(b.harness.id).toBe("specific-id-1");
    } finally {
      await b.close();
    }
  });

  it("`ready` resolves before respond() can deliver", async () => {
    const b = await fakeElicitation();
    try {
      // `fakeElicitation` already awaited `ready`; respond MUST be
      // dispatchable immediately. Unknown correlationIds are no-ops,
      // so this verifies the call doesn't error on a freshly-ready
      // harness.
      await expect(
        b.harness.respond({ correlationId: "req:never", outcome: "declined" }),
      ).resolves.toBeUndefined();
    } finally {
      await b.close();
    }
  });

  it("close() unsubscribes — respond() after close still succeeds (no-op)", async () => {
    const b = await fakeElicitation();
    await b.close();
    await expect(
      b.harness.respond({ correlationId: "req:post-close", outcome: "declined" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// URL mode — staged on the protocol but not implemented; calls MUST
// throw UnsupportedElicitationModeError, NOT return a result.
// ---------------------------------------------------------------------------

describe("ElicitationHarness — URL mode is staged but not implemented", () => {
  it("throws UnsupportedElicitationModeError when elicit() is called with mode: 'url'", async () => {
    const b = await fakeElicitation();
    try {
      const promise = b.harness.elicit({
        mode: "url",
        message: "Open your bank's OAuth page",
        url: "https://example.com/oauth",
        elicitationId: "el-1",
      });
      await expect(promise).rejects.toMatchObject({
        _tag: "UnsupportedElicitationModeError",
        mode: "url",
      });
    } finally {
      await b.close();
    }
  });
});

// ---------------------------------------------------------------------------
// respond() routing — verifies the in-process path goes through the inbox
// ---------------------------------------------------------------------------

describe("ElicitationHarness — respond() routes through inbox", () => {
  it("respond() delivers via inbox.send (so cross-process and in-process share one resolution path)", async () => {
    // Spy by wrapping bundle.inbox.send. If respond() bypassed the
    // inbox and called `requests.resolve()` directly, this spy would
    // never fire.
    const b = await fakeElicitation();
    try {
      let inboxSendCalls = 0;
      const originalSend = b.inbox.send.bind(b.inbox);
      b.inbox.send = ((address, msg) => {
        inboxSendCalls++;
        return originalSend(address, msg);
      }) as typeof b.inbox.send;

      const envP = nextRequestEnvelope(b.bus);
      const pending = b.harness.elicit(
        { message: "?", schema: lenientObject() },
        { timeoutMs: 500 },
      );
      const env = await envP;
      await b.harness.respond({
        correlationId: env.metadata!.correlationId as string,
        outcome: "declined",
      });
      await pending;
      expect(inboxSendCalls).toBeGreaterThan(0);
    } finally {
      await b.close();
    }
  });
});

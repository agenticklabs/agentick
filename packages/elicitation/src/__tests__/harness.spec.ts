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
import type { ProtocolEvent, StandardSchemaV1 } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import type { LocalEventBus } from "@agentick/runtime";

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
// URL mode — accept/decline/cancel round-trip. URL-accepted means the
// user consented to navigate to the URL; the harness resolves with
// `value: undefined` because there's no schema-validated reply value
// (consent is the terminal — out-of-band completion is layered on top
// via a separate notification path).
// ---------------------------------------------------------------------------

describe("ElicitationHarness — URL mode", () => {
  let bundle: FakeElicitationBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("publishes a URL-mode wire payload with url + elicitationId + message", async () => {
    bundle = await fakeElicitation();
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit(
      {
        mode: "url",
        message: "Open your bank's OAuth page",
        url: "https://example.com/oauth?state=abc",
        elicitationId: "el-oauth-1",
        hints: { kind: "oauth" },
        metadata: { server: "linear" },
      },
      { timeoutMs: 500 },
    );
    const env = await envP;
    const payload = env.payload as {
      mode: string;
      message: string;
      url: string;
      elicitationId: string;
      hints?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      schema?: unknown;
    };
    expect(payload.mode).toBe("url");
    expect(payload.message).toBe("Open your bank's OAuth page");
    expect(payload.url).toBe("https://example.com/oauth?state=abc");
    expect(payload.elicitationId).toBe("el-oauth-1");
    expect(payload.hints).toEqual({ kind: "oauth" });
    expect(payload.metadata).toEqual({ server: "linear" });
    // URL mode carries NO `schema` field — there's no reply value to
    // validate; the consent is the terminal.
    expect(payload.schema).toBeUndefined();

    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "cancelled",
    });
    await pending;
  });

  it("accepted → { outcome: 'accepted', value: undefined } (consent-only)", async () => {
    bundle = await fakeElicitation();
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit({
      mode: "url",
      message: "Open the page",
      url: "https://example.com/x",
      elicitationId: "el-2",
    });
    const env = await envP;
    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "accepted",
      // Any value the client sends is ignored — URL-mode accepted is
      // consent-only.
      value: { ignored: true },
    });
    const result = await pending;
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.value).toBeUndefined();
    }
  });

  it("declined → passes through verbatim with reason", async () => {
    bundle = await fakeElicitation();
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit({
      mode: "url",
      message: "Open the page",
      url: "https://example.com/x",
      elicitationId: "el-3",
    });
    const env = await envP;
    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
      reason: "user said no",
    });
    const result = await pending;
    expect(result).toEqual({ outcome: "declined", reason: "user said no" });
  });

  it("cancelled → passes through verbatim", async () => {
    bundle = await fakeElicitation();
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit({
      mode: "url",
      message: "Open the page",
      url: "https://example.com/x",
      elicitationId: "el-4",
    });
    const env = await envP;
    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "cancelled",
    });
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
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

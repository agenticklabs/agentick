/**
 * ElicitationHarness — command lifecycle hooks (ADR 80 / 83).
 *
 * The elicit round-trip routes through `BaseHarness.runOperation` (see
 * `elicitOp`), so the ONE `elicitation:elicit` op fires the derived command
 * hooks around the WHOLE request→await→response round-trip:
 *
 *   - `onBeforeElicitationElicit(request)` — before the request envelope is
 *     published: observe, transform the prompt, or throw to veto.
 *   - `onAfterElicitationElicit(result)`  — when the reply resolves locally:
 *     observe or transform the terminal `ElicitationResult`.
 *
 * These tests pin: (a) the name derivation agrees with `deriveHookNames`;
 * (b) before observes + transforms the OUTBOUND request (verified on the wire
 * envelope); (c) after transforms the terminal result; (d) a before `throw`
 * vetoes (no envelope published, elicit rejects).
 */

import { afterEach, describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import type { ProtocolEvent, StandardSchemaV1 } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import { deriveHookNames, Hooks, type LocalEventBus } from "@agentick/runtime-next";

import { ELICITATION_CHANNEL_FQN } from "../channel.js";
import { fakeElicitation, type FakeElicitationBundle } from "../testing/fake-elicitation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** Resolve with the next elicitation request envelope. Call BEFORE `elicit`. */
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
// Name derivation — the CommandRegistry key mints the expected hook names.
// ---------------------------------------------------------------------------

describe("ElicitationHarness — hook name derivation", () => {
  it("deriveHookNames('elicitation:command:elicit') === on{Before,After}ElicitationElicit", () => {
    expect(deriveHookNames("elicitation:command:elicit")).toEqual([
      "onBeforeElicitationElicit",
      "onAfterElicitationElicit",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip hookability
// ---------------------------------------------------------------------------

describe("ElicitationHarness — elicit is hookable (round-trip)", () => {
  let bundle: FakeElicitationBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("onBefore observes the outbound request before it is published", async () => {
    let seenMessage: string | undefined;
    bundle = await fakeElicitation({
      hooks: Hooks.from({
        onBeforeElicitationElicit: (req) => {
          seenMessage = req.message;
        },
      }),
    });
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit(
      { message: "original?", schema: lenientObject() },
      { timeoutMs: 500 },
    );
    const env = await envP;
    expect(seenMessage).toBe("original?");
    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await pending;
  });

  it("onBefore transforms the request — the reshaped prompt is what goes on the wire", async () => {
    bundle = await fakeElicitation({
      hooks: Hooks.from({
        onBeforeElicitationElicit: (req) => ({ ...req, message: "TRANSFORMED" }),
      }),
    });
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit(
      { message: "original?", schema: lenientObject() },
      { timeoutMs: 500 },
    );
    const env = await envP;
    // The BODY dispatched the hook-reshaped request, so the published wire
    // payload carries the transformed prompt — not the caller's original.
    expect((env.payload as { message: string }).message).toBe("TRANSFORMED");
    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await pending;
  });

  it("onAfter transforms the terminal ElicitationResult", async () => {
    bundle = await fakeElicitation({
      hooks: Hooks.from({
        onAfterElicitationElicit: () => ({ outcome: "declined", reason: "hooked" }),
      }),
    });
    const envP = nextRequestEnvelope(bundle.bus);
    const pending = bundle.harness.elicit(
      { message: "ok?", schema: lenientObject() },
      { timeoutMs: 500 },
    );
    const env = await envP;
    // Client accepts with a valid value; the after-hook rewrites the result
    // the caller ultimately sees.
    await bundle.harness.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "accepted",
      value: { ok: true },
    });
    const result = await pending;
    expect(result).toEqual({ outcome: "declined", reason: "hooked" });
  });

  it("a throw in onBefore vetoes — no request is published and elicit rejects", async () => {
    bundle = await fakeElicitation({
      hooks: Hooks.from({
        onBeforeElicitationElicit: () => {
          throw new Error("elicit blocked");
        },
      }),
    });
    let published = 0;
    const watcher = Effect.runFork(
      Stream.runForEach(
        bundle.bus.subscribe({ surface: "session", name: { exact: ELICITATION_CHANNEL_FQN } }),
        () => Effect.sync(() => void published++),
      ),
    );
    await expect(
      bundle.harness.elicit({ message: "blocked?", schema: lenientObject() }, { timeoutMs: 500 }),
    ).rejects.toThrow("elicit blocked");
    // The veto short-circuits the op body, so the inner request never runs —
    // nothing is published on the channel.
    expect(published).toBe(0);
    await Effect.runPromise(Fiber.interrupt(watcher));
  });
});

/**
 * The round-trip recorder, driven the way an adopter drives it: `createApp({
 * hooks: roundTripRecorder(...) })`, then `session.send(...)`.
 *
 * The recorder itself lives in `@agentick/session` — the span crosses compiler,
 * model and timeline, and that is the package that depends on all three, so it
 * is the only one that can NAME their augmented hook keys. This test lives HERE
 * because `createApp` does, and app depends on session (not the reverse).
 *
 * Not through `executor.hook(...)`. The defect that made this recorder necessary
 * — the declarative fold silently dropping every chunk entry — was invisible to
 * a harness-level test and visible immediately from the entry point a user
 * types. The claims here are correlation claims, and correlation is exactly what
 * a proxy gets wrong.
 *
 * What is pinned:
 *   - taps ⓪–⑤ land in ONE trip, across THREE harnesses (compiler, model,
 *     timeline) that are siblings under a tick, joined only by `tickId`
 *   - ③ and ④ hold distinguishably different shapes, so the bracket around
 *     normalization is not vacuous
 *   - MULTI-TICK: one trip per tick, in order, each carrying its own tick's
 *     data — the shape corruption-compounding would actually take
 *   - `verbatimViolations` catches a splice introduced between what was streamed
 *     and what was PERSISTED, which is the failure that feeds back into the
 *     model on the next tick
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import type {
  AdapterDelta,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelTarget,
} from "@agentick/spec";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

import {
  memorySink,
  roundTripRecorder,
  verbatimViolations,
  type RoundTrip,
} from "@agentick/session";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "you are a test");

const TARGET: LanguageModelTarget = {
  kind: "language-model",
  provider: "stub",
  modelId: "stub-v1",
  capabilities: { supportsStreaming: true },
};

/** The provider's own chunk shape — deliberately NOT an `AdapterDelta`, so tap ③ and tap ④ are distinguishable. */
interface RawChunk {
  readonly raw: string;
}

/**
 * A streaming adapter that emits `texts[i]` on the i-th call, one raw chunk per
 * character. `splice` corrupts the reconstructed message WITHOUT touching the
 * deltas — the exact shape of the bug this recorder hunts.
 */
function stubAdapter(
  texts: readonly string[],
  splice?: string,
): LanguageModelAdapter<{ text: string }, RawChunk, unknown> {
  let call = 0;
  return {
    provider: "stub",
    target: TARGET,
    prepareRequest: (input: ExecuteInput<LanguageModelInput>) => ({
      model: input.target.modelId ?? "stub-v1",
      // Distinguishes tap ② (native request) from tap ① (canonical input).
      native: true,
    }),
    send: async () => ({ text: texts[0] ?? "" }),
    openStream: async function* () {
      const text = texts[Math.min(call++, texts.length - 1)] ?? "";
      for (const char of text) yield { raw: char };
    },
    mapChunk: (chunk, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
      ...(accum.textByBlock.has(0)
        ? []
        : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
      { type: "content-delta", blockIndex: 0, delta: chunk.raw },
    ],
    reconstructRaw: (accum: StreamAccumulatorView) => ({
      text: splice !== undefined ? splice + accum.totalText() : accum.totalText(),
    }),
    normalize: (raw): LanguageModelExecutionResult => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  };
}

/** Drive N sends through the real app composition and return the captured trips. */
async function capture(
  texts: readonly string[],
  options: { readonly splice?: string; readonly sends?: number } = {},
): Promise<readonly RoundTrip[]> {
  const sink = memorySink();
  const app = await createApp(React.createElement(Agent), {
    model: stubAdapter(texts, options.splice),
    hooks: roundTripRecorder({ sink }),
  });
  try {
    const session = await app.createSession();
    for (let i = 0; i < (options.sends ?? 1); i++) {
      await (
        await session.send({ messages: [{ role: "user", content: `ping ${i}` }] })
      ).result;
    }
  } finally {
    await app.closeApp();
  }
  return sink.trips;
}

describe("roundTripRecorder — the full ⓪–⑤ span through createApp", () => {
  it("lands every tap in ONE trip", async () => {
    const [trip] = await capture(["ok"]);
    expect(trip).toBeDefined();

    // ⓪ the tree the JSX produced — a COMPILER hook, a sibling harness.
    expect(trip!.tree?.context.entries.length).toBeGreaterThan(0);
    // ① the canonical input.
    expect(trip!.compiled?.messages?.length).toBeGreaterThan(0);
    // ② the provider-NATIVE request — a different shape from ①, or the
    //    bracket around `prepareRequest` proves nothing.
    expect(trip!.request).toMatchObject({ native: true });
    // ③ raw provider chunks, PRE-mapChunk — the provider's own shape.
    expect(trip!.rawChunks).toEqual([{ raw: "o" }, { raw: "k" }]);
    // ④ canonical deltas, POST-transform — AdapterDeltas, not RawChunks.
    expect(trip!.deltas.some((d) => d.type === "content-delta")).toBe(true);
    expect(trip!.dropped).toEqual({ rawChunks: 0, deltas: 0 });
  });

  // Tap ⑤ is the terminus, and it only works because the whole apply path is
  // Effect-native down to the timeline write. `tickId` is ambient ON the fiber,
  // so a single `runPromise` root anywhere between the tick and the append
  // silently drops it — which is exactly what `Effect.tryPromise(() =>
  // this.applyExecutorResultBody(...))` used to do from inside the fx twin.
  it("captures ⑤ — what was actually appended to the timeline", async () => {
    const [trip] = await capture(["ok"]);
    expect(trip!.persisted.some((entry) => entry.role === "assistant")).toBe(true);
  });

  it("joins three sibling harnesses on ONE tickId", async () => {
    const [trip] = await capture(["ok"]);
    // The compiler opened this trip and the model backfilled its op — proof the
    // join key is the tick and not a parent/child op chain, which does not exist
    // between these harnesses.
    expect(trip!.scope.tickId).toBeTruthy();
    expect(trip!.scope.sessionId).toBeTruthy();
    expect(trip!.scope.executionId).toBeTruthy();
  });

  it("records ONE trip per tick, in order — the multi-tick view", async () => {
    const trips = await capture(["first", "second"], { sends: 2 });

    expect(trips).toHaveLength(2);
    // Distinct ticks, not one trip reused or two views of the same call.
    expect(trips[0]!.scope.tickId).not.toBe(trips[1]!.scope.tickId);
    // Each carries ITS OWN tick's stream, which is what makes a splice that
    // compounds tick-over-tick visible at all.
    expect(trips[0]!.rawChunks.map((c) => (c as RawChunk).raw).join("")).toBe("first");
    expect(trips[1]!.rawChunks.map((c) => (c as RawChunk).raw).join("")).toBe("second");
  });

  it("carries the growing timeline forward — tick 2 sees tick 1's message", async () => {
    const trips = await capture(["first", "second"], { sends: 2 });
    // The invariant's whole reason for existing: what tick 1 persisted is fed
    // back as input to tick 2. If a splice lands in ⑤ it becomes an exemplar.
    const secondInput = JSON.stringify(trips[1]!.compiled);
    expect(secondInput).toContain("first");
  });

  it("is clean when nothing splices", async () => {
    const [trip] = await capture(["hello"]);
    expect(verbatimViolations(trip!)).toEqual([]);
    // Guard: the clean case must have summaries to compare, or the assertion
    // above passes vacuously.
    expect(trip!.deltas.some((d) => d.type === "content")).toBe(true);
  });

  it("catches text that reached the timeline but was never streamed", async () => {
    const [trip] = await capture(["hello"], { splice: ", openai-api" });

    const violations = verbatimViolations(trip!);
    expect(violations.length).toBeGreaterThan(0);
    // The persisted message is the one that feeds back, so that is the
    // violation that matters.
    const persisted = violations.find((v) => v.kind === "persisted-text-mismatch");
    expect(persisted).toBeDefined();
    expect(persisted!.assembled).toContain(", openai-api");
    expect(persisted!.streamed).not.toContain(", openai-api");
  });
});

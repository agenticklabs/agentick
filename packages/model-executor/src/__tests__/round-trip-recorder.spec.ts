/**
 * The round-trip recorder, against the REAL `LanguageModelExecutor`.
 *
 * A stub adapter would prove the hooks fire; only the real executor proves the
 * thing that actually matters — that four hooks on TWO different commands
 * (`model:generate_stream` and the nested `model:provider-request`) land in ONE
 * trip. That correlation rides on the executor threading `parentOpId`, which is
 * an executor behaviour, not a recorder behaviour. If it ever stops holding, the
 * recorder silently produces half-trips, so it is pinned here.
 *
 * The adapter deliberately uses DISTINGUISHABLE currencies — a native request
 * with `maxTokens`, raw chunks shaped `{ raw }`, canonical deltas shaped
 * `{ type }` — so a test asserting "tap ③ holds raw chunks" cannot pass by
 * accident on a canonical delta.
 */

import { describe, expect, it } from "vitest";

import type {
  AdapterDelta,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelTarget,
} from "@agentick/spec";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { LanguageModelExecutor } from "../language-model-executor.js";
import {
  memorySink,
  roundTripRecorder,
  verbatimViolations,
  type RoundTrip,
} from "../round-trip-recorder.js";

interface NativeReq {
  readonly model: string;
  readonly maxTokens: number;
}
interface RawChunk {
  readonly raw: string;
}
interface RawResp {
  readonly text: string;
}

const TARGET: LanguageModelTarget = {
  kind: "language-model",
  provider: "stub",
  modelId: "stub-v1",
};

/**
 * `mapChunk` emits one text block; `splice` optionally corrupts the accumulated
 * text so the verbatim check has something real to catch.
 */
function stubAdapter(
  chunks: readonly string[],
  opts: { readonly splice?: string } = {},
): LanguageModelAdapter<RawResp, RawChunk, NativeReq> {
  return {
    provider: "stub",
    target: TARGET,
    prepareRequest: (input: ExecuteInput<LanguageModelInput>): NativeReq => ({
      model: input.target.modelId ?? "stub-v1",
      maxTokens: 7,
    }),
    send: async (): Promise<RawResp> => ({ text: chunks.join("") }),
    openStream: async function* (): AsyncIterable<RawChunk> {
      for (const raw of chunks) yield { raw };
    },
    mapChunk: (chunk: RawChunk, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
      ...(accum.textByBlock.has(0)
        ? []
        : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
      { type: "content-delta", blockIndex: 0, delta: chunk.raw },
    ],
    reconstructRaw: (accum: StreamAccumulatorView): RawResp => ({ text: accum.totalText() }),
    normalize: (raw: RawResp): LanguageModelExecutionResult => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
    // A transform that INSERTS text is precisely the defect class the invariant
    // exists to catch — the accumulator ends up holding text no delta carried.
    ...(opts.splice !== undefined
      ? {
          finalizeStream: (accum: StreamAccumulatorView): readonly AdapterDelta[] => [
            { type: "content-end", blockIndex: 0 },
            {
              type: "content",
              blockIndex: 0,
              content: { type: "text", text: opts.splice + accum.totalText() },
            },
            {
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: opts.splice + accum.totalText() }],
              },
              stopReason: "end",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            },
          ],
        }
      : {}),
  };
}

async function runWithRecorder(
  adapter: LanguageModelAdapter<RawResp, RawChunk, NativeReq>,
): Promise<readonly RoundTrip[]> {
  const exec = new LanguageModelExecutor<RawResp, RawChunk>(
    "exec-rt",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter },
  );
  await exec.ready;

  const sink = memorySink();
  const off = exec.hook(roundTripRecorder({ sink }));

  const stream = exec.executeStream({
    targetInput: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    target: TARGET,
  });
  for await (const _ of stream) void _;
  await stream.result.catch(() => undefined);

  off();
  await exec.close();
  return sink.trips;
}

describe("roundTripRecorder", () => {
  it("emits exactly one trip per model call", async () => {
    const trips = await runWithRecorder(stubAdapter(["he", "llo"]));
    expect(trips).toHaveLength(1);
  });

  // THE correlation test. Taps ① and ④ fire on `model:generate_stream`; taps ②
  // and ③ fire on the nested `model:provider-request`. They reach one trip only
  // because the executor threads `parentOpId`.
  it("lands all four taps in ONE trip across two commands", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["he", "llo"]));

    expect(trip!.compiled).toBeDefined(); // ① generate
    expect(trip!.request).toBeDefined(); // ② provider-request
    expect(trip!.rawChunks.length).toBeGreaterThan(0); // ③ provider-request
    expect(trip!.deltas.length).toBeGreaterThan(0); // ④ generate
  });

  it("holds the CANONICAL input at tap ①, not the provider request", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["hi"]));
    expect(trip!.compiled?.messages?.[0]?.role).toBe("user");
    expect((trip!.compiled as unknown as NativeReq).maxTokens).toBeUndefined();
  });

  it("holds the PROVIDER-NATIVE request at tap ②, not the canonical input", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["hi"]));
    const request = trip!.request as NativeReq;
    expect(request.maxTokens).toBe(7);
    expect((request as unknown as LanguageModelInput).messages).toBeUndefined();
  });

  // ③ and ④ must be DIFFERENT shapes — that is the whole point of bracketing the
  // normalization pipeline. If they were the same, the diff would be vacuous.
  it("brackets the pipeline: raw chunks at ③, canonical deltas at ④", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["he", "llo"]));

    expect(trip!.rawChunks).toEqual([{ raw: "he" }, { raw: "llo" }]);
    for (const chunk of trip!.rawChunks) {
      expect((chunk as { type?: string }).type).toBeUndefined();
    }
    expect(trip!.deltas.every((d) => typeof d.type === "string")).toBe(true);
  });

  it("captures the persisted assistant message from the terminal delta", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["he", "llo"]));
    expect(trip!.message?.role).toBe("assistant");
    expect(trip!.message?.content).toContainEqual({ type: "text", text: "hello" });
  });

  it("carries correlation so concurrent sessions stay separable", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["hi"]));
    expect(trip!.scope.opId).toBeTruthy();
  });

  it("reports nothing dropped on a short stream", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["hi"]));
    expect(trip!.dropped).toEqual({ rawChunks: 0, deltas: 0 });
  });
});

describe("verbatimViolations", () => {
  it("passes a clean round trip", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["he", "llo"]));
    expect(verbatimViolations(trip!)).toEqual([]);
  });

  // Guards the test above from rotting into a vacuous pass: with no `content`
  // summaries in the trip there is nothing to compare, and EVERY trip would look
  // clean — including a spliced one.
  it("has something to compare — a clean trip carries summaries AND deltas", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["he", "llo"]));
    expect(trip!.deltas.filter((d) => d.type === "content").length).toBeGreaterThan(0);
    expect(trip!.deltas.filter((d) => d.type === "content-delta").length).toBeGreaterThan(0);
  });

  // The regression this whole file exists for: text in the assembled message
  // that no delta ever carried. Left undetected it is persisted, fed back, and
  // becomes an exemplar the model imitates.
  it("CATCHES text spliced into the block summary that no delta carried", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["he", "llo"], { splice: ", skills" }));

    const violations = verbatimViolations(trip!);
    expect(violations.length).toBeGreaterThan(0);

    const blockViolation = violations.find((v) => v.kind === "block-text-mismatch");
    expect(blockViolation).toBeDefined();
    expect(blockViolation!.blockIndex).toBe(0);
    expect(blockViolation!.streamed).toBe("hello");
    expect(blockViolation!.assembled).toBe(", skillshello");
  });

  it("names the block so a violation points at the seam", async () => {
    const [trip] = await runWithRecorder(stubAdapter(["x"], { splice: "JUNK" }));
    expect(verbatimViolations(trip!)[0]!.detail).toContain("block 0");
  });
});

/**
 * `LanguageModelExecutor.fx.executeStream` — the STREAMING edge's canonical
 * Effect twin (ADR 77 Stage 2, sink-fold form). De-risks the streaming twin:
 * proves the Effect-native side composes in the loop's fiber with none of
 * the Queue/fork/Promise machinery the JS facade needs.
 *
 * Proves:
 *   - `fx.executeStream(input, sink)` is a composable Effect that drives the
 *     provider ONCE, invoking `sink` per delta, and succeeds with the raw.
 *   - It nests in the loop's shape — project → executeStream → normalize —
 *     inside one `Effect.gen` (single fiber, no runPromise between phases).
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type {
  AdapterDelta,
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  RenderedTree,
} from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { LanguageModelExecutor } from "../language-model-executor.js";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

interface StubRaw {
  readonly text: string;
}
interface StubChunk {
  readonly text: string;
  readonly model?: string;
}

function streamingAdapter(chunks: readonly StubChunk[]): LanguageModelAdapter<StubRaw, StubChunk> {
  return {
    provider: "stub",
    target: { kind: "language-model", provider: "stub", modelId: "stub-v1" },
    streamByDefault: true,
    prepareRequest(_input: ExecuteInput<LanguageModelInput>): unknown {
      return {};
    },
    send(): Promise<StubRaw> {
      return Promise.resolve({ text: chunks.map((c) => c.text).join("") });
    },
    async *openStream(): AsyncIterable<StubChunk> {
      for (const c of chunks) yield c;
    },
    mapChunk(chunk: StubChunk, accum: StreamAccumulatorView): readonly AdapterDelta[] {
      const out: AdapterDelta[] = [];
      if (chunk.model && !accum.modelSeen) {
        out.push({ type: "message-start", role: "assistant", model: chunk.model });
      }
      if (chunk.text.length > 0) {
        if (!accum.openBlocks.has(0) && !accum.textByBlock.has(0)) {
          out.push({ type: "content-start", blockIndex: 0, blockType: "text" });
        }
        out.push({ type: "content-delta", blockIndex: 0, delta: chunk.text });
      }
      return out;
    },
    reconstructRaw(accum: StreamAccumulatorView): StubRaw {
      return { text: accum.totalText() };
    },
    normalize(raw: StubRaw): LanguageModelExecutionResult {
      return {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: raw.text }],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  };
}

async function makeExecutor(
  chunks: readonly StubChunk[],
): Promise<LanguageModelExecutor<StubRaw, StubChunk>> {
  const exec = new LanguageModelExecutor<StubRaw, StubChunk>(
    "exec-stream-fx",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: streamingAdapter(chunks) },
  );
  await exec.ready;
  return exec;
}

const emptyTree = (): RenderedTree => ({ specVersion: "2026-05-08", context: { entries: [] } });
const target: ExecutionTarget = { kind: "language-model", provider: "stub", modelId: "stub-v1" };

describe("LanguageModelExecutor — .fx.executeStream (streaming edge twin)", () => {
  it("fx.executeStream is a composable Effect that forwards deltas + returns raw", async () => {
    const exec = await makeExecutor([{ text: "He", model: "stub-v1" }, { text: "llo" }]);
    const projected = await exec.project({
      compiled: emptyTree(),
      target,
      scope: { executionId: "e1" },
      tools: [],
    });

    const deltas: AdapterDelta[] = [];
    const eff = exec.fx.executeStream(
      { targetInput: projected, target, scope: { executionId: "e1" } },
      (d) =>
        Effect.sync(() => {
          deltas.push(d);
        }),
    );
    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);
    expect(deltas).toHaveLength(0); // un-run: nothing forwarded yet

    const raw = await Effect.runPromise(eff);

    expect(deltas.some((d) => d.type === "content-delta")).toBe(true);
    expect(raw.text).toBe("Hello");
  });

  it("composes project → executeStream → normalize in one Effect.gen (loop shape)", async () => {
    const exec = await makeExecutor([{ text: "Hi", model: "stub-v1" }, { text: " there" }]);

    const { forwarded, normalized } = await Effect.runPromise(
      Effect.gen(function* () {
        const projected = yield* Effect.promise(() =>
          exec.project({ compiled: emptyTree(), target, scope: { executionId: "e2" }, tools: [] }),
        );
        const forwarded: AdapterDelta[] = [];
        // The streaming twin composes with yield* — one fiber, sink forwards.
        const raw = yield* exec.fx.executeStream(
          { targetInput: projected, target, scope: { executionId: "e2" } },
          (d) => Effect.sync(() => forwarded.push(d)),
        );
        const normalized = yield* Effect.promise(() =>
          exec.normalize({ targetOutput: raw, target, scope: { executionId: "e2" } }),
        );
        return { forwarded, normalized };
      }),
    );

    expect(forwarded.some((d) => d.type === "content-delta")).toBe(true);
    expect(normalized.output).toEqual([{ type: "text", text: "Hi there" }]);
  });
});

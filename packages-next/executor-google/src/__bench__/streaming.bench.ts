/**
 * Streaming hot-path benchmarks for `GoogleExecutor`.
 *
 * Baseline numbers gathered BEFORE any streaming-aggregation refactor.
 * Run with:
 *
 *   pnpm vitest bench --run packages/executor-google/src/__bench__/streaming.bench.ts
 *
 * Each bench drives the executor end-to-end against `StubGoogleClient`
 * over a pre-built `GenerateContentResponse[]`. Google's adapter uses
 * a single-pass `StreamAccumulator` and skips the second walk in
 * `normalize()` — these numbers are the comparison baseline for
 * OpenAI/Anthropic, both of which run dual aggregation.
 */

import { Effect, Fiber, Stream } from "effect";
import { afterAll, bench, describe } from "vitest";
import type { GenerateContentResponse } from "@google/genai";

import type { LanguageModelTarget, RenderedTree } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { GoogleExecutor } from "../google-executor.js";
import {
  StubGoogleClient,
  asClient,
  mkTextChunk,
  mkFunctionCallChunk,
  mkFinishChunk,
} from "../__tests__/stub-google-client.js";

const ITERATIONS = 25;

function emptyTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m_1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}

function mkTarget(): LanguageModelTarget {
  return { kind: "language-model", provider: "google", modelId: "gemini-2.5-flash" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canned chunk builders — deterministic.
// ─────────────────────────────────────────────────────────────────────────────

function buildTextStream(count: number): GenerateContentResponse[] {
  const chunks: GenerateContentResponse[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push(mkTextChunk("x"));
  }
  chunks.push(
    mkFinishChunk({
      finishReason: "STOP",
      usage: { promptTokenCount: 4, candidatesTokenCount: count },
    }),
  );
  return chunks;
}

function buildTextPlusToolStream(textCount: number): GenerateContentResponse[] {
  const chunks: GenerateContentResponse[] = [];
  for (let i = 0; i < textCount; i++) {
    chunks.push(mkTextChunk("x"));
  }
  chunks.push(
    mkFunctionCallChunk({ id: "call_bench_1", name: "calc", args: { a: 2, b: 3 } }),
  );
  chunks.push(
    mkFinishChunk({
      finishReason: "STOP",
      usage: { promptTokenCount: 4, candidatesTokenCount: textCount + 1 },
    }),
  );
  return chunks;
}

async function makeStreamingExecutor(chunks: ReadonlyArray<GenerateContentResponse>) {
  const stub = new StubGoogleClient([{ kind: "streaming", chunks }]);
  const journal = new MemoryJournal({ capacity: 10_000_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new GoogleExecutor("exec-bench-google", journal, bus, inbox, {
    client: asClient(stub),
    model: "gemini-2.5-flash",
    stream: true,
  });
  await exec.ready;
  return { exec, bus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: 1000 text deltas, no bus subscriber.
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleExecutor.run — 1000 text deltas (no subscriber)", () => {
  const chunks = buildTextStream(1000);

  bench(
    "1000 text deltas",
    async () => {
      const { exec } = await makeStreamingExecutor(chunks);
      await exec.run({ compiled: emptyTree(), target: mkTarget() });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: 100 text deltas + 1 tool_call, no subscriber.
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleExecutor.run — 100 text deltas + 1 tool_call (no subscriber)", () => {
  const chunks = buildTextPlusToolStream(100);

  bench(
    "100 text + 1 tool_call",
    async () => {
      const { exec } = await makeStreamingExecutor(chunks);
      await exec.run({ compiled: emptyTree(), target: mkTarget() });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: 100 text deltas, no subscriber (cross-adapter parity).
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleExecutor.run — 100 text deltas (no subscriber)", () => {
  const chunks = buildTextStream(100);

  bench(
    "100 text deltas (no subscriber)",
    async () => {
      const { exec } = await makeStreamingExecutor(chunks);
      await exec.run({ compiled: emptyTree(), target: mkTarget() });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: 100 text deltas, 1 subscriber draining `executor:delta`.
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleExecutor.run — 100 text deltas (1 subscriber)", () => {
  const chunks = buildTextStream(100);
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let bus: LocalEventBus | undefined;
  let exec: GoogleExecutor | undefined;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench(
    "100 text deltas (1 subscriber)",
    async () => {
      if (!exec) {
        const fixture = await makeStreamingExecutor(chunks);
        exec = fixture.exec;
        bus = fixture.bus;
        consumer = Effect.runFork(
          Stream.runDrain(bus.subscribe({ surface: "executor", phase: "delta" })),
        );
        await new Promise((r) => setImmediate(r));
      }
      await exec.run({ compiled: emptyTree(), target: mkTarget() });
    },
    { iterations: ITERATIONS },
  );
});

/**
 * Streaming hot-path benchmarks for `LanguageModelExecutor` + the
 * `openai()` adapter.
 *
 * Baseline numbers gathered BEFORE any streaming-aggregation refactor.
 * Run with:
 *
 *   pnpm vitest bench --run packages/executor-openai/src/__bench__/streaming.bench.ts
 *
 * Each bench drives the executor end-to-end against `StubOpenAIClient`
 * over a pre-built `ChatCompletionChunk[]` so there is no network
 * cost — every cycle measured here is real work inside the executor's
 * streaming loop:
 *   1. iterating chunks
 *   2. mapping each chunk via `mapChunk` → `AdapterDelta`
 *   3. emitting a `bus.publishLazy` envelope per delta via
 *      `emitDeltaLazy` (a fresh `Effect.runPromise` entrance per delta)
 *   4. accumulating into `StreamAccumulator` AND the in-loop
 *      `Map<number, BlockState>` (the dual-walk pattern)
 *   5. final `normalize()` walk.
 *
 * Scenarios:
 *   - 1000-text-deltas (no bus subscriber)
 *   - 100-text-deltas + 1 tool_call (no bus subscriber)
 *   - 100-text-deltas (no subscriber) — for cross-adapter parity
 *   - 100-text-deltas (1 draining subscriber)
 */

import { Effect, Fiber, Stream } from "effect";
import { afterAll, bench, describe } from "vitest";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import type { LanguageModelTarget, RenderedTree } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { LanguageModelExecutor } from "@agentick/executor-next";

import { openai } from "../openai-adapter.js";
import {
  StubOpenAIClient,
  asClient,
  mkContentChunk,
  mkFinishChunk,
} from "../__tests__/stub-openai-client.js";

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
  return { kind: "language-model", provider: "openai", modelId: "gpt-4o-mini" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canned chunk builders — deterministic, no randomness.
// ─────────────────────────────────────────────────────────────────────────────

function buildTextStream(count: number): ChatCompletionChunk[] {
  const out: ChatCompletionChunk[] = [];
  for (let i = 0; i < count; i++) {
    out.push(mkContentChunk({ delta: "x" }));
  }
  out.push(mkFinishChunk({ finishReason: "stop" }));
  return out;
}

/**
 * 100 text deltas + a streamed tool_call (id + name announced once,
 * arguments split into 3 input-delta chunks), then finish.
 */
function buildTextPlusToolStream(textCount: number): ChatCompletionChunk[] {
  const out: ChatCompletionChunk[] = [];
  for (let i = 0; i < textCount; i++) {
    out.push(mkContentChunk({ delta: "x" }));
  }
  // Tool call streamed across chunks (OpenAI tool_call delta protocol).
  const baseChunk = (delta: ChatCompletionChunk["choices"][0]["delta"]): ChatCompletionChunk =>
    ({
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
    }) as ChatCompletionChunk;
  out.push(
    baseChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_bench_1",
          type: "function",
          function: { name: "calc", arguments: "" },
        },
      ],
    }),
  );
  out.push(
    baseChunk({
      tool_calls: [{ index: 0, function: { arguments: '{"a":' } }],
    }),
  );
  out.push(
    baseChunk({
      tool_calls: [{ index: 0, function: { arguments: "2," } }],
    }),
  );
  out.push(
    baseChunk({
      tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }],
    }),
  );
  out.push(mkFinishChunk({ finishReason: "tool_calls" }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders — fresh stub + executor per fixture (a single stub
// can be consumed across many `run()` calls because the stub clamps to
// the last matching entry once consumed).
// ─────────────────────────────────────────────────────────────────────────────

async function makeStreamingExecutor(
  chunks: ReadonlyArray<ChatCompletionChunk>,
  busOpts?: ConstructorParameters<typeof LocalEventBus>[0],
) {
  const stub = new StubOpenAIClient([{ kind: "streaming", chunks }]);
  const journal = new MemoryJournal({ capacity: 10_000_000 });
  const bus = new LocalEventBus(busOpts);
  const inbox = new LocalInbox();
  const exec = new LanguageModelExecutor("exec-bench-openai", journal, bus, inbox, {
    adapter: openai("gpt-4o-mini", { client: asClient(stub), stream: true }),
  });
  await exec.ready;
  return { exec, bus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: 1000 text deltas, no bus subscriber.
// ─────────────────────────────────────────────────────────────────────────────

describe("openai() adapter run — 1000 text deltas (no subscriber)", () => {
  const chunks = buildTextStream(1000);

  bench(
    "1000 text deltas",
    async () => {
      const { exec } = await makeStreamingExecutor(chunks);
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: 100 text deltas + 1 tool_call, no subscriber.
// ─────────────────────────────────────────────────────────────────────────────

describe("openai() adapter run — 100 text deltas + 1 tool_call (no subscriber)", () => {
  const chunks = buildTextPlusToolStream(100);

  bench(
    "100 text + 1 tool_call",
    async () => {
      const { exec } = await makeStreamingExecutor(chunks);
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: 100 text deltas, no bus subscriber (cross-adapter parity).
// ─────────────────────────────────────────────────────────────────────────────

describe("openai() adapter run — 100 text deltas (no subscriber)", () => {
  const chunks = buildTextStream(100);

  bench(
    "100 text deltas (no subscriber)",
    async () => {
      const { exec } = await makeStreamingExecutor(chunks);
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: 100 text deltas, 1 subscriber draining `executor:delta`.
// ─────────────────────────────────────────────────────────────────────────────

describe("openai() adapter run — 100 text deltas (1 subscriber)", () => {
  const chunks = buildTextStream(100);
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let bus: LocalEventBus | undefined;
  let exec: LanguageModelExecutor | undefined;

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
        // Allow the subscriber fiber to register.
        await new Promise((r) => setImmediate(r));
      }
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — Phase B A/B: 100 text deltas + 1 subscriber, batching OFF.
// Phase B baseline. Pair with Scenario 6 to size the transparent win on
// the real executor hot path.
// ─────────────────────────────────────────────────────────────────────────────

describe("openai() adapter run — 100 deltas + 1 sub, batching OFF (Phase B baseline)", () => {
  const chunks = buildTextStream(100);
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let bus: LocalEventBus | undefined;
  let exec: LanguageModelExecutor | undefined;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench(
    "100 deltas, 1 sub, batching OFF",
    async () => {
      if (!exec) {
        const fixture = await makeStreamingExecutor(chunks, { batch: {} });
        exec = fixture.exec;
        bus = fixture.bus;
        consumer = Effect.runFork(
          Stream.runDrain(bus.subscribe({ surface: "executor", phase: "delta" })),
        );
        await new Promise((r) => setImmediate(r));
      }
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — Phase B A/B: 100 text deltas + 1 subscriber, batching ON.
// ─────────────────────────────────────────────────────────────────────────────

describe("openai() adapter run — 100 deltas + 1 sub, batching ON (Phase B default)", () => {
  const chunks = buildTextStream(100);
  let consumer: Fiber.RuntimeFiber<void, unknown> | undefined;
  let bus: LocalEventBus | undefined;
  let exec: LanguageModelExecutor | undefined;

  afterAll(async () => {
    if (consumer) await Effect.runPromise(Fiber.interrupt(consumer));
  });

  bench(
    "100 deltas, 1 sub, batching ON",
    async () => {
      if (!exec) {
        const fixture = await makeStreamingExecutor(chunks); // default policy
        exec = fixture.exec;
        bus = fixture.bus;
        consumer = Effect.runFork(
          Stream.runDrain(bus.subscribe({ surface: "executor", phase: "delta" })),
        );
        await new Promise((r) => setImmediate(r));
      }
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

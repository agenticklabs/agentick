/**
 * Streaming hot-path benchmarks for `LanguageModelExecutor` + the
 * `anthropic()` adapter.
 *
 * Baseline numbers gathered BEFORE any streaming-aggregation refactor.
 * Run with:
 *
 *   pnpm vitest bench --run packages/executor-anthropic/src/__bench__/streaming.bench.ts
 *
 * Each bench drives the executor end-to-end against `StubAnthropicClient`
 * over a pre-built `RawMessageStreamEvent[]` so there is no network
 * cost — every cycle measured here is real work inside the executor's
 * streaming loop:
 *   1. iterating events
 *   2. mapping each event via `mapChunk` → `AdapterDelta`
 *   3. emitting `bus.publishLazy` per delta via `emitDeltaLazy`
 *      (a fresh `Effect.runPromise` entrance per delta)
 *   4. accumulating into `StreamAccumulator` AND the per-block
 *      `Map<number, BlockState>` in the main loop (dual-walk pattern)
 *   5. final `normalize()` walk.
 */

import { Effect, Fiber, Stream } from "effect";
import { afterAll, bench, describe } from "vitest";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";

import type { LanguageModelTarget, RenderedTree } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { LanguageModelExecutor } from "@agentick/executor-next";

import { anthropic } from "../anthropic-adapter.js";
import {
  StubAnthropicClient,
  asClient,
  mkMessageStartEvent,
  mkContentBlockStartText,
  mkContentBlockStartToolUse,
  mkTextDelta,
  mkInputJsonDelta,
  mkContentBlockStop,
  mkMessageDelta,
  mkMessageStop,
} from "../__tests__/stub-anthropic-client.js";

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
  return {
    kind: "language-model",
    provider: "anthropic",
    modelId: "claude-3-5-sonnet-latest",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canned event builders — deterministic, no randomness.
// ─────────────────────────────────────────────────────────────────────────────

function buildTextStream(count: number): RawMessageStreamEvent[] {
  const events: RawMessageStreamEvent[] = [];
  events.push(mkMessageStartEvent({ inputTokens: 4 }));
  events.push(mkContentBlockStartText(0));
  for (let i = 0; i < count; i++) {
    events.push(mkTextDelta(0, "x"));
  }
  events.push(mkContentBlockStop(0));
  events.push(mkMessageDelta("end_turn", count));
  events.push(mkMessageStop());
  return events;
}

function buildTextPlusToolStream(textCount: number): RawMessageStreamEvent[] {
  const events: RawMessageStreamEvent[] = [];
  events.push(mkMessageStartEvent({ inputTokens: 4 }));
  events.push(mkContentBlockStartText(0));
  for (let i = 0; i < textCount; i++) {
    events.push(mkTextDelta(0, "x"));
  }
  events.push(mkContentBlockStop(0));
  // Tool call streamed across input_json_delta events.
  events.push(mkContentBlockStartToolUse(1, "call_bench_1", "calc"));
  events.push(mkInputJsonDelta(1, '{"a":'));
  events.push(mkInputJsonDelta(1, "2,"));
  events.push(mkInputJsonDelta(1, '"b":3}'));
  events.push(mkContentBlockStop(1));
  events.push(mkMessageDelta("tool_use", textCount + 5));
  events.push(mkMessageStop());
  return events;
}

async function makeStreamingExecutor(events: ReadonlyArray<RawMessageStreamEvent>) {
  const stub = new StubAnthropicClient([{ kind: "streaming", events }]);
  const journal = new MemoryJournal({ capacity: 10_000_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new LanguageModelExecutor("exec-bench-anthropic", journal, bus, inbox, {
    adapter: anthropic("claude-3-5-sonnet-latest", { client: asClient(stub), stream: true }),
  });
  await exec.ready;
  return { exec, bus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: 1000 text deltas, no bus subscriber.
// ─────────────────────────────────────────────────────────────────────────────

describe("anthropic() adapter run — 1000 text deltas (no subscriber)", () => {
  const events = buildTextStream(1000);

  bench(
    "1000 text deltas",
    async () => {
      const { exec } = await makeStreamingExecutor(events);
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: 100 text deltas + 1 tool_call (no subscriber).
// ─────────────────────────────────────────────────────────────────────────────

describe("anthropic() adapter run — 100 text deltas + 1 tool_call (no subscriber)", () => {
  const events = buildTextPlusToolStream(100);

  bench(
    "100 text + 1 tool_call",
    async () => {
      const { exec } = await makeStreamingExecutor(events);
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: 100 text deltas, no subscriber (cross-adapter parity).
// ─────────────────────────────────────────────────────────────────────────────

describe("anthropic() adapter run — 100 text deltas (no subscriber)", () => {
  const events = buildTextStream(100);

  bench(
    "100 text deltas (no subscriber)",
    async () => {
      const { exec } = await makeStreamingExecutor(events);
      await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    },
    { iterations: ITERATIONS },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: 100 text deltas, 1 subscriber draining `executor:delta`.
// ─────────────────────────────────────────────────────────────────────────────

describe("anthropic() adapter run — 100 text deltas (1 subscriber)", () => {
  const events = buildTextStream(100);
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
        const fixture = await makeStreamingExecutor(events);
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

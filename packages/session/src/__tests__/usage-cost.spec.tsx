/**
 * Usage → cost, session side (`docs/proposals/v2/usage-cost.md` §5–§7).
 *
 * The session is where a tick's stamped cost becomes a durable record. What
 * is pinned here:
 *
 *  - §5  — `cost` + `model` land on the assistant entry's
 *          `SessionMessageMetadata`, next to `usage`.
 *  - §7  — `byModel` is preserved at every level (tick → turn → session), and
 *          the flat `usage` stays a real, summable answer beside it.
 *  - §6  — THE HONESTY RULE. An unpriced tick rolls up as explicitly
 *          unpriced; it is never a zero contribution to a `complete` total,
 *          and a mixed run's amount is the priced subset only.
 *  - the accounting survives snapshot → restore. A stamped cost that does not
 *    survive a reload defeats the point of stamping it.
 *
 * The loop is a `defineLoop` stub driving the session's REAL
 * `stateApplicator.applyExecutorResult` — the seam the shipped loop uses.
 * Cost STAMPING is the loop's job (it owns the per-tick model cascade), so
 * scripting the stamped values here isolates the session's fold, which is
 * what this file is about.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { ElicitationHarness } from "@agentick/elicitation";
import { defineLoop, LoopExecutorHarness } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { spyTelemetryProvider, type SpyTelemetryProvider } from "@agentick/runtime/testing";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import type {
  Cost,
  ExecutionRunResult,
  ExecutionTarget,
  ExecutionTerminal,
  LoopExecutorFactory,
  SessionMessageMetadata,
  SessionRecord,
  UsageStats,
} from "@agentick/spec";

import { SessionHarness } from "../harness.js";
import { InMemorySessionStore } from "../session-store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const OPUS = { provider: "anthropic", modelId: "claude-opus" } as const;
const HAIKU = { provider: "anthropic", modelId: "claude-haiku" } as const;

/**
 * `extra` carries the OPTIONAL token kinds (cache read/write, reasoning). It is
 * deliberately opt-in: a kind a provider does not report must stay ABSENT, not
 * arrive as a zero (usage-cost §2).
 */
const usage = (input: number, output: number, extra: Partial<UsageStats> = {}) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  ...extra,
});

const priced = (micros: number, rateRef: string, currency = "USD"): Cost => ({
  amountMicros: micros,
  currency,
  rateRef,
});

interface ScriptedTick {
  readonly usage: ReturnType<typeof usage>;
  readonly model?: Pick<ExecutionTarget, "provider" | "modelId">;
  readonly cost?: Cost;
}

/**
 * A `defineLoop` stub that plays `ticks` through the session's real state
 * applicator. `report` overrides what the RUN claims (the loop is the
 * authority for `SendResult`), so a test can tell the loop-sourced
 * `SendResult` apart from the session-folded turn/session records.
 */
function scriptedLoop(
  ticks: readonly ScriptedTick[],
  report: Partial<Pick<ExecutionRunResult, "byModel" | "cost">> = {},
) {
  return defineLoop({
    async runExecution(input): Promise<ExecutionTerminal> {
      let i = 0;
      for (const tick of ticks) {
        await input.stateApplicator.applyExecutorResult({
          sessionId: input.sessionId,
          executionId: input.executionId,
          tickId: `tick-${i++}`,
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" }],
            stopReason: "end",
            usage: tick.usage,
            ...(tick.cost !== undefined ? { cost: tick.cost } : {}),
            ...(tick.model !== undefined ? { model: tick.model } : {}),
          },
        });
      }
      return {
        outcome: "succeeded",
        result: {
          executionId: input.executionId,
          ticks: ticks.length,
          usage: ticks.reduce(
            (a, t) => ({
              inputTokens: a.inputTokens + t.usage.inputTokens,
              outputTokens: a.outputTokens + t.usage.outputTokens,
              totalTokens: a.totalTokens + t.usage.totalTokens,
            }),
            usage(0, 0),
          ),
          stopReason: "end",
          output: [{ type: "text", text: "ok" }],
          toolResults: [],
          ...report,
        },
      };
    },
  });
}

function Agent() {
  return React.createElement("message" as never, { role: "user" }, "hi");
}

async function mkSession(
  loopFactory: LoopExecutorFactory,
  store = new InMemorySessionStore(),
  telemetryProvider?: SpyTelemetryProvider,
  sessionIdOverride?: string,
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  // `defineLoop` yields a FACTORY — the substrate-deferred form the app uses.
  // Construct it on this session's substrate, as the app would.
  const loop = loopFactory({ scopeId: `l-${Math.random()}`, journal, bus, inbox });
  const compiler = new CompilerHarness(`c-${Math.random()}`, journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness(`e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`x-${Math.random()}`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: usage(1, 1),
      },
    },
  });
  await Promise.all([
    compiler.ready,
    tools.ready,
    elicitation.ready,
    executor.ready,
    (loop as unknown as { ready: Promise<unknown> }).ready,
  ]);

  const sessionId = sessionIdOverride ?? `s-${Math.random()}`;
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: React.createElement(Agent),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    sessionStore: store,
    ...(telemetryProvider !== undefined ? { telemetryProvider } : {}),
  });
  await session.ready;
  await session.mountReady;
  const record = (): Promise<SessionRecord | undefined> => store.get(sessionId, {});
  return { session, store, record, tools };
}

const send = async (session: SessionHarness) =>
  (await session.send({ messages: [{ role: "user", content: "go" }] })).result;

// ---------------------------------------------------------------------------
// §7 — per-model all the way up
// ---------------------------------------------------------------------------

describe("usage-cost §7 — per-model rollup on the SessionRecord", () => {
  it("a two-model session yields two byModel keys, with the flat usage as their sum", async () => {
    const { session, record } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(1_000, "opus@1") },
        { usage: usage(20, 5), model: HAIKU, cost: priced(25, "haiku@1") },
        { usage: usage(30, 5), model: OPUS, cost: priced(300, "opus@1") },
      ]),
    );
    await send(session);

    const rec = await record();
    const byModel = rec!.byModel!;
    expect(Object.keys(byModel).sort()).toEqual([
      "anthropic/claude-haiku",
      "anthropic/claude-opus",
    ]);

    // Partitioned, not smeared: two opus ticks, one haiku tick.
    expect(byModel["anthropic/claude-opus"]).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus",
      ticks: 2,
      usage: usage(130, 15),
      cost: { kind: "complete", amountMicros: 1_300, ticks: 2, rateRefs: ["opus@1"] },
    });
    expect(byModel["anthropic/claude-haiku"]).toMatchObject({
      ticks: 1,
      usage: usage(20, 5),
      cost: { kind: "complete", amountMicros: 25, ticks: 1, rateRefs: ["haiku@1"] },
    });

    // The flat total stays a real answer — and it is exactly the sum.
    expect(rec!.usage).toMatchObject(usage(150, 20));
    const summed = Object.values(byModel).reduce((a, m) => a + m.usage.inputTokens, 0);
    expect(rec!.usage.inputTokens).toBe(summed);

    // Session cost folds across models — one currency, so still `complete`.
    expect(rec!.cost).toEqual({
      kind: "complete",
      amountMicros: 1_325,
      currency: "USD",
      ticks: 3,
      rateRefs: ["opus@1", "haiku@1"],
    });

    await session.close();
  });

  it("keys an unidentified model as `unknown` rather than dropping its usage", async () => {
    const { session, record } = await mkSession(
      scriptedLoop([{ usage: usage(10, 2), cost: priced(5, "flat@1") }]),
    );
    await send(session);
    expect(Object.keys((await record())!.byModel!)).toEqual(["unknown"]);
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// §6 — the honesty rule
// ---------------------------------------------------------------------------

describe("usage-cost §6 — the honesty rule", () => {
  it("an unpriced session rolls up `partial` with unpricedTicks — never a zero `complete`", async () => {
    const { session, record } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS },
        { usage: usage(100, 10), model: OPUS },
      ]),
    );
    await send(session);

    const cost = (await record())!.cost!;
    expect(cost.kind).toBe("partial");
    expect(cost).toMatchObject({ amountMicros: 0, pricedTicks: 0, unpricedTicks: 2 });
    // The distinction that matters: "we cannot say" is structurally
    // different from "it cost nothing".
    expect(cost).not.toMatchObject({ kind: "complete" });

    await session.close();
  });

  it("mixed priced/unpriced ticks yield `partial` whose amount is the priced subset only", async () => {
    const { session, record } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(900, "opus@1") },
        { usage: usage(100, 10), model: HAIKU },
        { usage: usage(100, 10), model: OPUS, cost: priced(100, "opus@1") },
      ]),
    );
    await send(session);

    expect((await record())!.cost).toEqual({
      kind: "partial",
      amountMicros: 1_000,
      currency: "USD",
      pricedTicks: 2,
      unpricedTicks: 1,
      rateRefs: ["opus@1"],
    });

    await session.close();
  });

  it("a tick in a foreign currency is unpriced IN THE TOTAL, yet fully priced in its own bucket", async () => {
    const { session, record } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(900, "opus@1") },
        { usage: usage(100, 10), model: HAIKU, cost: priced(400, "haiku-eu@1", "EUR") },
      ]),
    );
    await send(session);
    const rec = await record();

    expect(rec!.cost).toMatchObject({
      kind: "partial",
      currency: "USD",
      amountMicros: 900,
      pricedTicks: 1,
      unpricedTicks: 1,
    });
    // Summing across currencies is the same class of lie as summing unpriced
    // ticks as zero — so the EUR tick keeps its own complete bucket.
    expect(rec!.byModel!["anthropic/claude-haiku"]!.cost).toMatchObject({
      kind: "complete",
      currency: "EUR",
      amountMicros: 400,
    });

    await session.close();
  });

  it("a session that recorded no usage carries NO cost key at all", async () => {
    const { session, record } = await mkSession(scriptedLoop([]));
    await send(session);
    const rec = await record();
    expect("cost" in rec!).toBe(false);
    expect("byModel" in rec!).toBe(false);
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// §5 — per-tick stamping on the timeline
// ---------------------------------------------------------------------------

describe("usage-cost §5 — the assistant entry carries cost + model", () => {
  it("stamps `cost` and `model` next to `usage` on SessionMessageMetadata", async () => {
    const cost = priced(1_000, "opus@2026-07-31");
    const { session } = await mkSession(
      scriptedLoop([{ usage: usage(100, 10), model: OPUS, cost }]),
    );
    await send(session);

    const entries = session.timeline.readPersisted();
    const assistant = entries.find((e) => e.kind === "message" && e.message.role === "assistant");
    const meta = (assistant as { message: { metadata?: SessionMessageMetadata } }).message
      .metadata!;
    expect(meta.usage).toMatchObject(usage(100, 10));
    expect(meta.model).toEqual(OPUS);
    expect(meta.cost).toEqual(cost);

    await session.close();
  });

  it("an unpriced tick's entry has NO cost key — absent means unpriced, not zero", async () => {
    const { session } = await mkSession(scriptedLoop([{ usage: usage(100, 10), model: OPUS }]));
    await send(session);

    const entries = session.timeline.readPersisted();
    const assistant = entries.find((e) => e.kind === "message" && e.message.role === "assistant");
    const meta = (assistant as { message: { metadata?: SessionMessageMetadata } }).message
      .metadata!;
    expect("cost" in meta).toBe(false);
    expect(meta.model).toEqual(OPUS);

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Execution + turn levels
// ---------------------------------------------------------------------------

describe("usage-cost §7 — execution and turn levels", () => {
  it("SendResult lifts the LOOP's byModel + cost (the run's own authority)", async () => {
    const runCost = {
      kind: "complete" as const,
      amountMicros: 4_242,
      currency: "USD",
      ticks: 1,
      rateRefs: ["opus@1"],
    };
    const { session } = await mkSession(
      scriptedLoop([{ usage: usage(100, 10), model: OPUS, cost: priced(1, "opus@1") }], {
        byModel: { "anthropic/claude-opus": { usage: usage(100, 10), ticks: 1 } },
        cost: runCost,
      }),
    );
    const result = await send(session);
    expect(result.cost).toEqual(runCost);
    expect(Object.keys(result.byModel!)).toEqual(["anthropic/claude-opus"]);
    await session.close();
  });

  it("a run reporting no cost leaves SendResult.cost absent, not zero", async () => {
    const { session } = await mkSession(scriptedLoop([{ usage: usage(100, 10), model: OPUS }]));
    const result = await send(session);
    expect("cost" in result).toBe(false);
    expect("byModel" in result).toBe(false);
    await session.close();
  });

  it("the turn-boundary record carries the turn's byModel + cost, folded session-side", async () => {
    const { session } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(900, "opus@1") },
        { usage: usage(20, 2), model: HAIKU },
      ]),
    );
    await send(session);

    const entries = session.timeline.readPersisted();
    const boundary = entries.find((e) => e.kind === "boundary");
    expect(boundary).toBeDefined();
    const b = (boundary as { boundary: Record<string, unknown> }).boundary;
    expect(Object.keys(b.byModel as object).sort()).toEqual([
      "anthropic/claude-haiku",
      "anthropic/claude-opus",
    ]);
    expect(b.cost).toMatchObject({ kind: "partial", amountMicros: 900, unpricedTicks: 1 });

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

describe("usage-cost — the accounting survives evict → resume", () => {
  it("a resumed session adopts the record's totals and accumulates onto them", async () => {
    // The blob is gone (checkpointing §5): `usage` / `byModel` / `cost` live on
    // the durable `SessionRecord`, and `SessionRuntime.hydrate()` adopts them
    // when a session opens on an id the registry already holds. What proves the
    // adoption happened is that the SECOND turn's cost SUMS onto the first's —
    // a session that restarted from zero would report only the second turn.
    const store = new InMemorySessionStore();
    const sessionId = `s-resume-${Math.random()}`;

    const first = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(900, "opus@1") },
        { usage: usage(20, 2), model: HAIKU, cost: priced(25, "haiku@1") },
      ]),
      store,
      undefined,
      sessionId,
    );
    await send(first.session);
    await first.session.snapshot();
    const before = (await first.record())!;
    expect(Object.keys(before.byModel!).sort()).toEqual([
      "anthropic/claude-haiku",
      "anthropic/claude-opus",
    ]);
    expect(before.cost).toMatchObject({ kind: "complete", amountMicros: 925 });
    await first.session.close();

    // ── Resume: same id, same store, a fresh harness. ──
    const second = await mkSession(
      scriptedLoop([{ usage: usage(1, 1), model: OPUS, cost: priced(75, "opus@1") }]),
      store,
      undefined,
      sessionId,
    );
    await send(second.session);
    const after = (await second.record())!;

    expect(after.usage).toMatchObject(usage(121, 13));
    expect(after.byModel!["anthropic/claude-opus"]!.usage).toMatchObject(usage(101, 11));
    expect(after.byModel!["anthropic/claude-haiku"]!.usage).toMatchObject(usage(20, 2));
    expect(after.cost).toMatchObject({ kind: "complete", amountMicros: 1000 });

    await second.session.close();
  });
});

// ---------------------------------------------------------------------------
// §8 — the wire
// ---------------------------------------------------------------------------

/**
 * The wire `StreamEvent` types are separate, explicitly-fielded types from the
 * loop's internal events — nothing rides automatically, so the projection is
 * pinned here. These use the REAL `LoopExecutorHarness`: cost is stamped at
 * tick settlement from the target's declared `rates`, which is the path a
 * priced deployment actually takes.
 */
async function mkRealLoopSession(
  rates?: ExecutionTarget["rates"],
  telemetryProvider?: SpyTelemetryProvider,
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`c-${Math.random()}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`l-${Math.random()}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`x-${Math.random()}`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: usage(1_000_000, 1_000_000),
      },
    },
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random()}`,
    agent: React.createElement(Agent),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target: { ...target, ...(rates !== undefined ? { rates } : {}) },
    ...(telemetryProvider !== undefined ? { telemetryProvider } : {}),
  });
  await session.ready;
  await session.mountReady;
  return session;
}

describe("usage-cost §8 — cost rides the wire where usage already rides", () => {
  it("a priced tick's wire `tick` event carries cost + model", async () => {
    const session = await mkRealLoopSession({
      id: "mock:mock-v1@2026-07-31",
      currency: "USD",
      perMTok: { input: 3_000_000, output: 15_000_000 },
    });
    const handle = await session.send({ messages: [{ role: "user", content: "go" }] });
    const events = [];
    for await (const ev of handle.events()) events.push(ev);

    const tick = events.find((e) => e.type === "tick");
    expect(tick).toBeDefined();
    expect((tick as { model?: unknown }).model).toMatchObject({
      provider: "mock",
      modelId: "mock-v1",
    });
    // 1M input @ $3/MTok + 1M output @ $15/MTok = 18_000_000 micros.
    expect((tick as { cost?: Cost }).cost).toEqual({
      amountMicros: 18_000_000,
      currency: "USD",
      rateRef: "mock:mock-v1@2026-07-31",
    });

    await session.close();
  });

  it("an UNPRICED tick's wire event has no `cost` key at all", async () => {
    const session = await mkRealLoopSession();
    const handle = await session.send({ messages: [{ role: "user", content: "go" }] });
    const events = [];
    for await (const ev of handle.events()) events.push(ev);

    const tick = events.find((e) => e.type === "tick")!;
    // The KEY is absent, not `undefined`-valued: a serialized `cost: null`
    // over the wire would be the claim "this cost nothing".
    expect("cost" in tick).toBe(false);

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// The metrics plane — two planes, one stamp
// ---------------------------------------------------------------------------

/**
 * The stamp happens ONCE (in the loop, at tick settlement) and is projected
 * TWICE: onto the durable truth plane asserted above, and onto `ctx.metrics`
 * for dashboards. What is pinned here is that the second projection is a
 * strict MIRROR — never a second source, and never the only writer of a
 * number. Money that lives only in metrics is money you cannot audit: a
 * metrics pipeline samples, aggregates, expires series and drops labels under
 * cardinality pressure.
 *
 * `ctx.metrics` prefixes every name with the harness's telemetry namespace,
 * hence `agentick.` on each assertion below.
 */
const COST = "agentick.session.tick.cost_micros";
const TOKENS = "agentick.session.tick.tokens";
const UNPRICED = "agentick.session.tick.unpriced";

/**
 * Every label key the tick-accounting metrics are allowed to carry. `op` is the
 * framework's own low-cardinality default label; the rest are the four bounded
 * dimensions this projection adds.
 */
const ALLOWED_LABELS = new Set(["provider", "modelId", "currency", "kind", "op", "app"]);

const named = (spy: SpyTelemetryProvider, name: string) =>
  spy.metrics.filter((m) => m.name === name);

describe("usage-cost — the metrics plane mirrors the stamp", () => {
  it("a priced tick records the cost histogram in micro-units, labelled by model + currency", async () => {
    const spy = spyTelemetryProvider();
    const { session, record } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(1_234, "opus@2026-07-31") },
      ]),
      new InMemorySessionStore(),
      spy,
    );
    await send(session);

    const costs = named(spy, COST);
    expect(costs).toHaveLength(1);
    expect(costs[0]!.kind).toBe("record");
    // Micro-units, verbatim off the stamp — not re-derived, not re-rounded.
    expect(costs[0]!.value).toBe(1_234);
    expect(costs[0]!.labels).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus",
      currency: "USD",
    });
    // Mirror, not source: the durable record still carries the same number.
    expect((await record())!.cost).toMatchObject({ kind: "complete", amountMicros: 1_234 });
    expect(named(spy, UNPRICED)).toHaveLength(0);

    await session.close();
  });

  it("fans out per tick and per model — one observation each, never a pre-aggregate", async () => {
    const spy = spyTelemetryProvider();
    const { session } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(900, "opus@1") },
        { usage: usage(20, 5), model: HAIKU, cost: priced(25, "haiku@1") },
      ]),
      new InMemorySessionStore(),
      spy,
    );
    await send(session);

    // The histogram is the raw per-tick series; summing is the backend's job.
    expect(named(spy, COST).map((m) => [m.value, m.labels.modelId])).toEqual([
      [900, "claude-opus"],
      [25, "claude-haiku"],
    ]);

    await session.close();
  });

  it("an UNPRICED tick counts as unpriced and records NO cost observation", async () => {
    const spy = spyTelemetryProvider();
    const { session } = await mkSession(
      scriptedLoop([{ usage: usage(100, 10), model: OPUS }]),
      new InMemorySessionStore(),
      spy,
    );
    await send(session);

    // Zero is a claim ("this cost nothing"); the tick cost something we cannot
    // price. A dashboard showing spend must be able to show how much of the
    // spend it could not see — otherwise the total is silently low.
    expect(named(spy, COST)).toHaveLength(0);
    const unpriced = named(spy, UNPRICED);
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0]!.kind).toBe("count");
    expect(unpriced[0]!.value).toBe(1);
    expect(unpriced[0]!.labels).toMatchObject({ provider: "anthropic", modelId: "claude-opus" });
    expect(unpriced[0]!.labels).not.toHaveProperty("currency");

    await session.close();
  });

  it("a mixed run emits both — the priced subset AND the count of what it could not see", async () => {
    const spy = spyTelemetryProvider();
    const { session } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(900, "opus@1") },
        { usage: usage(20, 5), model: HAIKU },
      ]),
      new InMemorySessionStore(),
      spy,
    );
    await send(session);

    expect(named(spy, COST).map((m) => m.value)).toEqual([900]);
    expect(named(spy, UNPRICED)).toHaveLength(1);

    await session.close();
  });

  it("records token histograms for the kinds actually reported — an absent kind emits NOTHING", async () => {
    const spy = spyTelemetryProvider();
    const { session } = await mkSession(
      scriptedLoop([
        {
          usage: usage(100, 10, { cachedInputTokens: 40, reasoningTokens: 6 }),
          model: OPUS,
          cost: priced(1, "opus@1"),
        },
      ]),
      new InMemorySessionStore(),
      spy,
    );
    await send(session);

    const byKind = new Map(named(spy, TOKENS).map((m) => [m.labels.kind, m.value]));
    expect([...byKind.entries()].sort()).toEqual([
      ["cacheRead", 40],
      ["input", 100],
      ["output", 10],
      ["reasoning", 6],
    ]);
    // `cacheWrite` was never reported. A `0` observation would claim the model
    // did no cache writes, where the truth is that the provider does not say —
    // and in a histogram that zero drags every percentile down.
    expect(byKind.has("cacheWrite")).toBe(false);
    expect(named(spy, TOKENS).every((m) => m.kind === "record")).toBe(true);

    await session.close();
  });

  it("a tick that reported no usage at all emits nothing — not even an unpriced count", async () => {
    const spy = spyTelemetryProvider();
    const { session } = await mkSession(scriptedLoop([]), new InMemorySessionStore(), spy);
    await send(session);

    // Nothing to account for is not the same as something we could not price.
    expect(named(spy, COST)).toHaveLength(0);
    expect(named(spy, UNPRICED)).toHaveLength(0);
    expect(named(spy, TOKENS)).toHaveLength(0);

    await session.close();
  });

  it("labels stay LOW-CARDINALITY — no rateRef, no session/execution/tick id", async () => {
    const spy = spyTelemetryProvider();
    const rateRef = "opus@2026-07-31";
    const { session } = await mkSession(
      scriptedLoop([
        {
          usage: usage(100, 10, { cacheCreationTokens: 7 }),
          model: OPUS,
          cost: priced(5, rateRef),
        },
        { usage: usage(1, 1), model: HAIKU },
      ]),
      new InMemorySessionStore(),
      spy,
    );
    await send(session);

    const emitted = spy.metrics.filter((m) => m.name.startsWith("agentick.session.tick."));
    expect(emitted.length).toBeGreaterThan(0);
    for (const m of emitted) {
      // The bounded dimensions, and only those (`op` is the framework's own
      // low-cardinality default label).
      expect(Object.keys(m.labels).every((k) => ALLOWED_LABELS.has(k))).toBe(true);
      // A dated rateRef mints a NEW series on every price change, forever;
      // per-tick identity is the definition of a cardinality explosion. Both
      // belong on the durable record and on spans/logs, never on a label.
      expect(Object.keys(m.labels)).not.toContain("rateRef");
      expect(Object.values(m.labels)).not.toContain(rateRef);
      expect(Object.values(m.labels)).not.toContain(session.id);
    }

    await session.close();
  });

  it("with NO meter wired nothing throws and nothing is emitted — the truth plane is unaffected", async () => {
    // The spy is built but NOT wired: the no-op path must leave it untouched
    // while the durable accounting lands exactly as it does with telemetry on.
    const spy = spyTelemetryProvider();
    const { session, record } = await mkSession(
      scriptedLoop([
        { usage: usage(100, 10), model: OPUS, cost: priced(900, "opus@1") },
        { usage: usage(20, 5), model: HAIKU },
      ]),
    );
    await send(session);

    expect(spy.metrics).toHaveLength(0);
    expect((await record())!.cost).toMatchObject({
      kind: "partial",
      amountMicros: 900,
      pricedTicks: 1,
      unpricedTicks: 1,
    });

    await session.close();
  });

  it("mirrors on the REAL loop path too — the `.fx` twin, not just the public facade", async () => {
    // The shipped loop composes the state applicator's `.fx` twin in ITS fiber
    // (ADR 77), which is a different ambient operation from the Promise facade
    // every other test here drives. The ctx mint has to work on both, so the
    // path a priced deployment actually takes gets its own assertion.
    const spy = spyTelemetryProvider();
    const session = await mkRealLoopSession(
      {
        id: "mock:mock-v1@2026-07-31",
        currency: "USD",
        perMTok: { input: 3_000_000, output: 15_000_000 },
      },
      spy,
    );
    await send(session);

    const costs = named(spy, COST);
    expect(costs).toHaveLength(1);
    // 1M input @ $3/MTok + 1M output @ $15/MTok = 18_000_000 micros — the same
    // number the wire event carries, from the same single stamp.
    expect(costs[0]!.value).toBe(18_000_000);
    expect(costs[0]!.labels).toMatchObject({
      provider: "mock",
      modelId: "mock-v1",
      currency: "USD",
    });
    expect(named(spy, TOKENS).map((m) => [m.labels.kind, m.value])).toEqual([
      ["input", 1_000_000],
      ["output", 1_000_000],
    ]);

    await session.close();
  });
});

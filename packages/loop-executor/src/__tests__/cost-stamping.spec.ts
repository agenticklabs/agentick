/**
 * Per-tick cost stamping and the run-level rollup (usage-cost.md §5–§7).
 *
 * Pins the three claims the loop is the authority for:
 *
 *   §5 STAMP — cost is computed ONCE, at tick settlement, against the
 *      RESOLVED per-tick target. Resolution order: `costResolver` (wins
 *      whenever it returns anything) > `target.rates` > nothing.
 *   §6 THE HONESTY RULE — a tick with usage and no rate card is
 *      UNPRICED. It folds as `partial` with `unpricedTicks`, NEVER as a
 *      zero contribution to a `complete` total. A confidently-low total
 *      is the failure mode this suite exists to prevent.
 *   §7 ROLLUP — `byModel` partitions usage by the model that produced
 *      it, because cost is not a function of a bag flattened across
 *      models. The flat `usage` survives alongside it.
 *
 * Fixture reuse: the substrate / stub-compiler / noop-applicator /
 * fake-tool-executor shape is the one `tick-command.spec.ts` established.
 * What is new here is a compiler that can declare a per-tick `<Model>`
 * (for the two-model run) and a recording applicator (to observe the
 * stamp forwarded to the session).
 *
 * NOTE — `StateApplicatorFx.applyExecutorResult` still types its `result`
 * as a bare `LanguageModelExecutionResult`, while the Promise-facade
 * `ApplyExecutorResultInput.result` carries `cost` / `model`. The loop
 * forwards the stamp through the fx twin, so the two faces disagree and
 * only the SPREAD form compiles. The forward is real (asserted below) —
 * but until spec widens the twin, nothing in the type system enforces it.
 * TODO(usage-cost-fx-parity): widen `StateApplicatorFx` to match.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  ApplyExecutorResultInput,
  Cost,
  CostResolver,
  DispatchResult,
  ExecutionTarget,
  ExecutionTerminal,
  CompilerProtocol,
  LanguageModelExecutionResult,
  LoopExecutionEvent,
  RateCard,
  RegisteredModel,
  RenderedTree,
  RunExecutionInput,
  StateApplicator,
  ToolCall,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";

import { LoopExecutorHarness } from "../harness.js";

// ============================================================================
// Rate cards + usage — chosen so every expected amount is exact integer
// micro-arithmetic (usage-cost.md §4.1: one deferred division, no floats).
// ============================================================================

/** $3/MTok in, $15/MTok out. */
const DECLARED_CARD: RateCard = {
  id: "mock:mock-v1@2026-07-01",
  currency: "USD",
  perMTok: { input: 3_000_000, output: 15_000_000 },
};
/** $1/MTok flat, so a resolver win is unmistakable against DECLARED_CARD. */
const RESOLVER_CARD: RateCard = {
  id: "tenant-contract@2026-07-01",
  currency: "USD",
  perMTok: { input: 1_000_000, output: 1_000_000 },
};
/** $9/MTok in, $9/MTok out — the second model in the two-model run. */
const ALT_CARD: RateCard = {
  id: "alt:alt-v1@2026-07-01",
  currency: "USD",
  perMTok: { input: 9_000_000, output: 9_000_000 },
};

const USAGE = { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 } as const;
/** 1000 × 3 + 500 × 15 = 10_500 micros ($0.0105). */
const DECLARED_MICROS = 10_500;
/** 1000 × 1 + 500 × 1 = 1_500 micros. */
const RESOLVER_MICROS = 1_500;
/** 1000 × 9 + 500 × 9 = 13_500 micros. */
const ALT_MICROS = 13_500;

function mkTarget(provider: string, modelId: string, rates?: RateCard): ExecutionTarget {
  return {
    kind: "language-model",
    provider,
    modelId,
    capabilities: { supportsTools: true, supportsStreaming: true },
    ...(rates !== undefined ? { rates } : {}),
  };
}

// ============================================================================
// Fixture (the tick-command.spec.ts shape)
// ============================================================================

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

function mkSubstrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

/**
 * Stub compiler whose i-th render declares `modelRefs[i]` as the tick's
 * `<Model>` (undefined = no declaration, so the tick falls back to the
 * run-level executor + target). This is how the two-model run gets two
 * genuinely different resolved targets without a real compiler.
 */
function mkStubCompiler(modelRefs: readonly (string | undefined)[] = []): CompilerProtocol {
  let renderIndex = 0;
  const treeFor = (): RenderedTree => {
    const ref = modelRefs[renderIndex];
    renderIndex += 1;
    return ref === undefined
      ? EMPTY_TREE
      : { ...EMPTY_TREE, declarations: { model: { modelRef: ref } } };
  };
  return {
    fx: {
      use: () => () => {},
      guard: () => () => {},
      renderTree: () => Effect.sync(() => ({ tree: treeFor(), diagnostics: [], iterations: 1 })),
    },
    mount: async () => ({ mountId: "cost-mount" }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: treeFor(), diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    unmount: async () => undefined,
  };
}

/** Applicator that records what the loop forwarded — the §5 session hand-off. */
function mkRecordingApplicator(): {
  readonly applicator: StateApplicator;
  readonly applied: ApplyExecutorResultInput[];
} {
  const applied: ApplyExecutorResultInput[] = [];
  const record = (i: ApplyExecutorResultInput) => {
    applied.push(i);
  };
  return {
    applied,
    applicator: {
      fx: {
        // Typed against `ApplyExecutorResultInput` (the Promise-facade
        // shape, which carries `cost` / `model`) rather than the fx twin's
        // narrower `result` — see the note in the header docblock.
        applyExecutorResult: (i: ApplyExecutorResultInput) => Effect.sync(() => record(i)),
        applyToolResults: () => Effect.void,
      },
      applyExecutorResult: async () => undefined,
      applyToolResults: async () => undefined,
      appendEntry: async () => undefined,
    } as unknown as StateApplicator,
  };
}

function dispatchOk(call: { name: string; toolCallId: string }): DispatchResult {
  return {
    toolCallId: call.toolCallId,
    name: call.name,
    content: [{ type: "text", text: "ok" }],
    durationMs: 1,
  };
}

function mkFakeToolExecutor(): ToolExecutorProtocol {
  return {
    fx: {
      use: () => () => {},
      guard: () => () => {},
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: (i: { name: string; toolCallId: string }) =>
        Effect.succeed(dispatchOk({ name: i.name, toolCallId: i.toolCallId })),
    },
    replaceCompilerTools: async () => undefined,
    compileForTick: async () => [],
    dispatch: async (i: { name: string; toolCallId: string }) =>
      dispatchOk({ name: i.name, toolCallId: i.toolCallId }),
    tools: { list: () => [] },
  } as unknown as ToolExecutorProtocol;
}

const toolUse = (id: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "calling" }],
  stopReason: "tool_use",
  usage: { ...USAGE },
  toolCalls: [{ id, name: "t", input: {} } as ToolCall],
});
const ended = (): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "done" }],
  stopReason: "end",
  usage: { ...USAGE },
});

interface RunSetup {
  /** Scripted results for the RUN-level (fallback) executor, one per tick. */
  readonly scripted: readonly LanguageModelExecutionResult[];
  /** Target for the run-level executor. */
  readonly target: ExecutionTarget;
  readonly costResolver?: CostResolver;
  /** Per-render `<Model>` refs; index i applies to tick i+1. */
  readonly modelRefs?: readonly (string | undefined)[];
  /** Ref → (scripted results, target) for the per-tick `<Model>` overrides. */
  readonly registry?: Readonly<
    Record<string, { results: readonly LanguageModelExecutionResult[]; target: ExecutionTarget }>
  >;
  readonly maxTicks?: number;
}

interface RunOutcome {
  readonly terminal: ExecutionTerminal;
  readonly events: LoopExecutionEvent[];
  readonly applied: ApplyExecutorResultInput[];
}

async function runCosted(setup: RunSetup): Promise<RunOutcome> {
  const sub = mkSubstrate();
  const loop = new LoopExecutorHarness("cost-loop", sub.journal, sub.bus, sub.inbox);
  const executor = new FakeLanguageModelExecutor("cost-exec", sub.journal, sub.bus, sub.inbox, {
    scripted: setup.scripted.map((result) => ({ result })),
    target: setup.target,
  });
  await Promise.all([loop.ready, executor.ready]);

  const registered = new Map<string, RegisteredModel>();
  for (const [ref, entry] of Object.entries(setup.registry ?? {})) {
    const alt = new FakeLanguageModelExecutor(`cost-exec-${ref}`, sub.journal, sub.bus, sub.inbox, {
      scripted: entry.results.map((result) => ({ result })),
      target: entry.target,
    });
    await alt.ready;
    registered.set(ref, { modelExecutor: alt, target: entry.target });
  }

  const { applicator, applied } = mkRecordingApplicator();
  const input: RunExecutionInput = {
    sessionId: "cost-s",
    executionId: "cost-e",
    mountId: "cost-mount",
    compiler: mkStubCompiler(setup.modelRefs ?? []),
    modelExecutor: executor,
    target: setup.target,
    toolExecutor: mkFakeToolExecutor(),
    stateApplicator: applicator,
    maxTicks: setup.maxTicks ?? 5,
    ...(setup.costResolver !== undefined ? { costResolver: setup.costResolver } : {}),
    resolveModel: (ref) => registered.get(ref),
  };

  const events: LoopExecutionEvent[] = [];
  const terminal = await Effect.runPromise(
    loop.fx.runExecution(input, (e) => Effect.sync(() => events.push(e))),
  );
  return { terminal, events, applied };
}

/** The per-tick stamps, in tick order, off the `tick` events. */
function tickCosts(events: readonly LoopExecutionEvent[]): (Cost | undefined)[] {
  return events.filter((e) => e.kind === "tick").map((e) => e.cost);
}

// ============================================================================
// §5 — resolution order at the stamping site
// ============================================================================

describe("cost stamping (usage-cost.md §5)", () => {
  it("the resolver BEATS the target's declared rates when it returns a value", async () => {
    const { terminal, events } = await runCosted({
      scripted: [ended()],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
      costResolver: () => RESOLVER_CARD,
    });

    // Priced by the resolver's card, not the target's — and stamped with
    // the RESOLVER's rateRef, so the record names why it charged what it did.
    expect(tickCosts(events)).toEqual([
      { amountMicros: RESOLVER_MICROS, currency: "USD", rateRef: RESOLVER_CARD.id },
    ]);
    expect(terminal.result?.cost).toMatchObject({
      kind: "complete",
      amountMicros: RESOLVER_MICROS,
      rateRefs: [RESOLVER_CARD.id],
    });
  });

  it("a resolver returning `undefined` falls THROUGH to the target's declared rates", async () => {
    const seen: string[] = [];
    const { terminal, events } = await runCosted({
      scripted: [ended()],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
      costResolver: (i) => {
        // The resolver sees the tick's full identity — the marketplace /
        // per-tenant case needs it to key a contract.
        seen.push(`${i.sessionId}|${i.executionId}|${i.target.modelId}`);
        return undefined;
      },
    });

    expect(seen).toEqual(["cost-s|cost-e|mock-v1"]);
    expect(tickCosts(events)).toEqual([
      { amountMicros: DECLARED_MICROS, currency: "USD", rateRef: DECLARED_CARD.id },
    ]);
    expect(terminal.result?.cost).toMatchObject({ kind: "complete", ticks: 1 });
  });

  it("a resolver returning a `Cost` is used VERBATIM — no re-arithmetic", async () => {
    // The marketplace arm: the number billed is not a function of tokens
    // at all (a credit system, a flat per-seat charge, a negotiated
    // markup). A loop that re-priced this would destroy the answer.
    const verbatim: Cost = { amountMicros: 777, currency: "EUR", rateRef: "credits@v3" };
    const { terminal, events } = await runCosted({
      scripted: [ended()],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
      costResolver: () => verbatim,
    });

    expect(tickCosts(events)).toEqual([verbatim]);
    expect(terminal.result?.cost).toMatchObject({
      kind: "complete",
      amountMicros: 777,
      currency: "EUR",
      rateRefs: ["credits@v3"],
    });
  });

  it("`rateRef` is stamped on EVERY priced tick and reaches the run rollup's rateRefs", async () => {
    const { terminal, events } = await runCosted({
      scripted: [toolUse("c1"), toolUse("c2"), ended()],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
    });

    const costs = tickCosts(events);
    expect(costs).toHaveLength(3);
    for (const c of costs) expect(c?.rateRef).toBe(DECLARED_CARD.id);

    const rollup = terminal.result?.cost;
    expect(rollup).toMatchObject({
      kind: "complete",
      ticks: 3,
      amountMicros: DECLARED_MICROS * 3,
      // De-duplicated: three ticks on one card name it once.
      rateRefs: [DECLARED_CARD.id],
    });
  });

  it("the stamp rides `applyExecutorResult` so the session can write it to the timeline", async () => {
    const { applied } = await runCosted({
      scripted: [ended()],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
    });

    expect(applied).toHaveLength(1);
    expect(applied[0]!.result.cost).toEqual({
      amountMicros: DECLARED_MICROS,
      currency: "USD",
      rateRef: DECLARED_CARD.id,
    });
    expect(applied[0]!.result.model).toEqual({ provider: "mock", modelId: "mock-v1" });
  });

  it("`tick-end` carries the same stamp as `tick`", async () => {
    const { events } = await runCosted({
      scripted: [ended()],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
    });

    const tickEnd = events.find((e) => e.kind === "tick-end");
    const tick = events.find((e) => e.kind === "tick");
    expect(tickEnd?.kind === "tick-end" ? tickEnd.cost : undefined).toEqual(
      tick?.kind === "tick" ? tick.cost : "MISSING",
    );
    expect(tickEnd?.kind === "tick-end" ? tickEnd.model : undefined).toEqual({
      provider: "mock",
      modelId: "mock-v1",
    });
  });
});

// ============================================================================
// §6 — the honesty rule
// ============================================================================

describe("the honesty rule (usage-cost.md §6)", () => {
  it("no resolver and no rates: the tick is UNPRICED and the run rolls up `partial`", async () => {
    const { terminal, events } = await runCosted({
      scripted: [toolUse("c1"), ended()],
      target: mkTarget("mock", "mock-v1"), // no rates
    });

    // No cost on either tick — absent, not zero.
    expect(tickCosts(events)).toEqual([undefined, undefined]);

    const rollup = terminal.result?.cost;
    expect(rollup).toEqual({
      kind: "partial",
      amountMicros: 0,
      currency: "",
      pricedTicks: 0,
      unpricedTicks: 2,
      rateRefs: [],
    });

    // THE POINT. `{ kind: "complete", amountMicros: 0 }` claims the run
    // cost nothing. It cost something; we cannot say what. Those are
    // different statements and the type forces the reader to notice.
    expect(rollup?.kind).not.toBe("complete");
    expect(rollup).not.toMatchObject({ kind: "complete", amountMicros: 0 });
  });

  it("mixed priced/unpriced: `partial` whose amount is ONLY the priced subset", async () => {
    // Tick 1 runs the priced run-level model; tick 2's `<Model>` resolves
    // to an unpriced one. The classic under-reporting trap: fold the
    // unpriced tick as zero and the total looks authoritative and is low.
    const { terminal, events } = await runCosted({
      scripted: [toolUse("c1")],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
      modelRefs: [undefined, "unpriced"],
      registry: { unpriced: { results: [ended()], target: mkTarget("free", "free-v1") } },
    });

    expect(tickCosts(events)).toEqual([
      { amountMicros: DECLARED_MICROS, currency: "USD", rateRef: DECLARED_CARD.id },
      undefined,
    ]);
    expect(terminal.result?.cost).toEqual({
      kind: "partial",
      amountMicros: DECLARED_MICROS, // the priced subset — a LOWER BOUND
      currency: "USD",
      pricedTicks: 1,
      unpricedTicks: 1,
      rateRefs: [DECLARED_CARD.id],
    });
  });

  it("a run that recorded NO usage has no cost at all — absent, not a zero rollup", async () => {
    const noUsage: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [{ type: "text", text: "done" }],
      stopReason: "end",
    };
    const { terminal } = await runCosted({
      scripted: [noUsage],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
    });

    expect(terminal.result?.cost).toBeUndefined();
    expect(terminal.result?.byModel).toBeUndefined();
    // The flat total still answers "how many tokens" with a real zero.
    expect(terminal.result?.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

// ============================================================================
// §7 — the per-model rollup
// ============================================================================

describe("per-model rollup (usage-cost.md §7)", () => {
  it("a two-model run partitions usage into TWO byModel keys; the flat usage is their sum", async () => {
    const { terminal } = await runCosted({
      // Tick 1 on the run-level model (2 ticks worth), tick 3 on the alt.
      scripted: [toolUse("c1"), toolUse("c2")],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
      modelRefs: [undefined, undefined, "alt"],
      registry: { alt: { results: [ended()], target: mkTarget("alt", "alt-v1", ALT_CARD) } },
    });

    const byModel = terminal.result?.byModel;
    expect(Object.keys(byModel ?? {}).sort()).toEqual(["alt/alt-v1", "mock/mock-v1"]);

    expect(byModel?.["mock/mock-v1"]).toMatchObject({
      provider: "mock",
      modelId: "mock-v1",
      ticks: 2,
      usage: { inputTokens: 2_000, outputTokens: 1_000, totalTokens: 3_000 },
      cost: { kind: "complete", amountMicros: DECLARED_MICROS * 2, rateRefs: [DECLARED_CARD.id] },
    });
    expect(byModel?.["alt/alt-v1"]).toMatchObject({
      provider: "alt",
      modelId: "alt-v1",
      ticks: 1,
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
      cost: { kind: "complete", amountMicros: ALT_MICROS, rateRefs: [ALT_CARD.id] },
    });

    // The flat total is still a real answer — it is exactly the sum, and
    // exactly the thing you must NOT price (two rate tiers in one bag).
    expect(terminal.result?.usage).toEqual({
      inputTokens: 3_000,
      outputTokens: 1_500,
      totalTokens: 4_500,
    });
    expect(terminal.result?.ticks).toBe(3);

    // Both cards in one currency ⇒ the run total stays `complete`, and
    // names both rate cards.
    expect(terminal.result?.cost).toMatchObject({
      kind: "complete",
      ticks: 3,
      amountMicros: DECLARED_MICROS * 2 + ALT_MICROS,
    });
    const refs = terminal.result?.cost?.rateRefs ?? [];
    expect([...refs].sort()).toEqual([ALT_CARD.id, DECLARED_CARD.id].sort());
  });

  it("each tick's `model` names the RESOLVED target, not the run-level fallback", async () => {
    const { events, applied } = await runCosted({
      scripted: [toolUse("c1")],
      target: mkTarget("mock", "mock-v1", DECLARED_CARD),
      modelRefs: [undefined, "alt"],
      registry: { alt: { results: [ended()], target: mkTarget("alt", "alt-v1", ALT_CARD) } },
    });

    const models = events
      .filter((e) => e.kind === "tick")
      .map((e) => (e.kind === "tick" ? e.model : undefined));
    expect(models).toEqual([
      { provider: "mock", modelId: "mock-v1" },
      { provider: "alt", modelId: "alt-v1" },
    ]);
    expect(applied.map((a) => a.result.model)).toEqual(models);
  });
});

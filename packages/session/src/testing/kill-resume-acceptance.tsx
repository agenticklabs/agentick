/**
 * `runKillResumeAcceptance` — the ADR 49 "open-or-rehydrate" acceptance
 * suite, parameterized over a {@link TimelineStore} backing.
 *
 * This is the end-to-end proof that the framework's resume pipe works
 * against a REAL store adapter: a real {@link SessionHarness} (compiler
 * + loop + tool-executor + elicitation), a real `send()` that drives the
 * write-behind pump + flush barrier, and a real `hydrate()` on a fresh
 * session opening the SAME durable backing. The only double is the
 * language model itself — scripted (that is the unit-under-test's
 * boundary, not a fake of the resume pipe).
 *
 * ## What it pins
 *
 *   1. **Real kill→resume cycle.** A completed turn on session1 (over
 *      store1) is visible to a freshly-constructed session2 (over store2,
 *      SAME `sessionId`, same durable backing) — hydrated into the
 *      persisted tier BEFORE first render.
 *   2. **Model-visibility (the load-bearing assertion).** The hydrated
 *      prior turn reaches the MODEL, not just the timeline: session2's
 *      next `send()` projects a `LanguageModelInput` whose USER messages
 *      carry the earlier turn's text. Captured off a spy executor's
 *      `project()` — the exact input the loop hands the streaming path.
 *   3. **Flush barrier.** `send()` does not resolve before the store
 *      holds the turn — asserted synchronously after `await result`.
 *   4. **`delete` ends the session.** After the durable log is deleted,
 *      a fresh open by the same id hydrates EMPTY.
 *
 * ## The `makeStore` contract (critical)
 *
 * `makeStore()` returns a store over a durable backing SHARED across
 * calls within one test — so a second `makeStore()` models a NEW
 * process/replica opening the same durable state. (Memory: return the
 * same instance. fs: same `dir`. pg: same table + pool.) The suite calls
 * it once per "process".
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

import React from "react";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { Timeline } from "@agentick/timeline/react";
import type { TimelineStore } from "@agentick/timeline";
import { stubStoreCtx } from "@agentick/store";
import type {
  ExecutionTarget,
  ExecutorFx,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelInput,
  ProjectInput,
  RunInput,
  SessionSnapshot,
  TimelineEntry,
  TimelineHarnessSnapshot,
} from "@agentick/spec";

import { SessionHarness } from "../harness.js";

/**
 * Extract the durable persisted log from a session snapshot. Post-Step-6
 * the timeline lives under the generic `bridges.timeline` fold (a
 * {@link TimelineHarnessSnapshot}), not a top-level `timeline` array.
 */
function persistedOf(snap: SessionSnapshot): readonly TimelineEntry[] {
  return (snap.bridges.timeline as TimelineHarnessSnapshot | undefined)?.persisted ?? [];
}

// ============================================================================
// Options
// ============================================================================

export interface KillResumeAcceptanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /**
   * Returns a store over a durable backing SHARED across calls within one
   * test. Each call models a fresh process opening the same durable
   * state. See the module doc for the per-pole contract.
   */
  readonly makeStore: () => TimelineStore | Promise<TimelineStore>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a
   * store). For backings that may be absent in the test env — e.g. a
   * Postgres pole gating on a `TIMELINE_PG_URL` probe — compute the
   * availability boolean at the call site and pass `skip: !available`.
   * Mirrors `runTimelineStoreConformance`.
   */
  readonly skip?: boolean;
}

// ============================================================================
// Fixtures
// ============================================================================

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

/** A scripted single-turn executor replying with a fixed text. */
function replyExec(text: string): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    `kr-exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );
}

/**
 * `spyReplyExec` — a Meszaros SPY over the production
 * {@link FakeLanguageModelExecutor}: it records the projected
 * `LanguageModelInput` the loop hands the model each tick, so a test can
 * assert WHAT the model saw. The streaming path calls `project()`
 * explicitly before `executeStream`; the non-streaming path calls
 * `run()` — this captures both by intercepting `project()` (and having
 * `run()` route through it).
 */
class SpyLanguageModelExecutor extends FakeLanguageModelExecutor {
  private readonly _captured: LanguageModelInput[] = [];

  /** Every projected input the model received, in order. */
  capturedInputs(): readonly LanguageModelInput[] {
    return this._captured;
  }

  /** The most recent projected input (last tick). */
  lastInput(): LanguageModelInput | undefined {
    return this._captured.at(-1);
  }

  override async project(input: ProjectInput): Promise<LanguageModelInput> {
    const projected = await super.project(input);
    this._captured.push(projected);
    return projected;
  }

  override run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
    // Non-streaming path: capture the projected input the model would see
    // before delegating to the base run (which re-projects internally).
    void this.project({
      compiled: input.compiled,
      target: input.target,
      tools: input.tools,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    });
    return super.run(input);
  }

  /**
   * ADR 77 — the loop composes the `.fx` twins, NOT the public facades, so
   * the capture must intercept there too (a facade override alone is
   * bypassed once internal calls go through `fx`). Mirrors the facade
   * overrides: `fx.project` captures the projected input; `fx.run`
   * (non-streaming path) projects-to-capture before running.
   */
  override get fx(): ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> {
    const base = super.fx;
    const capture = (projected: LanguageModelInput): void => {
      this._captured.push(projected);
    };
    return {
      ...base,
      project: (input) =>
        base.project(input).pipe(Effect.tap((p) => Effect.sync(() => capture(p)))),
      run: (input) =>
        base
          .project({
            compiled: input.compiled,
            target: input.target,
            tools: input.tools,
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
          })
          .pipe(
            Effect.tap((p) => Effect.sync(() => capture(p))),
            Effect.zipRight(base.run(input)),
          ),
    };
  }
}

function spyReplyExec(text: string): SpyLanguageModelExecutor {
  return new SpyLanguageModelExecutor(
    `kr-spy-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );
}

/** The resume agent renders the persisted conversation into model context. */
function ResumeAgent(): React.JSX.Element {
  return <Timeline />;
}

/** All USER-message text the model saw in a projected input. */
function userText(input: LanguageModelInput | undefined): string {
  if (!input) return "";
  return input.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

interface Rig {
  readonly session: SessionHarness;
  close(): Promise<void>;
}

/**
 * Build a real SessionHarness over the injected store. Mirrors the
 * construction in `timeline-durability.spec.ts` — a full harness stack —
 * parameterized to accept the store + a specific executor + the resume
 * agent (which renders `<Timeline/>` so hydrated history reaches the
 * model).
 */
async function mkSession(opts: {
  sessionId: string;
  store: TimelineStore;
  executor: FakeLanguageModelExecutor;
}): Promise<Rig> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`kr-r-${Math.random()}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`kr-l-${Math.random()}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`kr-e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`kr-t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  await Promise.all([
    compiler.ready,
    loop.ready,
    tools.ready,
    elicitation.ready,
    opts.executor.ready,
  ]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: opts.sessionId,
    agent: <ResumeAgent />,
    compiler,
    loop,
    modelExecutor: opts.executor,
    toolExecutor: tools,
    target,
    timeline: { store: opts.store, writePolicy: "behind" },
  });
  await session.ready;
  await session.mountReady;

  return {
    session,
    close: async () => {
      await session.close();
      await tools.close();
    },
  };
}

// ============================================================================
// Suite
// ============================================================================

export function runKillResumeAcceptance(opts: KillResumeAcceptanceOptions): void {
  const suite = opts.skip ? describe.skip : describe;

  suite(`kill-and-resume acceptance — ${opts.label} (ADR 49)`, () => {
    it("real kill→resume: a completed turn survives a fresh open on the same backing", async () => {
      const sessionId = `kr-resume-${Math.random().toString(36).slice(2)}`;

      // ── Process 1: send a turn, then drop the session. ──
      const store1 = await opts.makeStore();
      const p1 = await mkSession({ sessionId, store: store1, executor: replyExec("noted") });
      const h1 = await p1.session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "remember: PLUM" }] }],
      });
      await h1.result;
      await p1.close(); // kill — drop every reference to process 1.

      // ── Process 2: fresh harness, SAME id, store over the same backing. ──
      const store2 = await opts.makeStore();
      const p2 = await mkSession({ sessionId, store: store2, executor: replyExec("answer") });

      // Hydration ran before mountReady (mkSession awaits it): the
      // persisted tier already holds the prior turns — the user input
      // + the assistant reply (plus the turn-boundary record).
      const hydrated = persistedOf(await p2.session.snapshot());
      const messages = hydrated.filter((e) => e.kind === "message");
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const text = JSON.stringify(hydrated);
      expect(text).toContain("remember: PLUM");
      expect(text).toContain("noted");

      await p2.close();
    });

    it("model-visibility: the hydrated prior turn reaches the MODEL, not just the timeline", async () => {
      const sessionId = `kr-model-${Math.random().toString(36).slice(2)}`;

      const store1 = await opts.makeStore();
      const p1 = await mkSession({ sessionId, store: store1, executor: replyExec("noted") });
      await (
        await p1.session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "remember: PLUM" }] }],
        })
      ).result;
      await p1.close();

      // Fresh process with a SPY executor — capture what the model sees.
      const store2 = await opts.makeStore();
      const spy = spyReplyExec("answer");
      const p2 = await mkSession({ sessionId, store: store2, executor: spy });

      await (
        await p2.session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "what did I say?" }] }],
        })
      ).result;

      // THE load-bearing assertion: the first render of the resumed
      // session projected the hydrated turn into a USER message the model
      // received — if hydration hadn't landed before first render, "PLUM"
      // would be absent from the tick's LanguageModelInput.
      expect(userText(spy.lastInput())).toContain("PLUM");

      await p2.close();
    });

    it("flush barrier: send() does not resolve before the store holds the turn", async () => {
      const sessionId = `kr-flush-${Math.random().toString(36).slice(2)}`;
      const store = await opts.makeStore();
      const rig = await mkSession({ sessionId, store, executor: replyExec("noted") });

      const handle = await rig.session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "barrier check" }] }],
      });
      await handle.result;

      // Synchronously after resolution — no settle window, no adopter
      // flush() — the durable log already holds the user + assistant
      // entries. This is the barrier: resolution implies durability.
      const persisted = await store.read(`${sessionId}:timeline`, stubStoreCtx());
      expect(persisted.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(persisted)).toContain("barrier check");

      await rig.close();
    });

    it("delete ends the session: a fresh open after delete hydrates EMPTY", async () => {
      const sessionId = `kr-delete-${Math.random().toString(36).slice(2)}`;

      const store1 = await opts.makeStore();
      const p1 = await mkSession({ sessionId, store: store1, executor: replyExec("noted") });
      await (
        await p1.session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "ephemeral" }] }],
        })
      ).result;
      await p1.close();

      // End the session's durable life — the store key convention is
      // `${sessionId}:timeline`.
      const store2 = await opts.makeStore();
      const deleted = await store2.delete(`${sessionId}:timeline`, stubStoreCtx());
      expect(deleted).toBe(true);

      // A fresh open by the same id starts empty — no ghost history.
      const store3 = await opts.makeStore();
      const p3 = await mkSession({ sessionId, store: store3, executor: replyExec("answer") });
      expect(persistedOf(await p3.session.snapshot())).toEqual([]);

      await p3.close();
    });

    it("snapshot→restore round-trip: a snapshot restores into a fresh session (Step 6 generic fold)", async () => {
      const sessionId = `kr-roundtrip-${Math.random().toString(36).slice(2)}`;

      // ── Source session: run a turn, capture a snapshot. ──
      const storeA = await opts.makeStore();
      const src = await mkSession({ sessionId, store: storeA, executor: replyExec("noted") });
      await (
        await src.session.send({
          messages: [{ role: "user", content: [{ type: "text", text: "remember: PLUM" }] }],
        })
      ).result;
      const snap = await src.session.snapshot();
      await src.close();

      // The snapshot survives the spec firewall (JSON round-trip) — the
      // generic bridge fold is wire-safe.
      const wire: SessionSnapshot = JSON.parse(JSON.stringify(snap));
      expect(wire).toEqual(snap);
      expect(persistedOf(wire).length).toBeGreaterThanOrEqual(2);

      // ── Destination session: DISTINCT id + a store-less timeline (no
      // open-or-rehydrate), so the ONLY path prior state can arrive is
      // `restore()` — this exercises the snapshot/restore pipe itself,
      // independent of the durable-store hydration path. ──
      const destId = `${sessionId}-dest`;
      const dest = await mkSession({
        sessionId: destId,
        // storeless: distinct backing so nothing hydrates automatically.
        store: await opts.makeStore(),
        executor: replyExec("answer"),
      });

      // Rewrite the snapshot's id to the destination (restore is an
      // in-place state transplant; identity stays the live session's).
      await dest.session.restore({ snapshot: { ...wire, id: destId } });

      // The transplanted persisted log is now readable off the destination's
      // own snapshot — proving the generic importSnapshot fan-out landed the
      // timeline bridge.
      const restored = persistedOf(await dest.session.snapshot());
      expect(JSON.stringify(restored)).toContain("remember: PLUM");
      expect(JSON.stringify(restored)).toContain("noted");

      await dest.close();
    });
  });
}

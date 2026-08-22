/**
 * Conformance suite for `SessionHarnessProtocol` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/08-session-harness.md`.
 * Factories receive the *bound* sub-harnesses they should drive — the
 * suite supplies stubs for compiler / loop executor / executor / tool
 * executor when the impl-under-test doesn't need real ones, and the
 * factory wires its own session against them.
 *
 * Run from any vitest test file:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runSessionConformance } from "@agentick/spec-conformance";
 * import { SessionHarness } from "@agentick/session";
 *
 * describe("SessionHarness — conformance", () =>
 *   runSessionConformance(async ({ harnessId, deps }) => {
 *     const session = new SessionHarness(deps.journal, deps.bus, deps.inbox, {
 *       sessionId: harnessId,
 *       agent: deps.agent,
 *       compiler: deps.compiler,
 *       loop: deps.loop,
 *       modelExecutor: deps.modelExecutor,
 *       toolExecutor: deps.toolExecutor,
 *       target: deps.target,
 *     });
 *     await session.ready;
 *     await session.mountReady;
 *     return session;
 *   }),
 * );
 * ```
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type {
  CheckpointCapable,
  ContentBlock,
  EventBus,
  ExecutionTarget,
  ExecutionTerminal,
  ExecutorProtocol,
  ExecutorTerminal,
  HydrateCtx,
  LanguageModelExecutionResult,
  LoopExecutorProtocol,
  MessageInbox,
  OperationJournal,
  PersistCtx,
  CompilerProtocol,
  RenderedTree,
  SendResult,
  SessionHarnessProtocol,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { SPEC_VERSION, SessionClosedError } from "@agentick/spec";

import { stubHarnessFx } from "./harness.js";

// ============================================================================
// Factory contract
// ============================================================================

/**
 * Dependencies supplied to the factory. The suite constructs default
 * stubs for everything; the factory uses them (or substitutes its own)
 * when wiring the session-under-test.
 */
export interface SessionConformanceFactoryDeps {
  readonly journal: OperationJournal;
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly compiler: CompilerProtocol;
  readonly loop: LoopExecutorProtocol;
  readonly modelExecutor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  readonly toolExecutor: ToolExecutorProtocol;
  readonly target: ExecutionTarget;
  /** Opaque agent root passed to `mount({ element })`. */
  readonly agent: unknown;
  /**
   * A {@link CheckpointCapable} bridge the factory MUST install on the
   * session-under-test's bridge bag. The checkpoint section observes the fan-out
   * through it rather than through a harness namespace: this suite is generic
   * infra and names none (ADR 27). Supplied by {@link checkpointProbe}.
   */
  readonly checkpointBridge?: CheckpointCapable;
}

/**
 * The {@link SessionConformanceFactoryDeps.checkpointBridge} implementation the
 * suite injects — a counting {@link CheckpointCapable} double. Nothing about it
 * is namespace-specific, which is the point: any conformant session fans
 * `persist` / `hydrate` out over whatever is on its bridge bag.
 */
export interface CheckpointProbe extends CheckpointCapable {
  readonly persisted: number;
  readonly hydrated: number;
  readonly lastCtx: PersistCtx | HydrateCtx | undefined;
  persistError: Error | undefined;
}

export function checkpointProbe(): CheckpointProbe {
  return {
    persisted: 0,
    hydrated: 0,
    lastCtx: undefined,
    persistError: undefined,
    async persist(ctx: PersistCtx): Promise<void> {
      if (this.persistError) throw this.persistError;
      (this as { persisted: number }).persisted += 1;
      (this as { lastCtx: PersistCtx | undefined }).lastCtx = ctx;
    },
    async hydrate(ctx: HydrateCtx): Promise<void> {
      (this as { hydrated: number }).hydrated += 1;
      (this as { lastCtx: HydrateCtx | undefined }).lastCtx = ctx;
    },
  } as CheckpointProbe;
}

export interface SessionConformanceFactoryInput {
  readonly harnessId: string;
  readonly deps: SessionConformanceFactoryDeps;
}

export type SessionConformanceFactory = (
  input: SessionConformanceFactoryInput,
) => Promise<SessionHarnessProtocol>;

// ============================================================================
// Stubs — minimal sub-harnesses for the suite
// ============================================================================

function mkTarget(): ExecutionTarget {
  return { kind: "language-model", provider: "stub", modelId: "stub-v1" };
}

function mkTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        {
          kind: "message",
          id: "m_user",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    },
  };
}

function stubCompiler(): CompilerProtocol {
  return {
    fx: {
      ...stubHarnessFx(),
      renderTree: () => Effect.succeed({ tree: mkTree(), diagnostics: [], iterations: 1 }),
    },
    mount: async () => ({ mountId: "stub-mount" }),
    rerender: async () => undefined,
    renderTree: async () => ({
      tree: mkTree(),
      diagnostics: [],
      iterations: 1,
    }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    unmount: async () => undefined,
  };
}

/**
 * Loop executor stub that drives a single end-of-conversation tick.
 * Calls the supplied `stateApplicator` to mimic the real loop's writes.
 */
function stubLoop(text: string): LoopExecutorProtocol {
  const run = async (
    input: Parameters<LoopExecutorProtocol["runExecution"]>[0],
  ): Promise<ExecutionTerminal> => {
    const tickId = "tick-1";
    const output: readonly ContentBlock[] = [{ type: "text", text }];
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    // Apply via state applicator — exercises the session's
    // applyExecutorResult path. The loop's StateApplicator takes the
    // full LanguageModelExecutionResult shape; the session narrows it
    // internally.
    await input.stateApplicator.applyExecutorResult({
      sessionId: input.sessionId,
      executionId: input.executionId,
      tickId,
      result: {
        specVersion: "2026-05-08",
        output,
        stopReason: "end",
        usage,
      },
    });
    return {
      outcome: "succeeded",
      result: {
        executionId: input.executionId,
        output,
        toolResults: [],
        stopReason: "end",
        usage,
        ticks: 1,
      },
    };
  };
  return {
    fx: { ...stubHarnessFx(), runExecution: (input, _sink) => Effect.promise(() => run(input)) },
    runExecution: run,
    abort: async () => undefined,
  };
}

function stubExecutor(): ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult> {
  const result: LanguageModelExecutionResult = {
    specVersion: "2026-05-08",
    output: [{ type: "text", text: "stub" }],
    stopReason: "end",
  };
  const runFx = (): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>> =>
    Effect.succeed({ outcome: "succeeded", result });
  return {
    fx: {
      ...stubHarnessFx(),
      run: runFx,
      project: () => Effect.succeed({ messages: [] }),
      normalize: () => Effect.succeed(result),
      executeStream: () => Effect.succeed({} as unknown),
    },
    ready: Promise.resolve(),
    project: async () => ({ messages: [] }),
    execute: async () => ({}),
    normalize: async () => result,
    run: () => Effect.runPromise(runFx()),
    abort: async () => undefined,
  };
}

function stubToolExecutor(): ToolExecutorProtocol {
  const dispatchFx = (input: { toolCallId: string; name: string }) =>
    Effect.succeed({
      toolCallId: input.toolCallId,
      name: input.name,
      succeeded: true,
      content: [{ type: "text" as const, text: "stub" }],
      executedBy: "agentick",
      durationMs: 0,
    });
  return {
    fx: {
      ...stubHarnessFx(),
      dispatch: (input) => dispatchFx(input),
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
    },
    register: async () => undefined,
    unregister: async () => undefined,
    respondToToolCall: async () => undefined,
    list: async () => [],
    tools: {
      list: () => [],
      get: () => undefined,
      has: () => false,
      dispatch: (async () => []) as unknown as import("@agentick/spec").ToolsHandle["dispatch"],
      subscribe: () => () => {},
      subscribeAll: () => () => {},
    },
    dispatch: (input) => Effect.runPromise(dispatchFx(input)),
    abort: async () => undefined,
    replaceCompilerTools: async () => undefined,
    removeBoundTools: async () => 0,
    compileForTick: async () => [],
  };
}

interface StubSubstrate {
  readonly journal: OperationJournal;
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
}

/**
 * The conformance suite ships substrate stubs that test impls SHOULD
 * accept but can also substitute. Real `@agentick/runtime` substrate
 * is the canonical choice when running the suite end-to-end.
 */
function emptySubstrate(): StubSubstrate {
  // The suite intentionally cannot construct a real substrate (would
  // create a circular dep into @agentick/runtime). Callers pass their
  // own through `deps`. These stubs satisfy the protocol interfaces
  // enough to compile but should not be invoked at runtime by a
  // conformant impl.
  const journal: OperationJournal = {
    append: () => {
      throw new Error("conformance stub: journal.append should not be invoked");
    },
    appendBatch: () => {
      throw new Error("conformance stub: journal.appendBatch should not be invoked");
    },
    read: () => {
      throw new Error("conformance stub: journal.read should not be invoked");
    },
    tail: () => {
      throw new Error("conformance stub: journal.tail should not be invoked");
    },
    lookupTerminal: () => {
      throw new Error("conformance stub: journal.lookupTerminal should not be invoked");
    },
    findOrphaned: () => {
      throw new Error("conformance stub: journal.findOrphaned should not be invoked");
    },
  } as unknown as OperationJournal;
  const bus: EventBus = {} as unknown as EventBus;
  const inbox: MessageInbox = {} as unknown as MessageInbox;
  return { journal, bus, inbox };
}

// ============================================================================
// Suite
// ============================================================================

/**
 * Build a default `SessionConformanceFactoryDeps` from caller-supplied
 * substrate. Most factories pass `@agentick/runtime` locals here and
 * accept the rest of the stubs unchanged.
 */
export function defaultSessionConformanceDeps(
  substrate?: StubSubstrate,
  overrides: Partial<SessionConformanceFactoryDeps> = {},
): SessionConformanceFactoryDeps {
  const base = substrate ?? emptySubstrate();
  return {
    journal: base.journal,
    bus: base.bus,
    inbox: base.inbox,
    compiler: overrides.compiler ?? stubCompiler(),
    loop: overrides.loop ?? stubLoop("hi"),
    modelExecutor: overrides.modelExecutor ?? stubExecutor(),
    toolExecutor: overrides.toolExecutor ?? stubToolExecutor(),
    target: overrides.target ?? mkTarget(),
    agent: overrides.agent ?? null,
    ...(overrides.checkpointBridge !== undefined
      ? { checkpointBridge: overrides.checkpointBridge }
      : {}),
  };
}

export function runSessionConformance(factory: SessionConformanceFactory): void {
  describe("SessionHarnessProtocol — send happy path", () => {
    it("returns a handle whose .result resolves to a SendResult", async () => {
      const session = await factory({
        harnessId: "session-conf-1",
        deps: defaultSessionConformanceDeps(),
      });
      const handle = await session.send({
        messages: [{ role: "user", content: "hi" }],
      });
      expect(handle.executionId).toMatch(/^exec:/);
      const result: SendResult = await handle.result;
      expect(typeof result.response).toBe("string");
      expect(Array.isArray(result.output)).toBe(true);
      expect(result.executionId).toBe(handle.executionId);
      expect(result.ticks).toBeGreaterThanOrEqual(1);
      await session.close();
    });

    it("populates response from assistant text blocks", async () => {
      const session = await factory({
        harnessId: "session-conf-2",
        deps: defaultSessionConformanceDeps(undefined, {
          loop: stubLoop("the answer is 42"),
        }),
      });
      const handle = await session.send({
        messages: [{ role: "user", content: "?" }],
      });
      const result = await handle.result;
      expect(result.response).toContain("42");
      await session.close();
    });
  });

  describe("SessionHarnessProtocol — checkpoint", () => {
    it("snapshot() is the flush barrier: it resolves with no payload", async () => {
      const session = await factory({
        harnessId: "session-conf-snap-1",
        deps: defaultSessionConformanceDeps(),
      });
      // The checkpoint hands nothing back — each CheckpointCapable bridge
      // flushed to its OWN store, and no value crosses the seam
      // (checkpointing §3.2).
      await expect(session.snapshot()).resolves.toBeUndefined();
      await session.close();
    });

    it("genesis fans hydrate out over every CheckpointCapable bridge", async () => {
      // Build-then-hydrate IS resume (checkpointing §4), so a session that has
      // only just opened has already run the fan-out once. This also proves the
      // factory installed the probe, which the two tests below depend on.
      const probe = checkpointProbe();
      const session = await factory({
        harnessId: "session-conf-genesis-1",
        deps: defaultSessionConformanceDeps(undefined, { checkpointBridge: probe }),
      });
      expect(probe.hydrated).toBe(1);
      expect(probe.persisted).toBe(0);
      await session.close();
    });

    it("snapshot() fans persist out, carrying the session scope", async () => {
      const probe = checkpointProbe();
      const session = await factory({
        harnessId: "session-conf-snap-2",
        deps: defaultSessionConformanceDeps(undefined, { checkpointBridge: probe }),
      });
      await session.snapshot();
      expect(probe.persisted).toBe(1);
      expect(probe.lastCtx?.sessionId).toBe("session-conf-snap-2");
      await session.close();
    });

    it("restore() fans hydrate out again, once per call", async () => {
      const probe = checkpointProbe();
      const session = await factory({
        harnessId: "session-conf-restore-1",
        deps: defaultSessionConformanceDeps(undefined, { checkpointBridge: probe }),
      });
      await session.restore();
      await session.restore();
      // One at genesis, one per restore — the hydrate fan-out is the ONLY thing
      // that can move this counter.
      expect(probe.hydrated).toBe(3);
      await session.close();
    });

    it("a rejected persist propagates out of snapshot()", async () => {
      const probe = checkpointProbe();
      const session = await factory({
        harnessId: "session-conf-snap-fail",
        deps: defaultSessionConformanceDeps(undefined, { checkpointBridge: probe }),
      });
      probe.persistError = new Error("flush failed");
      await expect(session.snapshot()).rejects.toThrow(/flush failed/);
      await session.close();
    });
  });

  // What the applicators land ON the timeline is a session+timeline integration
  // claim and lives in `@agentick/session` — this suite names no namespace
  // (ADR 27). What stays here is the applicator's own return contract.
  describe("SessionHarnessProtocol — state applicator", () => {
    it("appendEntry reports one appended id per entry", async () => {
      const session = await factory({
        harnessId: "session-conf-apply-1",
        deps: defaultSessionConformanceDeps(),
      });
      const content: ContentBlock[] = [{ type: "text", text: "marker" }];
      const res = await session.appendEntry({
        sessionId: "session-conf-apply-1",
        entry: { role: "user", content },
      });
      expect(res.appendedEntryIds.length).toBe(1);
      await session.close();
    });

    it("applyExecutorResult reports one appended id", async () => {
      const session = await factory({
        harnessId: "session-conf-apply-2",
        deps: defaultSessionConformanceDeps(),
      });
      const res = await session.applyExecutorResult({
        sessionId: "session-conf-apply-2",
        executionId: "exec-x",
        tickId: "tick-x",
        result: {
          specVersion: SPEC_VERSION,
          output: [{ type: "text", text: "from-applicator" }],
          stopReason: "end",
        },
      });
      expect(res.appendedEntryIds.length).toBe(1);
      await session.close();
    });

    it("applyToolResults reports one appended id per result", async () => {
      const session = await factory({
        harnessId: "session-conf-apply-3",
        deps: defaultSessionConformanceDeps(),
      });
      const res = await session.applyToolResults({
        sessionId: "session-conf-apply-3",
        executionId: "exec-y",
        tickId: "tick-y",
        results: [
          {
            toolCallId: "tc-1",
            toolName: "calc",
            succeeded: true,
            content: [{ type: "text", text: "42" }],
            durationMs: 1,
          },
          {
            toolCallId: "tc-2",
            toolName: "calc",
            succeeded: true,
            content: [{ type: "text", text: "84" }],
            durationMs: 1,
          },
        ],
      });
      expect(res.appendedEntryIds.length).toBe(2);
      await session.close();
    });
  });

  describe("SessionHarnessProtocol — close", () => {
    it("close is idempotent", async () => {
      const session = await factory({
        harnessId: "session-conf-close-1",
        deps: defaultSessionConformanceDeps(),
      });
      await session.close();
      await expect(session.close()).resolves.toBeUndefined();
    });

    it("send after close rejects with SessionClosedError", async () => {
      const session = await factory({
        harnessId: "session-conf-close-2",
        deps: defaultSessionConformanceDeps(),
      });
      await session.close();
      await expect(
        session.send({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toBeInstanceOf(SessionClosedError);
    });
  });

  describe("SessionHarnessProtocol — notifyLifecycle", () => {
    it("returns a TickEndForwardDecision or undefined (loop default)", async () => {
      const session = await factory({
        harnessId: "session-conf-notify-1",
        deps: defaultSessionConformanceDeps(),
      });
      const decision = await session.notifyLifecycle({
        sessionId: "session-conf-notify-1",
        executionId: "exec-n",
        tickId: "tick-n",
        outcome: "succeeded",
      });
      // Either undefined (loop default) or a tagged decision.
      if (decision !== undefined) {
        expect(["continue", "stop"]).toContain(decision.kind);
      }
      await session.close();
    });
  });

  describe("SessionHarnessProtocol — execution handle shape", () => {
    it("handle exposes events() and .result", async () => {
      const session = await factory({
        harnessId: "session-conf-handle-1",
        deps: defaultSessionConformanceDeps(),
      });
      const handle = await session.send({
        messages: [{ role: "user", content: "x" }],
      });
      // `events()` returns the AsyncIterable event stream.
      expect(typeof handle.events).toBe("function");
      expect(typeof handle.events()[Symbol.asyncIterator]).toBe("function");
      // And a result Promise.
      expect(typeof handle.result.then).toBe("function");
      const result = await handle.result;
      expect(result.executionId).toBe(handle.executionId);
      await session.close();
    });
  });
}

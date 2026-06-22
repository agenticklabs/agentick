/**
 * Conformance suite for `SessionHarnessProtocol` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/08-session-harness.md`.
 * Factories receive the *bound* sub-harnesses they should drive — the
 * suite supplies stubs for reconciler / loop executor / executor / tool
 * executor when the impl-under-test doesn't need real ones, and the
 * factory wires its own session against them.
 *
 * Run from any vitest test file:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runSessionConformance } from "@agentick/spec-conformance-next";
 * import { SessionHarness } from "@agentick/session-next";
 *
 * describe("SessionHarness — conformance", () =>
 *   runSessionConformance(async ({ harnessId, deps }) => {
 *     const session = new SessionHarness(deps.journal, deps.bus, deps.inbox, {
 *       sessionId: harnessId,
 *       agent: deps.agent,
 *       reconciler: deps.reconciler,
 *       loop: deps.loop,
 *       executor: deps.executor,
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

import type {
  ContentBlock,
  EventBus,
  ExecutionTarget,
  ExecutorProtocol,
  LanguageModelExecutionResult,
  LoopExecutorProtocol,
  MessageInbox,
  OperationJournal,
  ReconcilerProtocol,
  RenderedTree,
  SendResult,
  SessionHarnessProtocol,
  ToolExecutorProtocol,
} from "@agentick/spec-next";

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
  readonly reconciler: ReconcilerProtocol;
  readonly loop: LoopExecutorProtocol;
  readonly executor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  readonly toolExecutor: ToolExecutorProtocol;
  readonly target: ExecutionTarget;
  /** Opaque agent root passed to `mount({ element })`. */
  readonly agent: unknown;
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

function stubReconciler(): ReconcilerProtocol {
  return {
    mount: async () => ({ mountId: "stub-mount", restoredFromSnapshot: false }),
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
    notifyLifecycle: async () => undefined,
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: "2026-05-08",
      mountId: "stub-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  };
}

/**
 * Loop executor stub that drives a single end-of-conversation tick.
 * Calls the supplied `stateApplicator` to mimic the real loop's writes.
 */
function stubLoop(text: string): LoopExecutorProtocol {
  return {
    runExecution: async (input) => {
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
    },
    abort: async () => undefined,
  };
}

function stubExecutor(): ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult> {
  const result: LanguageModelExecutionResult = {
    specVersion: "2026-05-08",
    output: [{ type: "text", text: "stub" }],
    stopReason: "end",
  };
  return {
    ready: Promise.resolve(),
    project: async () => ({ messages: [] }),
    execute: async () => ({}),
    normalize: async () => result,
    run: async () => ({ outcome: "succeeded", result }),
    abort: async () => undefined,
  };
}

function stubToolExecutor(): ToolExecutorProtocol {
  return {
    register: async () => undefined,
    unregister: async () => undefined,
    list: async () => [],
    dispatch: async (input) => ({
      toolCallId: input.toolCallId,
      name: input.name,
      succeeded: true,
      content: [{ type: "text", text: "stub" }],
      executedBy: "agentick",
      durationMs: 0,
    }),
    abort: async () => undefined,
    replaceReconcilerTools: async () => undefined,
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
 * accept but can also substitute. Real `@agentick/runtime-next` substrate
 * is the canonical choice when running the suite end-to-end.
 */
function emptySubstrate(): StubSubstrate {
  // The suite intentionally cannot construct a real substrate (would
  // create a circular dep into @agentick/runtime-next). Callers pass their
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
 * substrate. Most factories pass `@agentick/runtime-next` locals here and
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
    reconciler: overrides.reconciler ?? stubReconciler(),
    loop: overrides.loop ?? stubLoop("hi"),
    executor: overrides.executor ?? stubExecutor(),
    toolExecutor: overrides.toolExecutor ?? stubToolExecutor(),
    target: overrides.target ?? mkTarget(),
    agent: overrides.agent ?? null,
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

  describe("SessionHarnessProtocol — timeline", () => {
    it("appends caller-supplied messages before the execution runs", async () => {
      const session = await factory({
        harnessId: "session-conf-tl-1",
        deps: defaultSessionConformanceDeps(),
      });
      await session.send({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      });
      const tl = session.snapshot().timeline;
      const userMessages = tl.filter((e) => e.kind === "message" && e.message.role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(2);
      await session.close();
    });

    it("appends an assistant message after the loop's applyExecutorResult", async () => {
      const session = await factory({
        harnessId: "session-conf-tl-2",
        deps: defaultSessionConformanceDeps(undefined, {
          loop: stubLoop("ok"),
        }),
      });
      const handle = await session.send({
        messages: [{ role: "user", content: "x" }],
      });
      await handle.result;
      const tl = session.snapshot().timeline;
      const assistant = tl.find((e) => e.kind === "message" && e.message.role === "assistant");
      expect(assistant).toBeDefined();
      await session.close();
    });
  });

  describe("SessionHarnessProtocol — snapshot", () => {
    it("returns a snapshot with id + currentTick + timeline", async () => {
      const session = await factory({
        harnessId: "session-conf-snap-1",
        deps: defaultSessionConformanceDeps(),
      });
      const snap = session.snapshot();
      expect(snap.id).toBeTruthy();
      expect(typeof snap.currentTick).toBe("number");
      expect(Array.isArray(snap.timeline)).toBe(true);
      expect(snap.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await session.close();
    });

    it("snapshot reflects post-send state", async () => {
      const session = await factory({
        harnessId: "session-conf-snap-2",
        deps: defaultSessionConformanceDeps(),
      });
      const before = session.snapshot();
      await (
        await session.send({ messages: [{ role: "user", content: "x" }] })
      ).result;
      const after = session.snapshot();
      expect(after.timeline.length).toBeGreaterThan(before.timeline.length);
      await session.close();
    });
  });

  describe("SessionHarnessProtocol — state applicator", () => {
    it("appendEntry returns appended ids and timeline reflects the entry", async () => {
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
      const tl = session.snapshot().timeline;
      const marker = tl.find(
        (e) =>
          e.kind === "message" &&
          e.message.content.some((b) => b.type === "text" && b.text === "marker"),
      );
      expect(marker).toBeDefined();
      await session.close();
    });

    it("applyExecutorResult appends an assistant message with the output", async () => {
      const session = await factory({
        harnessId: "session-conf-apply-2",
        deps: defaultSessionConformanceDeps(),
      });
      const res = await session.applyExecutorResult({
        sessionId: "session-conf-apply-2",
        executionId: "exec-x",
        tickId: "tick-x",
        result: {
          output: [{ type: "text", text: "from-applicator" }],
          stopReason: "end",
        },
      });
      expect(res.appendedEntryIds.length).toBe(1);
      const tl = session.snapshot().timeline;
      const found = tl.find(
        (e) =>
          e.kind === "message" &&
          e.message.role === "assistant" &&
          e.message.content.some((b) => b.type === "text" && b.text === "from-applicator"),
      );
      expect(found).toBeDefined();
      await session.close();
    });

    it("applyToolResults appends one tool message per result", async () => {
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
      const tl = session.snapshot().timeline;
      const toolMessages = tl.filter((e) => e.kind === "message" && e.message.role === "tool");
      expect(toolMessages.length).toBeGreaterThanOrEqual(2);
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
      ).rejects.toMatchObject({ _tag: "SessionClosedError" });
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

  describe("SessionHarnessProtocol — execution handle dual-shape", () => {
    it("handle is both AsyncIterable and exposes .result", async () => {
      const session = await factory({
        harnessId: "session-conf-handle-1",
        deps: defaultSessionConformanceDeps(),
      });
      const handle = await session.send({
        messages: [{ role: "user", content: "x" }],
      });
      // Should have the iteration symbol.
      expect(
        typeof (handle as unknown as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator],
      ).toBe("function");
      // And a result Promise.
      expect(typeof handle.result.then).toBe("function");
      const result = await handle.result;
      expect(result.executionId).toBe(handle.executionId);
      await session.close();
    });
  });
}

/**
 * `StateApplicator.fx` — the dual-typed edge on the state applicator (ADR
 * 77 Stage 3). The session harness's `applyExecutorResult` /
 * `applyToolResults` are `runHarnessProtocol`-backed (a `runPromise` root);
 * the `.fx` twins are the un-run inners so the loop composes the tick's
 * state writes in ONE fiber rather than severing at each write.
 *
 * Proves:
 *   - the shipped `NoopStateApplicator` exposes composable `fx` twins
 *     (Effects, not Promises) that nest in an `Effect.gen`;
 *   - a recording applicator records identically on the fx edge — the
 *     property the Stage-3 loop rewrite relies on (it composes `fx.apply*`
 *     instead of awaiting the facade).
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type {
  LanguageModelExecutionResult,
  LoopToolResult,
  StateApplicator,
} from "@agentick/spec-next";

import { NoopStateApplicator } from "../noop-state-applicator.js";

const result = (): LanguageModelExecutionResult => ({
  specVersion: "2026-05-08",
  output: [{ type: "text", text: "hi" }],
  stopReason: "end",
});

const applyExecInput = () => ({
  sessionId: "s1",
  executionId: "e1",
  tickId: "t1",
  result: result(),
});

const applyToolsInput = (results: readonly LoopToolResult[]) => ({
  sessionId: "s1",
  executionId: "e1",
  tickId: "t1",
  results,
});

describe("StateApplicator — .fx dual-typed edge", () => {
  it("NoopStateApplicator.fx twins are composable Effects (not Promises)", () => {
    const noop = new NoopStateApplicator();
    const a = noop.fx.applyExecutorResult(applyExecInput());
    const b = noop.fx.applyToolResults(applyToolsInput([]));

    expect(Effect.isEffect(a)).toBe(true);
    expect(a).not.toBeInstanceOf(Promise);
    expect(Effect.isEffect(b)).toBe(true);
  });

  it("fx twins nest in one Effect.gen (single fiber tree)", async () => {
    const noop = new NoopStateApplicator();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* noop.fx.applyExecutorResult(applyExecInput());
        yield* noop.fx.applyToolResults(applyToolsInput([]));
      }),
    );
    // No throw = the void twins composed cleanly.
    expect(true).toBe(true);
  });

  it("a recording applicator records on the fx edge (the Stage-3 loop path)", async () => {
    const order: string[] = [];
    const applicator: StateApplicator = {
      fx: {
        applyExecutorResult: () =>
          Effect.sync(() => {
            order.push("executor-result");
          }),
        applyToolResults: () =>
          Effect.sync(() => {
            order.push("tool-results");
          }),
      },
      applyExecutorResult: async () => {
        order.push("executor-result");
      },
      applyToolResults: async () => {
        order.push("tool-results");
      },
      appendEntry: async () => undefined,
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* applicator.fx.applyExecutorResult(applyExecInput());
        yield* applicator.fx.applyToolResults(applyToolsInput([]));
      }),
    );

    expect(order).toEqual(["executor-result", "tool-results"]);
  });
});

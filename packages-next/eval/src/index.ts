/**
 * `@agentick/eval-next` — testing-shaped eval framework for Agentick v2.
 *
 * Iteration 1 (MVP): defineEval + t.send/completed/calledTool/
 * notCalledTool/noFailedActions. Each invocation builds its own
 * AppHarness; assertions record into a result ledger instead of
 * throwing.
 *
 * Future iterations: matrix sweeps, t.judge LLM-as-judge,
 * fixture injection, tool stubs, cost accounting, cassette replay.
 * See [ADR 37](../../docs/proposals/v2/blueprint/37-eval-package-sketch.md).
 */

export { defineEval } from "./define-eval.js";
export type {
  AssertionKind,
  AssertionResult,
  CallableEval,
  EvalContext,
  EvalDefinition,
  EvalInvocationOverrides,
  EvalResult,
  EvalTest,
  ObservedToolCall,
} from "./types.js";

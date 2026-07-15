/**
 * `@agentick/eval-next` — testing-shaped eval framework for Agentick v2.
 *
 * Iteration 1 (MVP): `defineEval({ description, app, test })` returns
 * a callable. `app` is a thunk that builds a fresh AppHarness per
 * invocation, receiving per-call overrides. Assertions record into
 * a result ledger instead of throwing.
 *
 * Future iterations: matrix sweeps, t.judge LLM-as-judge,
 * fixture injection, tool stubs, cost accounting, cassette replay.
 * See [ADR 37](../../docs/proposals/v2/blueprint/37-eval-package-sketch.md).
 */

export { defineEval } from "./define-eval.js";
export { registerEvalPlugin, registeredEvalPlugins } from "./plugins.js";
export { formatResult, formatMatrix } from "./report.js";
export { renderHtmlReport, type HtmlReportOptions } from "./html-report.js";
export { passAtK, aggregate, cellStats } from "./stats.js";
export type {
  AppFactory,
  AssertionKind,
  AssertionResult,
  CallableEval,
  CellStats,
  DefaultAppOverrides,
  EvalContext,
  EvalContextExtensions,
  EvalDefinition,
  EvalPlugin,
  EvalResult,
  EvalRunContext,
  EvalTest,
  MatrixCell,
  MatrixOptions,
  MatrixResult,
  ObservedToolCall,
  PluginAssertionInput,
  ScoreAgg,
  ScoreResult,
} from "./types.js";

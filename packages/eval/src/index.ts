/**
 * `@agentick/eval` — testing-shaped eval framework for Agentick v2.
 *
 * `defineEval({ description, app, test })` returns a CALLABLE: `await myEval()`
 * runs once, `await myEval(overrides)` runs with a different model or fixture,
 * and `await myEval.matrix(axes, opts)` runs the cartesian product of the axes
 * (`trials` runs per cell, `concurrency` in parallel) and returns one cell per
 * combination.
 * `app` is a thunk, so every invocation gets a FRESH app harness built from that
 * run's overrides — cells never share state.
 *
 * Assertions RECORD instead of throwing: `t.expect` / `t.calledTool` /
 * `t.completed` append to a ledger, so one run reports everything that went
 * wrong rather than the first thing. `t.score` records numeric signal alongside
 * them WITHOUT gating `passed` — the graded half of an eval (quality, tokens,
 * latency), aggregated across matrix cells by `aggregate` / `cellStats` /
 * `passAtK`.
 *
 * What this barrel exports:
 *   - `defineEval`                        the definition → callable
 *   - `registerEvalPlugin` /
 *     `registeredEvalPlugins`             the global plugin list applied to
 *                                         every eval
 *   - `formatResult` / `formatMatrix`      terminal reports
 *   - `renderHtmlReport`                   standalone HTML report (score
 *                                          columns, cost-vs-quality scatter)
 *   - `passAtK` / `aggregate` / `cellStats` matrix statistics
 *   - the types behind all of it
 *
 * The `t` surface is EXTENSIBLE, not fixed: a plugin is a factory over the run's
 * {@link EvalRunContext} whose returned members merge onto `t`, typed by
 * augmenting `EvalContextExtensions`. Two ship as separate subpaths so their
 * dependencies stay opt-in — `@agentick/eval/plugins/judge` (`t.judge`,
 * LLM-as-judge over a rubric) and `@agentick/eval/plugins/workspace` (`t.sh` /
 * `t.file` against a scratch directory).
 *
 * Not built yet: cassette record/replay, cost accounting beyond whatever a
 * score records, and fixture/tool-stub injection (an eval stubs tools by
 * building a different app in its `app` thunk).
 *
 * @see [ADR 37](../../docs/proposals/v2/blueprint/37-eval-package-sketch.md)
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

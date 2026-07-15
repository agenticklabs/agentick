/**
 * Trial aggregation — turn N runs of one cell into a distribution.
 *
 * Agents are stochastic, so a single run's pass/fail and a single score value
 * are noise. Running each matrix cell `trials` times and aggregating is what
 * makes the numbers honest: `quality: 0.62` becomes `0.62 ±0.18 (n=5)`, and a
 * pass rate becomes an unbiased `pass@k`.
 */

import type { CellStats, EvalResult, ScoreAgg } from "./types.js";

/**
 * Unbiased `pass@k` estimator (Chen et al. 2021, as used by HumanEval /
 * SWE-bench): the probability that at least one of `k` samples passes, given
 * `n` trials of which `c` passed. NOT "did any of n pass" — that over-counts.
 *
 *   pass@k = 1 − C(n−c, k) / C(n, k)
 *
 * Computed in the numerically-stable product form. `k` is clamped to `[1, n]`.
 *
 * @verifiedBy packages-next/eval/src/__tests__/stats.spec.ts
 */
export function passAtK(n: number, c: number, k: number): number {
  if (n <= 0) return 0;
  const kk = Math.max(1, Math.min(Math.trunc(k), n));
  // Fewer failures than k → every k-subset contains a pass.
  if (n - c < kk) return 1;
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) prod *= 1 - kk / i;
  return 1 - prod;
}

/** Mean / population-stddev / min / max of a value set. stddev is 0 for n≤1. */
export function aggregate(values: readonly number[]): ScoreAgg {
  const n = values.length;
  if (n === 0) return { mean: 0, stddev: 0, min: 0, max: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    mean,
    stddev: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    n,
  };
}

/**
 * Collapse the `trials` runs of one cell into {@link CellStats}: pass rate,
 * optional `pass@k`, and a per-score-label {@link ScoreAgg}. Score labels are
 * unioned across trials (a label missing from a trial just contributes fewer
 * samples to its aggregate).
 */
export function cellStats(trials: readonly EvalResult[], k?: number): CellStats {
  const n = trials.length;
  const passed = trials.filter((r) => r.passed).length;

  const byLabel = new Map<string, number[]>();
  for (const run of trials) {
    for (const s of run.scores) {
      const arr = byLabel.get(s.label) ?? [];
      arr.push(s.value);
      byLabel.set(s.label, arr);
    }
  }
  const scores: Record<string, ScoreAgg> = {};
  for (const [label, values] of byLabel) scores[label] = aggregate(values);

  return {
    trials: n,
    passed,
    passRate: n ? passed / n : 0,
    ...(k !== undefined ? { passAtK: passAtK(n, passed, k) } : {}),
    scores,
  };
}

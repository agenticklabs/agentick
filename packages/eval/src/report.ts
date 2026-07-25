/**
 * Console reporters — turn an {@link EvalResult} / {@link MatrixResult} into a
 * readable scorecard string. Deliberately dependency-free (returns a string;
 * you `console.log` it) so it works in any runner.
 */

import type { EvalResult, MatrixResult, ScoreResult } from "./types.js";

const mark = (passed: boolean): string => (passed ? "✓" : "✗");

function scoreLine(s: ScoreResult): string {
  return `      ~ ${s.label}: ${s.value.toFixed(2)}`;
}

/** A one-eval scorecard: pass/fail per assertion, scores, tool calls, timing. */
export function formatResult(result: EvalResult): string {
  const lines: string[] = [];
  lines.push(`${mark(result.passed)} ${result.description}  (${result.elapsedMs}ms)`);
  for (const a of result.assertions) {
    const name = a.label ?? a.kind;
    lines.push(`    ${mark(a.passed)} ${name}${a.passed ? "" : ` — ${a.message}`}`);
  }
  for (const s of result.scores) lines.push(scoreLine(s));
  if (result.toolCalls.length) {
    lines.push(`      · tools: ${result.toolCalls.map((c) => c.name).join(", ")}`);
  }
  if (result.error) lines.push(`      ! error: ${result.error.name}: ${result.error.message}`);
  return lines.join("\n");
}

/** Show a value at score-appropriate precision (token-ish → integer). */
function fmtNum(v: number): string {
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2);
}

/**
 * A matrix scorecard: one row per cell (pass rate over trials + each score's
 * mean±stddev), plus aggregate mean-per-score across cells. This is where the
 * testing-shaped model reads as a benchmark — and, with `trials > 1`, where the
 * numbers stop being coin flips.
 */
export function formatMatrix<O>(matrix: MatrixResult<O>): string {
  const lines: string[] = [];
  const passCount = matrix.cells.filter((c) => c.stats.passRate > 0.5).length;
  lines.push(
    `${mark(matrix.passed)} matrix: ${passCount}/${matrix.cells.length} cells passed  (${matrix.elapsedMs}ms)`,
  );
  for (const cell of matrix.cells) {
    const { stats } = cell;
    const axes = JSON.stringify(cell.axes);
    const rate =
      stats.trials > 1 ? `${stats.passed}/${stats.trials}` : stats.passed ? "pass" : "fail";
    const atK = stats.passAtK !== undefined ? ` pass@k=${stats.passAtK.toFixed(2)}` : "";
    const scores = Object.entries(stats.scores)
      .map(([label, a]) => `${label}=${fmtNum(a.mean)}${a.n > 1 ? `±${fmtNum(a.stddev)}` : ""}`)
      .join(" ");
    lines.push(
      `    ${mark(stats.passRate > 0.5)} ${axes}  ${rate}${atK}${scores ? `  ${scores}` : ""}`,
    );
  }
  // Aggregate mean per score label across cells (mean of per-cell means).
  const byLabel = new Map<string, number[]>();
  for (const cell of matrix.cells) {
    for (const [label, a] of Object.entries(cell.stats.scores)) {
      const arr = byLabel.get(label) ?? [];
      arr.push(a.mean);
      byLabel.set(label, arr);
    }
  }
  for (const [label, means] of byLabel) {
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    lines.push(`    ~ mean ${label}: ${fmtNum(mean)} (cells=${means.length})`);
  }
  return lines.join("\n");
}

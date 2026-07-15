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

/**
 * A matrix scorecard: one row per cell, plus aggregate pass-rate and, for each
 * score label, the mean across cells. This is where the testing-shaped model
 * reads as a benchmark.
 */
export function formatMatrix<O>(matrix: MatrixResult<O>): string {
  const lines: string[] = [];
  const passCount = matrix.cells.filter((c) => c.result.passed).length;
  lines.push(
    `${mark(matrix.passed)} matrix: ${passCount}/${matrix.cells.length} cells passed  (${matrix.elapsedMs}ms)`,
  );
  for (const cell of matrix.cells) {
    const axes = JSON.stringify(cell.axes);
    const scores = cell.result.scores.map((s) => `${s.label}=${s.value.toFixed(2)}`).join(" ");
    lines.push(`    ${mark(cell.result.passed)} ${axes}${scores ? `  ${scores}` : ""}`);
  }
  // Aggregate mean per score label across cells.
  const byLabel = new Map<string, number[]>();
  for (const cell of matrix.cells) {
    for (const s of cell.result.scores) {
      const arr = byLabel.get(s.label) ?? [];
      arr.push(s.value);
      byLabel.set(s.label, arr);
    }
  }
  for (const [label, values] of byLabel) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    lines.push(`    ~ mean ${label}: ${mean.toFixed(2)} (n=${values.length})`);
  }
  return lines.join("\n");
}

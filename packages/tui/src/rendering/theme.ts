/**
 * TUI color theme — consistent palette for terminal rendering.
 *
 * Uses chalk for ANSI color output. All colors are defined here so the
 * palette can be adjusted in one place.
 *
 * Brand color: emerald green (#34d399 / #10b981).
 */

import chalk from "chalk";

const brand = chalk.hex("#34d399"); // emerald-300 — works on light and dark terminals
const brandBold = brand.bold;
const brandDim = chalk.hex("#065f46"); // emerald-900 — subtle borders, structural chrome

export const theme = {
  // ── Roles ───────────────────────────────────────────────────────────────
  user: brandBold,
  assistant: brandBold,
  system: chalk.gray,

  // ── Markdown elements ──────────────────────────────────────────────────
  heading: brandBold,
  firstHeading: brandBold,
  strong: chalk.bold,
  em: chalk.italic,
  codespan: chalk.hex("#fbbf24"), // amber
  blockquote: chalk.gray.italic,
  hr: brand,
  link: brand.underline,
  href: brand,

  // ── Content blocks ─────────────────────────────────────────────────────
  toolName: chalk.hex("#fbbf24").bold, // amber
  toolDuration: chalk.gray,
  toolSymbol: brand,
  error: chalk.red,
  errorLabel: chalk.red.bold,
  success: chalk.green,
  dim: chalk.gray,
  label: chalk.gray,
  reasoning: chalk.gray.italic,

  // ── Structural ─────────────────────────────────────────────────────────
  border: brandDim,
  separator: brandDim,
  muted: chalk.dim,
};

/** Format a duration in ms to a human-readable string */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

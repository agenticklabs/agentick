/**
 * Format token count for display.
 * Shows "1.2k" for counts >= 1000.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Format duration in milliseconds for display.
 * Shows "1.23s" for durations >= 1000ms.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

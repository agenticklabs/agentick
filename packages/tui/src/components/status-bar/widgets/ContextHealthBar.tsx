/**
 * ContextHealthBar — visual progress bar for context utilization and cache health.
 *
 * Renders a compact Unicode bar:
 *   [████████░░░░░░░░] 52% · cache 87%
 *
 * Color thresholds:
 *   - Context: green (0-50%), yellow (50-80%), red (80-100%)
 *   - Cache: green (80%+), yellow (50-80%), red (<50%)
 */

import { Text } from "ink";
import { useStatusBarData } from "../context.js";

interface ContextHealthBarProps {
  /** Override utilization percentage (0-100) */
  utilization?: number;
  /** Override cache hit ratio (0-1) */
  cacheHitRatio?: number;
  /** Bar width in characters (default: 16) */
  barWidth?: number;
}

const FILLED = "\u2588"; // █
const EMPTY = "\u2591"; // ░

function utilizationColor(util: number): string {
  if (util > 80) return "red";
  if (util > 50) return "yellow";
  return "green";
}

function cacheColor(ratio: number): string {
  if (ratio >= 0.8) return "green";
  if (ratio >= 0.5) return "yellow";
  return "red";
}

export function ContextHealthBar({
  utilization: explicitUtil,
  cacheHitRatio: explicitCache,
  barWidth = 16,
}: ContextHealthBarProps) {
  const data = useStatusBarData();
  const ci = data?.contextInfo;

  const util = explicitUtil ?? ci?.utilization;
  const cache = explicitCache ?? ci?.cacheHitRatio;

  if (util == null) return null;

  const filled = Math.round((util / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = FILLED.repeat(filled) + EMPTY.repeat(empty);
  const color = utilizationColor(util);

  return (
    <Text>
      <Text color={color}>{bar}</Text>
      <Text color={color}> {Math.round(util)}%</Text>
      {cache != null && (
        <>
          <Text dimColor> · </Text>
          <Text color={cacheColor(cache)}>cache {Math.round(cache * 100)}%</Text>
        </>
      )}
    </Text>
  );
}

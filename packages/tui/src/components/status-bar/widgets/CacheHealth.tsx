import { Text } from "ink";
import { useStatusBarData } from "../context.js";

interface CacheHealthProps {
  /** Override cache hit ratio (0-1) */
  ratio?: number;
  /** Thresholds: [low, high] (default: [0.5, 0.8]) */
  thresholds?: [number, number];
  /** Colors for [cold, warm, hot] */
  colors?: [string, string, string];
}

export function CacheHealth({
  ratio: explicitRatio,
  thresholds = [0.5, 0.8],
  colors = ["red", "yellow", "green"],
}: CacheHealthProps) {
  const data = useStatusBarData();
  const ratio = explicitRatio ?? data?.contextInfo?.cacheHitRatio;

  if (ratio == null) return null;

  const color = ratio >= thresholds[1] ? colors[2] : ratio >= thresholds[0] ? colors[1] : colors[0];
  const pct = Math.round(ratio * 100);

  return <Text color={color}>cache {pct}%</Text>;
}

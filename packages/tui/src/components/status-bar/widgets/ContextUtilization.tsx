import { Text } from "ink";
import { useStatusBarData } from "../context.js";

interface ContextUtilizationProps {
  /** Override utilization percentage (0-100) */
  utilization?: number;
  /** Color thresholds: [warn, critical] (default: [50, 80]) */
  thresholds?: [number, number];
  /** Colors for [normal, warn, critical] */
  colors?: [string, string, string];
}

export function ContextUtilization({
  utilization: explicitUtil,
  thresholds = [50, 80],
  colors = ["gray", "yellow", "red"],
}: ContextUtilizationProps) {
  const data = useStatusBarData();
  const util = explicitUtil ?? data?.contextInfo?.utilization;

  if (util == null) return null;

  const color = util > thresholds[1] ? colors[2] : util > thresholds[0] ? colors[1] : colors[0];

  return <Text color={color}>{Math.round(util)}%</Text>;
}

import { Text } from "ink";
import { useStatusBarData } from "../context.js";

interface TickCountProps {
  /** Override tick number */
  tick?: number;
  /** Text color */
  color?: string;
}

export function TickCount({ tick: explicitTick, color = "gray" }: TickCountProps) {
  const data = useStatusBarData();
  const tick = explicitTick ?? data?.contextInfo?.tick;

  if (tick == null || tick === 0) return null;

  return <Text color={color}>tick {tick}</Text>;
}

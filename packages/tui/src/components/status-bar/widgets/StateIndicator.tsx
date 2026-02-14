import { Text } from "ink";
import type { ChatMode } from "@agentick/client";
import { useStatusBarData } from "../context.js";

const DEFAULT_LABELS: Record<ChatMode, string> = {
  idle: "idle",
  streaming: "streaming",
  confirming_tool: "confirm",
};

const DEFAULT_COLORS: Record<ChatMode, string> = {
  idle: "green",
  streaming: "yellow",
  confirming_tool: "magenta",
};

interface StateIndicatorProps {
  /** Override mode */
  mode?: ChatMode;
  /** Custom labels per mode */
  labels?: Partial<Record<ChatMode, string>>;
  /** Custom colors per mode */
  colors?: Partial<Record<ChatMode, string>>;
}

export function StateIndicator({ mode: explicitMode, labels, colors }: StateIndicatorProps) {
  const data = useStatusBarData();
  const mode = explicitMode ?? data?.mode ?? "idle";
  const label = labels?.[mode] ?? DEFAULT_LABELS[mode];
  const color = colors?.[mode] ?? DEFAULT_COLORS[mode];

  return <Text color={color}>{label}</Text>;
}

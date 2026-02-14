import { Text } from "ink";
import type { ChatMode } from "@agentick/client";
import type { ReactNode } from "react";
import { useStatusBarData } from "../context.js";

interface Hint {
  key: string;
  action: string;
  color?: string;
}

const DEFAULT_HINTS: Record<ChatMode, Hint[]> = {
  idle: [
    { key: "Enter", action: "send" },
    { key: "Ctrl+C", action: "exit" },
  ],
  streaming: [{ key: "Ctrl+C", action: "abort" }],
  confirming_tool: [
    { key: "Y", action: "approve", color: "green" },
    { key: "N", action: "reject", color: "red" },
    { key: "A", action: "always", color: "#34d399" },
  ],
};

interface KeyboardHintsProps {
  /** Override mode */
  mode?: ChatMode;
  /** Custom hints per mode (overrides defaults for that mode) */
  hints?: Partial<Record<ChatMode, Hint[]>>;
}

function renderHints(hints: Hint[]): ReactNode {
  return (
    <Text>
      {hints.map((hint, i) => (
        <Text key={hint.key}>
          {i > 0 && <Text color="gray"> | </Text>}
          <Text bold color={hint.color}>
            {hint.key}
          </Text>
          <Text color="gray"> {hint.action}</Text>
        </Text>
      ))}
    </Text>
  );
}

export function KeyboardHints({ mode: explicitMode, hints }: KeyboardHintsProps) {
  const data = useStatusBarData();
  const mode = explicitMode ?? data?.mode ?? "idle";
  const modeHints = hints?.[mode] ?? DEFAULT_HINTS[mode];

  return renderHints(modeHints);
}

export type { Hint as KeyboardHint };

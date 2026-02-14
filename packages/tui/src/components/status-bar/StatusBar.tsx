/**
 * StatusBar — container that calls hooks once and provides context to widgets.
 *
 * Renders a flexbox row with `left` (grows) and `right` (shrinks) regions.
 * No border — place below an InputBar or other bordered element for visual separation.
 */

import type { ReactNode } from "react";
import { Box } from "ink";
import { useContextInfo, useStreamingText } from "@agentick/react";
import type { ChatMode } from "@agentick/client";
import { StatusBarContext, type StatusBarData } from "./context.js";

export interface StatusBarProps {
  /** Session ID for context info subscription */
  sessionId: string;
  /** Current chat mode */
  mode?: ChatMode;
  /** Whether an execution is running (defaults to streaming text state) */
  isExecuting?: boolean;
  /** Left-aligned content (grows to fill) */
  left?: ReactNode;
  /** Right-aligned content (shrinks to fit) */
  right?: ReactNode;
}

export function StatusBar({
  sessionId,
  mode = "idle",
  isExecuting: explicitExecuting,
  left,
  right,
}: StatusBarProps) {
  const { contextInfo } = useContextInfo({ sessionId });
  const { isStreaming } = useStreamingText();

  const data: StatusBarData = {
    mode,
    isExecuting: explicitExecuting ?? isStreaming,
    sessionId,
    contextInfo,
  };

  return (
    <StatusBarContext value={data}>
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Box flexGrow={1} flexShrink={1}>
          {left}
        </Box>
        {right && <Box flexShrink={0}>{right}</Box>}
      </Box>
    </StatusBarContext>
  );
}

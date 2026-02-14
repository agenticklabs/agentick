/**
 * DefaultStatusBar — pre-composed standard layout.
 *
 * Left:  KeyboardHints (contextual)
 * Right: ModelInfo | TokenCount ContextUtilization | StateIndicator
 *
 * Responsive: hides verbose segments in narrow terminals.
 * - Wide (80+):   all segments
 * - Medium (60+): model + state (no tokens/utilization)
 * - Narrow (<60): state only
 */

import type { ChatMode } from "@agentick/client";
import { useStdout } from "ink";
import { StatusBar } from "./StatusBar.js";
import { KeyboardHints } from "./widgets/KeyboardHints.js";
import { StatusBarRight } from "./StatusBarRight.js";

interface DefaultStatusBarProps {
  sessionId: string;
  mode?: ChatMode;
  isExecuting?: boolean;
}

export function DefaultStatusBar({ sessionId, mode = "idle", isExecuting }: DefaultStatusBarProps) {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;

  return (
    <StatusBar
      sessionId={sessionId}
      mode={mode}
      isExecuting={isExecuting}
      left={<KeyboardHints />}
      right={<StatusBarRight width={width} />}
    />
  );
}

/**
 * Complete component - marks execution as complete with optional final output
 *
 * Provides an ergonomic way to stop the tick loop and emit a final message.
 * Alternative to manually calling `state.stop()` + returning JSX.
 *
 * @example
 * ```tsx
 * render(com, state) {
 *   if (allVotesIn && winner) {
 *     return (
 *       <Complete reason="Consensus reached">
 *         <Assistant>The answer is {winner}</Assistant>
 *       </Complete>
 *     );
 *   }
 *   // Continue processing...
 * }
 * ```
 *
 * @example Without children (just stop, no message)
 * ```tsx
 * if (shouldStop) {
 *   return <Complete reason="Task completed" />;
 * }
 * ```
 */

import React, { useRef, useEffect } from "react";
import type { JSX } from "react";
import { useTickState } from "../../hooks/context";
import { type ComponentBaseProps } from "../jsx-types";

/**
 * Props for Complete component
 */
export interface CompleteProps extends ComponentBaseProps {
  /**
   * Children to render as the final output.
   * Typically an <Assistant> message with the final answer.
   */
  children?: React.ReactNode;

  /**
   * Reason for completion (optional, used for logging/debugging)
   */
  reason?: string;

  /**
   * Whether the completion is due to an error condition.
   * If true, the reason is treated as an error message.
   */
  isError?: boolean;
}

/**
 * Complete component - marks execution as complete with optional final output.
 *
 * On mount, calls state.stop() to end the tick loop.
 * Renders children (if any) as the final output.
 *
 * @example
 * ```tsx
 * <Complete reason="Task done">
 *   <Assistant>Final answer here</Assistant>
 * </Complete>
 * ```
 */
export function Complete(props: CompleteProps): JSX.Element | null {
  const { reason, children } = props;
  const state = useTickState();
  const hasCompletedRef = useRef(false);

  // Call stop on first render
  useEffect(() => {
    if (!hasCompletedRef.current) {
      hasCompletedRef.current = true;
      const stopReason = reason || "Complete component reached";
      state.stop(stopReason);
    }
  }, [state, reason]);

  // Render children as final output
  if (children) {
    return React.createElement(React.Fragment, null, children);
  }

  return null;
}

// Export CompleteComponent as an alias for backwards compatibility
export const CompleteComponent = Complete;

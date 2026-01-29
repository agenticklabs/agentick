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

import { createElement, type JSX } from "../jsx-runtime";
import { Component } from "../../component/component";
import { COM } from "../../com/object-model";
import { type TickState } from "../../component/component";
import { type ComponentBaseProps } from "../jsx-types";

/**
 * Props for Complete component
 */
export interface CompleteProps extends ComponentBaseProps {
  /**
   * Children to render as the final output.
   * Typically an <Assistant> message with the final answer.
   */
  children?: JSX.Element | JSX.Element[];

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
 * Complete component implementation.
 *
 * On mount, calls state.stop() to end the tick loop.
 * Renders children (if any) as the final output.
 */
export class CompleteComponent extends Component<CompleteProps> {
  private hasCompleted = false;

  render(_com: COM, state: TickState): JSX.Element | null {
    // Only call stop once per instance
    if (!this.hasCompleted) {
      this.hasCompleted = true;
      const reason = this.props.reason || "Complete component reached";
      state.stop(reason);
    }

    // Render children as final output
    if (this.props.children) {
      // If single child, return it directly
      if (Array.isArray(this.props.children)) {
        // Multiple children - wrap in fragment would be ideal but return first for now
        // In practice, Complete usually wraps a single <Assistant> element
        return this.props.children[0] as JSX.Element;
      }
      return this.props.children as JSX.Element;
    }

    return null;
  }
}

/**
 * JSX-compatible Complete component factory.
 *
 * @example
 * ```tsx
 * <Complete reason="Task done">
 *   <Assistant>Final answer here</Assistant>
 * </Complete>
 * ```
 */
export function Complete(props: CompleteProps): JSX.Element {
  return createElement(CompleteComponent, props);
}

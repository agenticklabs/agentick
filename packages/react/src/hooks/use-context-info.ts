import { useState, useEffect, useCallback } from "react";
import type { StreamEvent, SessionStreamEvent } from "@agentick/client";
import type { ContextInfo } from "@agentick/shared";
import { useClient } from "./use-client.js";

// ============================================================================
// useContextInfo
// ============================================================================

/**
 * Context utilization info from the server.
 * Updated after each tick with token usage and model capabilities.
 */
export { type ContextInfo };

/**
 * Options for useContextInfo hook.
 */
export interface UseContextInfoOptions {
  /**
   * Optional session ID to filter events for.
   * If not provided, receives context info from any session.
   */
  sessionId?: string;

  /**
   * Whether the hook is enabled.
   * If false, no context info subscription is created.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Return value from useContextInfo hook.
 */
export interface UseContextInfoResult {
  /**
   * Latest context info (null before first tick completes).
   */
  contextInfo: ContextInfo | null;

  /**
   * Clear the current context info.
   */
  clear: () => void;
}

/**
 * Subscribe to context utilization info from the server.
 *
 * Receives context_update events after each tick with:
 * - Token usage (input, output, total)
 * - Context utilization percentage
 * - Model capabilities (vision, tools, reasoning)
 * - Cumulative usage across ticks
 *
 * @example Basic usage
 * ```tsx
 * import { useContextInfo } from '@agentick/react';
 *
 * function ContextBar() {
 *   const { contextInfo } = useContextInfo();
 *
 *   if (!contextInfo) return null;
 *
 *   return (
 *     <div className="context-bar">
 *       <span>{contextInfo.modelId}</span>
 *       <span>{contextInfo.utilization?.toFixed(1)}% used</span>
 *       <progress value={contextInfo.utilization} max={100} />
 *     </div>
 *   );
 * }
 * ```
 *
 * @example Session-specific context info
 * ```tsx
 * function SessionContext({ sessionId }: { sessionId: string }) {
 *   const { contextInfo } = useContextInfo({ sessionId });
 *
 *   if (!contextInfo) return <span>No context yet</span>;
 *
 *   return (
 *     <span>
 *       {contextInfo.inputTokens.toLocaleString()} /
 *       {contextInfo.contextWindow?.toLocaleString() ?? '?'} tokens
 *     </span>
 *   );
 * }
 * ```
 */
export function useContextInfo(options: UseContextInfoOptions = {}): UseContextInfoResult {
  const { sessionId, enabled = true } = options;
  const client = useClient();
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // Subscribe to context_update events
    const handleEvent = (event: StreamEvent | SessionStreamEvent) => {
      if (event.type !== "context_update") return;

      // Type assertion since we filtered by type
      const ctxEvent = event as StreamEvent & {
        modelId: string;
        modelName?: string;
        provider?: string;
        contextWindow?: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        utilization?: number;
        maxOutputTokens?: number;
        supportsVision?: boolean;
        supportsToolUse?: boolean;
        isReasoningModel?: boolean;
        tick: number;
        cumulativeUsage?: ContextInfo["cumulativeUsage"];
      };

      setContextInfo({
        modelId: ctxEvent.modelId,
        modelName: ctxEvent.modelName,
        provider: ctxEvent.provider,
        contextWindow: ctxEvent.contextWindow,
        inputTokens: ctxEvent.inputTokens,
        outputTokens: ctxEvent.outputTokens,
        totalTokens: ctxEvent.totalTokens,
        utilization: ctxEvent.utilization,
        maxOutputTokens: ctxEvent.maxOutputTokens,
        supportsVision: ctxEvent.supportsVision,
        supportsToolUse: ctxEvent.supportsToolUse,
        isReasoningModel: ctxEvent.isReasoningModel,
        tick: ctxEvent.tick,
        cumulativeUsage: ctxEvent.cumulativeUsage,
      });
    };

    // Use session-specific subscription if sessionId provided
    if (sessionId) {
      const accessor = client.session(sessionId);
      return accessor.onEvent(handleEvent);
    }

    // Global subscription
    return client.onEvent(handleEvent);
  }, [client, sessionId, enabled]);

  const clear = useCallback(() => {
    setContextInfo(null);
  }, []);

  return { contextInfo, clear };
}

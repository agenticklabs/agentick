/**
 * Test Mocks
 *
 * Type-safe mock factories for COM, TickState, and TickResult.
 * Use these in tests instead of creating ad-hoc mocks.
 *
 * @example
 * ```tsx
 * import { createMockCom, createMockTickState, createMockTickResult } from '@agentick/core/testing';
 *
 * const ctx = createMockCom();
 * const tickState = createMockTickState({ tick: 2 });
 * const result = createMockTickResult({ text: "Hello world" });
 * ```
 */

import type { TickState } from "../component/component.js";
import type { TickResult } from "../hooks/types.js";
import type { COMStopRequest, COMContinueRequest } from "../com/object-model.js";
import type { ContentBlock, ToolCall, ToolResult } from "@agentick/shared";
import type { COMTimelineEntry, COMInput, TokenEstimator } from "../com/types.js";

// ============================================================================
// Mock COM
// ============================================================================

export interface MockComOptions {
  id?: string;
  timeline?: COMTimelineEntry[];
  initialState?: Record<string, unknown>;
}

export interface MockCom {
  id: string;
  timeline: COMTimelineEntry[];
  state: Map<string, unknown>;
  // Match real COM interface names
  getState<T>(key: string): T | undefined;
  setState<T>(key: string, value: T): void;
  requestRecompile: () => void;
  getTokenEstimator(): TokenEstimator;
  // EventEmitter-like methods (used by useComState subscription)
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  // Control request methods (used by useContinuation chaining)
  requestStop(details?: COMStopRequest): void;
  requestContinue(details?: COMContinueRequest): void;
  _resolveCurrentShouldContinue(currentShouldContinue: boolean): boolean;
  // Track calls for assertions
  _recompileRequests: string[];
  _controlRequests: Array<{ kind: "stop" | "continue"; priority: number; reason?: string }>;
}

/**
 * Create a mock COM for testing.
 *
 * @example
 * ```tsx
 * const ctx = createMockCom();
 * ctx.setState("counter", 0);
 * expect(ctx.getState("counter")).toBe(0);
 * ```
 */
export function createMockCom(options: MockComOptions = {}): MockCom {
  const state = new Map<string, unknown>(Object.entries(options.initialState ?? {}));
  const recompileRequests: string[] = [];
  const controlRequests: Array<{ kind: "stop" | "continue"; priority: number; reason?: string }> =
    [];
  const listeners = new Map<string, Set<(...args: any[]) => void>>();

  return {
    id: options.id ?? "test-session",
    timeline: options.timeline ?? [],
    state,
    getState<T>(key: string): T | undefined {
      return state.get(key) as T | undefined;
    },
    setState<T>(key: string, value: T): void {
      const previousValue = state.get(key);
      state.set(key, value);
      // Emit state:changed like real COM
      const handlers = listeners.get("state:changed");
      if (handlers) {
        for (const handler of handlers) {
          handler(key, value, previousValue);
        }
      }
    },
    requestRecompile(reason?: string) {
      recompileRequests.push(reason ?? "unspecified");
    },
    requestStop(details: COMStopRequest = {}) {
      controlRequests.push({
        kind: "stop",
        priority: details.priority ?? 0,
        reason: details.reason,
      });
    },
    requestContinue(details: COMContinueRequest = {}) {
      controlRequests.push({
        kind: "continue",
        priority: details.priority ?? 0,
        reason: details.reason,
      });
    },
    _resolveCurrentShouldContinue(currentShouldContinue: boolean): boolean {
      if (controlRequests.length === 0) return currentShouldContinue;

      const sorted = [...controlRequests].sort((a, b) => b.priority - a.priority);
      const stopReq = sorted.find((r) => r.kind === "stop");
      const continueReq = sorted.find((r) => r.kind === "continue");

      controlRequests.length = 0;

      if (stopReq) return false;
      if (!currentShouldContinue && continueReq) return true;
      return currentShouldContinue;
    },
    getTokenEstimator(): TokenEstimator {
      return (text: string) => Math.ceil(text.length / 4) + 4;
    },
    on(event: string, handler: (...args: any[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    off(event: string, handler: (...args: any[]) => void) {
      listeners.get(event)?.delete(handler);
    },
    _recompileRequests: recompileRequests,
    _controlRequests: controlRequests,
  };
}

// ============================================================================
// Mock TickState
// ============================================================================

export interface MockTickStateOptions {
  tick?: number;
  current?: TickState["current"];
  timeline?: TickState["timeline"];
  queuedMessages?: TickState["queuedMessages"];
}

export interface MockTickState extends TickState {
  // Track stop calls for assertions
  _stopCalls: string[];
}

/**
 * Create a mock TickState for testing.
 *
 * @example
 * ```tsx
 * // Shorthand: just tick number
 * const tickState = createMockTickState(2);
 *
 * // Full options
 * const tickState = createMockTickState({ tick: 2, queuedMessages: [...] });
 *
 * tickState.stop("done");
 * expect(tickState._stopCalls).toContain("done");
 * ```
 */
export function createMockTickState(
  optionsOrTick: MockTickStateOptions | number = {},
): MockTickState {
  const options = typeof optionsOrTick === "number" ? { tick: optionsOrTick } : optionsOrTick;
  const stopCalls: string[] = [];

  return {
    tick: options.tick ?? 1,
    current: options.current,
    timeline: options.timeline ?? [],
    queuedMessages: options.queuedMessages ?? [],
    stop(reason: string) {
      stopCalls.push(reason);
    },
    _stopCalls: stopCalls,
  };
}

// ============================================================================
// Mock TickResult
// ============================================================================

export interface MockTickResultOptions {
  tick?: number;
  shouldContinue?: boolean;
  text?: string;
  content?: ContentBlock[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  stopReason?: string;
  usage?: TickResult["usage"];
  timeline?: COMTimelineEntry[];
}

export interface MockTickResult extends TickResult {
  // Track control calls for assertions
  _stopCalls: Array<{ reason?: string }>;
  _continueCalls: Array<{ reason?: string }>;
}

/**
 * Create a mock TickResult for testing.
 *
 * @example
 * ```tsx
 * const result = createMockTickResult({
 *   text: "Task complete <DONE>",
 *   toolCalls: [{ id: "1", name: "search", input: { q: "test" } }],
 * });
 *
 * result.stop("complete");
 * expect(result._stopCalls).toHaveLength(1);
 * ```
 */
export function createMockTickResult(options: MockTickResultOptions = {}): MockTickResult {
  const stopCalls: Array<{ reason?: string }> = [];
  const continueCalls: Array<{ reason?: string }> = [];

  const text = options.text ?? "Test response";
  const content: ContentBlock[] = options.content ?? [{ type: "text", text }];

  return {
    tick: options.tick ?? 1,
    shouldContinue: options.shouldContinue ?? false,
    text,
    content,
    toolCalls: options.toolCalls ?? [],
    toolResults: options.toolResults ?? [],
    stopReason: options.stopReason ?? "stop",
    usage: options.usage ?? { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    timeline: options.timeline ?? [],
    stop(reasonOrOptions?: string | COMStopRequest) {
      const reason =
        typeof reasonOrOptions === "string" ? reasonOrOptions : reasonOrOptions?.reason;
      stopCalls.push({ reason });
    },
    continue(reasonOrOptions?: string | COMContinueRequest) {
      const reason =
        typeof reasonOrOptions === "string" ? reasonOrOptions : reasonOrOptions?.reason;
      continueCalls.push({ reason });
    },
    _stopCalls: stopCalls,
    _continueCalls: continueCalls,
  };
}

// ============================================================================
// Timeline Entry Helpers
// ============================================================================

/**
 * Create a COMTimelineEntry for testing.
 *
 * @param role - Message role
 * @param text - Text content
 * @param tokens - Optional token count (for budget testing)
 *
 * @example
 * ```tsx
 * import { makeTimelineEntry } from '@agentick/core/testing';
 *
 * const entry = makeTimelineEntry("user", "Hello!", 10);
 * const entries = [
 *   makeTimelineEntry("user", "First message", 30),
 *   makeTimelineEntry("assistant", "Response", 50),
 * ];
 * ```
 */
export function makeTimelineEntry(
  role: "user" | "assistant" | "tool" | "system",
  text: string,
  tokens?: number,
): COMTimelineEntry {
  return {
    kind: "message",
    message: {
      role,
      content: [{ type: "text", text }] as any,
    },
    tokens,
  };
}

/**
 * Create a minimal COMInput with timeline entries for testing.
 *
 * @param entries - Timeline entries (or use makeTimelineEntry to create them)
 *
 * @example
 * ```tsx
 * import { makeTimelineEntry, makeCOMInput } from '@agentick/core/testing';
 *
 * const input = makeCOMInput([
 *   makeTimelineEntry("user", "Hello", 10),
 *   makeTimelineEntry("assistant", "Hi there", 15),
 * ]);
 * ```
 */
export function makeCOMInput(entries: COMTimelineEntry[]): COMInput {
  return {
    timeline: entries,
    system: [],
    sections: {},
    tools: [],
    metadata: {},
    ephemeral: [],
  };
}

/**
 * Test Mocks
 *
 * Type-safe mock factories for COM, TickState, and TickResult.
 * Use these in tests instead of creating ad-hoc mocks.
 *
 * @example
 * ```tsx
 * import { createMockCom, createMockTickState, createMockTickResult } from '@tentickle/core/testing';
 *
 * const com = createMockCom();
 * const tickState = createMockTickState({ tick: 2 });
 * const result = createMockTickResult({ text: "Hello world" });
 * ```
 */

import type { TickState } from "../component/component";
import type { TickResult } from "../hooks/types";
import type { COMStopRequest, COMContinueRequest } from "../com/object-model";
import type { ContentBlock, ToolCall, ToolResult } from "@tentickle/shared";
import type { COMTimelineEntry } from "../com/types";

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
  // Track calls for assertions
  _recompileRequests: string[];
}

/**
 * Create a mock COM for testing.
 *
 * @example
 * ```tsx
 * const com = createMockCom();
 * com.setState("counter", 0);
 * expect(com.getState("counter")).toBe(0);
 * ```
 */
export function createMockCom(options: MockComOptions = {}): MockCom {
  const state = new Map<string, unknown>(Object.entries(options.initialState ?? {}));
  const recompileRequests: string[] = [];

  return {
    id: options.id ?? "test-session",
    timeline: options.timeline ?? [],
    state,
    getState<T>(key: string): T | undefined {
      return state.get(key) as T | undefined;
    },
    setState<T>(key: string, value: T): void {
      state.set(key, value);
    },
    requestRecompile(reason?: string) {
      recompileRequests.push(reason ?? "unspecified");
    },
    _recompileRequests: recompileRequests,
  };
}

// ============================================================================
// Mock TickState
// ============================================================================

export interface MockTickStateOptions {
  tick?: number;
  previous?: TickState["previous"];
  current?: TickState["current"];
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
    previous: options.previous,
    current: options.current,
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

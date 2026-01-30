/**
 * V2 Hook Types
 */

import type { CompiledStructure } from "../compiler/types";

/**
 * COM - Context Object Model
 * The shared state object accessible to all components.
 */
export interface COM {
  /** Unique session ID */
  id: string;

  /** Conversation timeline */
  timeline: TimelineEntry[];

  /** Shared state storage */
  state: Map<string, unknown>;

  /** Get a state value */
  get<T>(key: string): T | undefined;

  /** Set a state value */
  set<T>(key: string, value: T): void;

  /** Request recompilation (for afterCompile hooks) */
  requestRecompile(reason?: string): void;
}

/**
 * Timeline entry in conversation history.
 */
export interface TimelineEntry {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  createdAt: Date;
}

/**
 * Callback types for lifecycle hooks.
 */
export type TickStartCallback = () => void | Promise<void>;
export type TickEndCallback = () => void | Promise<void>;
export type AfterCompileCallback = (compiled: CompiledStructure) => void | Promise<void>;

/**
 * Data fetch options.
 */
export interface UseDataOptions {
  /** Refetch every tick */
  refetchEveryTick?: boolean;

  /** Refetch after N ticks */
  staleAfterTicks?: number;

  /** Dependencies that trigger refetch when changed */
  deps?: unknown[];
}

/**
 * Signal interface for reactive state.
 */
export interface Signal<T> {
  /** Read current value */
  (): T;

  /** Get current value */
  readonly value: T;

  /** Set new value */
  set(value: T | ((prev: T) => T)): void;

  /** Update with function */
  update(fn: (prev: T) => T): void;

  /** Subscribe to changes */
  subscribe(callback: (value: T) => void): () => void;
}

/**
 * TickState - state for a single tick of execution.
 */
export interface TickState {
  /** Current tick number */
  tick: number;

  /** Previous tick's output */
  previous: unknown;

  /** Current tick's in-progress state */
  current: unknown;

  /** Stop execution */
  stop(reason?: string): void;

  /** Whether execution has been stopped */
  stopped: boolean;

  /** Why execution was stopped */
  stopReason?: string;
}

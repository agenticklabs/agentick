import type { EphemeralPosition, COMTimelineEntry } from "../com/types";
import type { ExecutableTool } from "../tool/tool";
import type { SemanticContentBlock, Formatter, ContentRenderer } from "../renderers";
import type { ContentBlock, MessageRoles } from "@tentickle/shared";
import { Fragment, type JSX } from "../jsx/jsx-runtime.js";
import type { COM } from "../com/object-model";
import type { TickState } from "../component/component";
import type { ExecutionMessage } from "../engine/execution-types";

/**
 * Policy boundary captured during compilation.
 * Used by formatInput to apply policy processing after formatting.
 */
export interface CompiledPolicyBoundary {
  /** Display name for debugging */
  displayName: string;
  /** The policy value passed to Provider */
  value: unknown;
  /** The process function from the boundary definition */
  process: (
    entries: COMTimelineEntry[],
    value: unknown,
  ) => COMTimelineEntry[] | Promise<COMTimelineEntry[]>;
}

/**
 * Compiled structure from JSX tree traversal.
 * This is the format-agnostic representation before formatting.
 */
export interface CompiledStructure {
  sections: Map<string, CompiledSection>;
  timelineEntries: CompiledTimelineEntry[];
  systemMessageItems: Array<SystemMessageItem>;
  tools: Array<{ name: string; tool: ExecutableTool }>;
  ephemeral: CompiledEphemeral[];
  metadata: Record<string, unknown>;
  /** Policy boundaries to apply during formatInput */
  policyBoundaries?: CompiledPolicyBoundary[];
}

/**
 * Compiled ephemeral entry (before formatting).
 * Ephemeral content is NOT persisted - rebuilt fresh each tick.
 */
export interface CompiledEphemeral {
  content: SemanticContentBlock[];
  type?: string;
  position: EphemeralPosition;
  order: number;
  id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  formatter?: Formatter;
}

/**
 * Compiled section (before formatting).
 * Contains raw SemanticContentBlocks and renderer context.
 */
export interface CompiledSection {
  id: string;
  title?: string;
  content: SemanticContentBlock[] | string | unknown;
  formatter?: Formatter; // Formatter context from JSX (<Markdown> wrapper)
  visibility?: "model" | "observer" | "log";
  audience?: "model" | "human" | "system";
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Compiled timeline entry (before formatting).
 * Contains raw SemanticContentBlocks and optional formatter context.
 *
 * Note: Application events use role: 'event' on the message, not a separate kind.
 */
export interface CompiledTimelineEntry {
  kind: "message";
  message?: {
    role: MessageRoles;
    content: SemanticContentBlock[];
    id?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  };
  formatter?: Formatter; // Only if explicitly wrapped in formatter tag
  id?: string;
  visibility?: "model" | "observer" | "log";
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * System message item (for consolidation).
 */
export interface SystemMessageItem {
  type: "section" | "message" | "loose";
  sectionId?: string;
  content?: SemanticContentBlock[];
  index: number;
  formatter?: Formatter;
}

/**
 * Options for the compileUntilStable method.
 */
export interface CompileStabilizationOptions {
  /** Maximum iterations before forced stabilization. Default: 10 */
  maxIterations?: number;
  /** Enable development mode warnings for forgotten requestRecompile calls. Default: true in development */
  trackMutations?: boolean;
}

/**
 * Result of the compileUntilStable method.
 */
export interface CompileStabilizationResult {
  /** The final stable compiled structure */
  compiled: CompiledStructure;
  /** Number of iterations taken to stabilize */
  iterations: number;
  /** Whether max iterations was reached (forced stabilization) */
  forcedStable: boolean;
  /** Reasons for each recompile request */
  recompileReasons: string[];
}

// Fragment symbol for cross-module identity comparison
// Using Symbol.for ensures we get the same symbol even across different module loads
const FragmentSymbol = Symbol.for("tentickle.fragment");

/**
 * Check if a type is a Fragment (works across module boundaries)
 * Fragment is a Symbol, so we check by symbol identity or description
 */
export function isFragment(type: any): boolean {
  return (
    type === Fragment ||
    type === FragmentSymbol ||
    (typeof type === "symbol" && type.description === "tentickle.fragment") ||
    type?.name === "Fragment"
  );
}

export interface Fiber {
  type: any;
  props: any;
  instance?: any; // Component instance or null
  children: Fiber[];
  key: string | number | null;
  ref?: string; // Reference name for component instance access
}

// ============================================================================
// Fiber Flags
// ============================================================================

export const FiberFlags = {
  NoFlags: 0b00000000,
  Placement: 0b00000001, // New fiber, needs mount
  Update: 0b00000010, // Props/state changed
  Deletion: 0b00000100, // Needs unmount
  ChildDeletion: 0b00001000, // Has children to unmount
  HasEffect: 0b00010000, // Has effects to run
  Ref: 0b00100000, // Has ref to update
} as const;

export type FiberFlags = (typeof FiberFlags)[keyof typeof FiberFlags];

// ============================================================================
// Hook Tags
// ============================================================================

export const HookTag = {
  // State hooks
  State: 0,
  Reducer: 1,
  ComState: 2,
  WatchState: 3,
  Signal: 4,

  // Effect hooks
  Effect: 10,
  TickStart: 11,
  TickEnd: 12,
  AfterCompile: 13,
  Mount: 14,
  Unmount: 15,
  OnMessage: 16,
  AfterRender: 17,
  Complete: 18,

  // Memoization hooks
  Memo: 20,
  Callback: 21,

  // Ref hooks
  Ref: 30,
  COMRef: 31,

  // Async hooks
  Async: 40,
  CachedAsync: 41,
} as const;

export type HookTag = (typeof HookTag)[keyof typeof HookTag];

// ============================================================================
// Effect
// ============================================================================

/**
 * Effect phase - when the effect runs in the tick lifecycle.
 */
export const EffectPhase = {
  /** Runs at tick start, before render */
  TickStart: "tick-start",
  /** Runs after render/reconciliation, before compile */
  AfterRender: "after-render",
  /** Runs after compile, can request recompile */
  AfterCompile: "after-compile",
  /** Runs at tick end, after model execution */
  TickEnd: "tick-end",
  /** General effect, runs after commit */
  Commit: "commit",
  /** Runs once when component mounts */
  Mount: "mount",
  /** Runs once when component unmounts */
  Unmount: "unmount",
  /** Runs immediately when a message is received */
  OnMessage: "on-message",
  /** Runs when session completes (all ticks done) */
  Complete: "complete",
} as const;

export type EffectPhase = (typeof EffectPhase)[keyof typeof EffectPhase];

/**
 * An effect to run during a tick phase.
 */
export interface Effect {
  /** When this effect runs */
  phase: EffectPhase;

  /** Effect creation function (can be async) */
  create: EffectCallback;

  /** Cleanup function from previous run */
  destroy: EffectCleanup | null;

  /** Dependency array for conditional execution */
  deps: unknown[] | null;

  /** Whether effect needs to run this tick */
  pending: boolean;

  /** Next effect in linked list */
  next: Effect | null;

  /** Debug tag */
  debugLabel?: string;
}

export type EffectCallback = () => void | EffectCleanup | Promise<void | EffectCleanup>;
export type EffectCleanup = () => void | Promise<void>;

// ============================================================================
// Update Queue (for batched state updates)
// ============================================================================

export interface UpdateQueue<S = unknown> {
  /**
   * Array of pending updates. Using an array instead of a circular linked list
   * to avoid race conditions when multiple async operations dispatch concurrently.
   * Array.push is atomic in JavaScript's single-threaded model.
   */
  pending: Update<S>[];
  dispatch: Dispatch<S> | null;
  lastRenderedState: S;
}

export interface Update<S = unknown> {
  action: S | ((prev: S) => S);
}

export type Dispatch<S> = (action: S | ((prev: S) => S)) => void;

// ============================================================================
// Hook State
// ============================================================================

export interface HookState<S = unknown> {
  /** Memoized value */
  memoizedState: S;

  /** Base state for reducers */
  baseState?: S;

  /** Update queue for state hooks */
  queue: UpdateQueue<S> | null;

  /** Effect for effect hooks */
  effect: Effect | null;

  /** Next hook in linked list */
  next: HookState | null;

  /** Hook type */
  tag: HookTag;
}

// ============================================================================
// Fiber Node
// ============================================================================

export interface FiberNode {
  // ============ Identity ============
  type: ComponentType;
  key: string | number | null;

  // ============ Props ============
  props: Record<string, unknown>;
  pendingProps: Record<string, unknown> | null;

  // ============ State ============
  /** Component instance (class components) */
  stateNode: ComponentInstance | null;
  /** Hook state linked list (function components) */
  memoizedState: HookState | null;

  // ============ Tree Structure ============
  parent: FiberNode | null;
  child: FiberNode | null;
  sibling: FiberNode | null;
  index: number;

  // ============ Refs ============
  ref: string | null;

  // ============ Work Tracking ============
  flags: number;
  subtreeFlags: number;
  deletions: FiberNode[] | null;

  // ============ Double Buffering ============
  alternate: FiberNode | null;

  // ============ Rendering Context ============
  renderer: ContentRenderer | null;

  // ============ Debug ============
  debugName?: string;
}

// ============================================================================
// Component Types
// ============================================================================

/**
 * Function component.
 * Can receive (props), (props, com), or (props, com, state).
 */
export type FunctionComponent<P = Record<string, unknown>> =
  | ((props: P) => FiberChild | Promise<FiberChild>)
  | ((props: P, com: COM) => FiberChild | Promise<FiberChild>)
  | ((props: P, com: COM, state: TickState) => FiberChild | Promise<FiberChild>);

/**
 * Class component constructor.
 */
export type ClassComponent<P = Record<string, unknown>> = new (props: P) => ComponentInstance;

/**
 * Any component type.
 */
export type ComponentType =
  | FunctionComponent
  | ClassComponent
  | string // Intrinsic (Section, Message, etc.)
  | symbol; // Fragment

/**
 * Component instance (class component).
 */
export interface ComponentInstance {
  props: Record<string, unknown>;

  // Lifecycle
  onMount?: (com: COM) => void | Promise<void>;
  onUnmount?: (com: COM) => void | Promise<void>;
  onStart?: (com: COM) => void | Promise<void>;
  onTickStart?: (com: COM, state: TickState) => void | Promise<void>;
  onTickEnd?: (com: COM, state: TickState) => void | Promise<void>;
  onAfterCompile?: (
    com: COM,
    compiled: unknown,
    state: TickState,
    ctx: unknown,
  ) => void | Promise<void>;
  onComplete?: (com: COM, finalState: unknown) => void | Promise<void>;
  onError?: (com: COM, state: TickState) => unknown;
  onMessage?: (com: COM, state: TickState, message: ExecutionMessage) => void | Promise<void>;

  // Render
  render?: (com: COM, state: TickState) => FiberChild | Promise<FiberChild>;
}

// ============================================================================
// Fiber Children
// ============================================================================

/**
 * Valid children in the fiber tree.
 */
export type FiberChild =
  | JSX.Element
  | JSX.Element[]
  | ContentBlock
  | ContentBlock[]
  | string
  | number
  | boolean
  | null
  | undefined;

/**
 * Normalized child after processing.
 */
export type NormalizedChild =
  | { kind: "element"; element: JSX.Element }
  | { kind: "content-block"; block: ContentBlock }
  | { kind: "text"; text: string };

// ============================================================================
// Tick Control
// ============================================================================

/**
 * Tick control interface exposed to components via useTick() hook.
 */
export interface TickControl {
  /** Request a tick to be scheduled */
  requestTick(): void;

  /** Cancel a pending tick request */
  cancelTick(): void;

  /** Current tick status */
  status: "idle" | "running" | "pending";

  /** Total tick count */
  tickCount: number;
}

// ============================================================================
// Render Context
// ============================================================================

/**
 * Context available during component render.
 * Set by compiler, read by hooks.
 */
export interface RenderContext {
  /** Current fiber being rendered */
  fiber: FiberNode;

  /** Context Object Model */
  com: COM;

  /** Current tick state */
  tickState: TickState;

  /** Current hook being processed (from previous render) */
  currentHook: HookState | null;

  /** Work-in-progress hook chain being built */
  workInProgressHook: HookState | null;

  /** Abort signal for this execution */
  abortSignal?: AbortSignal;

  /**
   * Context values from ancestor Context.Provider components.
   * Used by useContext() to read context values.
   */
  contextMap?: Map<unknown, unknown>;

  /**
   * Scheduler function for this compilation context.
   * Used by hooks to schedule re-renders when state changes.
   * Captured at render time to ensure concurrent compilations don't interfere.
   */
  scheduleWork?: (fiber: FiberNode) => void;

  /**
   * Tick control for useTick() hook.
   * Allows components to request/cancel ticks.
   */
  tickControl?: TickControl;

  /**
   * Channel accessor for useChannel() hook.
   * Provided by Session to give components access to named channels.
   */
  getChannel?: (name: string) => import("../core/channel").Channel;

  /**
   * Current hook index during mounting.
   * Used for hydration to match hooks to serialized data.
   */
  hookIndex?: number;

  /**
   * Hydration data for the current fiber (if hydrating).
   * Contains serialized hook states to restore.
   */
  hydrationData?: {
    hooks: Array<{ index: number; type: string; value: unknown }>;
  } | null;

  /**
   * Whether we're currently hydrating (restoring from snapshot).
   */
  isHydrating?: boolean;
}

// ============================================================================
// Async Hook Results
// ============================================================================

export interface AsyncResult<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
}

// ============================================================================
// Compiler Configuration
// ============================================================================

export interface FiberCompilerConfig {
  /** Enable development mode warnings */
  dev?: boolean;

  /** Max compile stabilization iterations */
  maxCompileIterations?: number;

  /** Enable async effect execution */
  asyncEffects?: boolean;

  /** Custom content block type detector */
  isContentBlock?: (value: unknown) => boolean;

  /** Default renderer for content blocks */
  defaultRenderer?: ContentRenderer;
}

// ============================================================================
// Compile Result
// ============================================================================

export interface CompileResult {
  /** The compiled structure */
  compiled: CompiledStructure;

  /** Number of stabilization iterations */
  iterations: number;

  /** Whether max iterations was hit */
  forcedStable: boolean;

  /** Reasons for recompilations */
  recompileReasons: string[];
}

// ============================================================================
// Reconciliation Options
// ============================================================================

/**
 * Options for the reconcile() method.
 */
export interface ReconcileOptions {
  /**
   * Tick state to use during reconciliation.
   * If provided, hooks like useTickState() will return this.
   * If not provided, hooks may return undefined/stale state.
   */
  tickState?: TickState;

  /**
   * Tick control to provide to useTick() hook.
   * Allows components to request/cancel ticks and check tick status.
   */
  tickControl?: TickControl;

  /**
   * Channel accessor for useChannel() hook.
   * Allows components to access named channels for pub/sub communication.
   */
  getChannel?: (name: string) => import("../core/channel").Channel;
}

// ============================================================================
// Content Block Types
// ============================================================================

export const CONTENT_BLOCK_TYPES = [
  "text",
  "image",
  "document",
  "audio",
  "video",
  "code",
  "json",
  "tool_use",
  "tool_result",
  "reasoning",
  "user_action",
  "system_event",
  "state_change",
] as const;

export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];

// ============================================================================
// Hook Result Types
// ============================================================================

export type StateHookResult<S> = [S, Dispatch<S>];
export type ReducerHookResult<S, A> = [S, (action: A) => void];
export type RefObject<T> = { current: T };

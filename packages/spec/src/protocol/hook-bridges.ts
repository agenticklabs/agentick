/**
 * Hook bridges — runtime-provided implementations that React hooks
 * inside a reconciler harness call into.
 *
 * Hooks like `useTimeline`, `useKnob`, `useData`, `useLoopControl`
 * cannot reach across the spec firewall directly — the runtime never
 * hands a React component a live `Session` object. Instead, the
 * runtime constructs *bridges* (one implementation per protocol the
 * hook needs) and passes them in via `MountInput.bridges`. The
 * reconciler harness wraps the React render in a context provider
 * carrying these bridges; hooks consume them via `useContext`.
 *
 * Pluggability: any object satisfying a bridge interface can be
 * supplied. Tests pass in-memory stubs; cluster impls pass remote
 * proxies; persistent runtimes pass durable accessors. The reconciler
 * harness does not know or care.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Hook bridges
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md §Hooks model
 */

import type { ContentBlock, MessageRole } from "../data/content-blocks.js";
import type { Unsubscribe } from "./inbox.js";

export type { Unsubscribe };

// ============================================================================
// Aggregate
// ============================================================================

/**
 * Bundle of bridges the runtime supplies to a reconciler harness mount.
 *
 * Required bridges (every reconciler-using runtime must supply):
 *   - `timeline` — read-only access to the session's persisted entries
 *   - `knobs` — model-visible reactive state managed by the harness
 *   - `state` — session-internal reactive state (`useSessionState`)
 *   - `data` — blocking async resolution (the `useData` backbone)
 *   - `loop` — imperative tick control (`useLoopControl`)
 *   - `session` — current session identity / status
 *
 * Optional bridges (supplied when the corresponding harness is wired):
 *   - `sandbox` — sandbox provider handle for `useSandbox`
 *   - `mcp` — MCP server bundle for `<MCP>` / `useMCP`
 *
 * Additional bridges MAY be added without breaking existing hooks —
 * components that reference an unsupplied bridge throw at render time,
 * surfacing a `missing-bridge` diagnostic.
 */
export interface HookBridges {
  readonly timeline: TimelineBridge;
  readonly knobs: KnobBridge;
  readonly state: StateBridge;
  readonly data: DataBridge;
  readonly loop: LoopBridge;
  readonly session: SessionBridge;
  readonly sandbox?: SandboxBridge;
  readonly mcp?: MCPBridge;
  /**
   * Tool registration bridge — exposed when the session's tool
   * executor is wired. Enables reconciler-side tools (e.g. the
   * React-flavored `createTool` with `use()` hook in
   * `@agentick/reconciler-react`) to register handlers at render
   * time so they close over React-Context-derived deps.
   */
  readonly tools?: ToolBridge;
}

// ============================================================================
// Data bridge — the no-Suspense contract
// ============================================================================

/**
 * Blocking async-data resolution for the reconciler render loop.
 *
 * **Critical contract: this is NOT React Suspense.**
 *
 * The reconciler does not use `<Suspense>` boundaries and does not
 * surface "loading" states in the rendered IR. Every `RenderedTree`
 * produced by the harness reflects a fully-resolved view of the
 * application.
 *
 * Mechanics:
 *
 *   1. `resolve(key, fetcher)` returns the cached value synchronously
 *      when present.
 *   2. When not cached, the bridge MUST start the fetch and *throw*
 *      the in-flight Promise (same primitive Suspense uses). The
 *      reconciler's render-until-stable loop catches the thrown
 *      Promise, awaits it, caches the result, and re-renders.
 *   3. When the fetcher *rejects*, the rejection is cached as an
 *      error for that key. The next render call to `resolve(key, …)`
 *      throws the underlying error (synchronously). The component
 *      sees a real error — not a "still loading" state.
 *   4. Unhandled render errors propagate to the harness, which
 *      terminates the `renderTree` operation with `outcome: "failed"`
 *      and a `use-data-failed` diagnostic.
 *   5. The loop terminates whenever a render completes without
 *      throwing a Promise. There is no concept of "render with
 *      partial data."
 *
 * Implementations:
 *   - In-memory: a `Map<key, { state: "fulfilled" | "rejected" | "pending"; value | reason | promise }>`.
 *   - Durable: write-through to a persistent KV; the cache survives
 *     hibernation via `ReconcilerSnapshot.dataCache`.
 *
 * Implementations MUST be deterministic on repeated keys within one
 * mount session — same key → same fetcher → same cached value.
 */
export interface DataBridge {
  /**
   * Resolve `key`. Returns synchronously when cached. Throws an
   * in-flight Promise when not cached. Throws the cached error when
   * the prior fetch rejected.
   *
   * @throws Promise<T> when a fetch is in flight for `key`
   * @throws Error when the prior fetch for `key` rejected
   */
  resolve<T>(key: string, fetcher: () => Promise<T>, options?: DataResolveOptions): T;

  /** Invalidate a cache entry. Next `resolve(key, …)` re-fetches. */
  invalidate(key: string): void;

  /** Invalidate every entry whose `tag` matches. */
  invalidateTag(tag: string): void;

  /** Cache probe (does not start a fetch). */
  has(key: string): boolean;
}

export interface DataResolveOptions {
  /** Milliseconds; after which `has(key)` returns false. */
  readonly ttl?: number;
  /** Group tag for batch invalidation via `invalidateTag`. */
  readonly tag?: string;
}

// ============================================================================
// Timeline bridge
// ============================================================================

/**
 * Read-only access to the session's timeline. Backed by the session
 * harness's persistent store; the reconciler never writes through this
 * bridge — writes happen via session commands.
 */
export interface TimelineBridge {
  read(): TimelineSnapshot;
  /**
   * Subscribe to timeline change notifications. The listener is fired
   * when the timeline version changes; the listener implementation
   * SHOULD trigger a re-render (e.g., via setState) in components that
   * depend on timeline state.
   */
  subscribe(listener: () => void): Unsubscribe;
}

export interface TimelineSnapshot {
  readonly entries: readonly TimelineEntrySummary[];
  /** Monotonic version stamp. Used for memoization. */
  readonly version: number;
}

export interface TimelineEntrySummary {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
  /** Epoch ms. */
  readonly timestamp: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Knob bridge
// ============================================================================

/**
 * Model-visible, reactive state managed by the reconciler harness.
 * The harness owns knob storage; the bridge is the read/write surface
 * for code outside React (the runtime, slash commands, the executor's
 * `set_knob` tool dispatch).
 *
 * `useKnob(id, initial)` inside a React component creates a binding —
 * the binding is registered with the bridge on first render, and
 * subsequent `set(id, value)` calls trigger a re-render of components
 * subscribed to that id.
 */
export interface KnobBridge {
  get(id: string): unknown;
  set(id: string, value: unknown): void;
  list(): readonly KnobDescriptor[];
  /** Notify when the value at `id` changes. */
  subscribe(id: string, listener: () => void): Unsubscribe;
}

export interface KnobDescriptor {
  readonly id: string;
  readonly description?: string;
  readonly value: unknown;
  /** Standard-Schema-compliant validator (opaque to spec). */
  readonly schema?: unknown;
}

// ============================================================================
// State bridge
// ============================================================================

/**
 * Session-internal reactive state. Sibling of {@link KnobBridge}, but
 * **not model-visible** — the executor's `set_knob` tool does not reach
 * here, and `list()` returns keys for framework / debug use only.
 *
 * This is the v2 analog of v1's COM state bag (the one wrapped by
 * `useComState(key, initial)`). The session owns the bridge across
 * mounts so values survive remount; persistence is via
 * `exportSnapshot` / `importSnapshot`.
 *
 * `useSessionState<T>(key, initial)` is the React hook that wraps this
 * surface via `useSyncExternalStore` — subsequent `set(key, value)`
 * calls re-render subscribed components.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D1
 */
export interface StateBridge {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  list(): readonly string[];
  /** Notify when the value at `key` changes. */
  subscribe(key: string, listener: () => void): Unsubscribe;
  /**
   * Serialize all entries for persistence. The session writes this into
   * its snapshot; `importSnapshot` restores on hibernate-resume.
   */
  exportSnapshot(): Readonly<Record<string, unknown>>;
  /** Replace storage with the values from a prior `exportSnapshot`. */
  importSnapshot(values: Readonly<Record<string, unknown>>): void;
}

// ============================================================================
// Loop bridge
// ============================================================================

/**
 * Imperative tick control. The reactor for `useLoopControl()`.
 *
 * Components inside the reconciler can request that the loop continue
 * after the current tick, or stop after the current tick. The bridge
 * forwards these requests to the loop executor. Whether the loop
 * honors them is governed by the loop's own handler/middleware chain
 * (see `05-loop-executor.md`).
 */
export interface LoopBridge {
  /** Request another tick after the current one resolves. */
  continueAfterTick(reason?: string): void;
  /** Request loop termination after the current tick resolves. */
  stopAfterTick(reason?: string): void;
}

// ============================================================================
// Session bridge
// ============================================================================

/**
 * Snapshot view of the current session identity. Read-only.
 */
export interface SessionBridge {
  readonly id: string;
  readonly status: SessionStatus;
  readonly currentTick?: number;
  readonly executionId?: string;
}

export type SessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "hibernated"
  | "completed"
  | "failed"
  | (string & {});

// ============================================================================
// Sandbox / MCP bridge placeholders
// ============================================================================

/**
 * Placeholder. Concrete shape defined alongside the sandbox protocol.
 * `[PLACEHOLDER]` — Phase 4+.
 */
export interface SandboxBridge {
  readonly handle: unknown;
}

/**
 * Placeholder. Concrete shape defined alongside the MCP protocol.
 * `[PLACEHOLDER]` — Phase 4+.
 */
export interface MCPBridge {
  readonly servers: readonly MCPServerBridge[];
}

export interface MCPServerBridge {
  readonly id: string;
  readonly tools: readonly unknown[];
  readonly resources: readonly unknown[];
}

// ============================================================================
// Tool bridge — render-time handler registration
// ============================================================================

/**
 * The tool bridge lets reconciler-side tools register their handler
 * at render time, closing over framework-context-derived deps (React
 * Context, Angular DI, etc).
 *
 * Sessions wire this to their tool executor's `HandlerResolver`:
 *   - `register` → `HandlerResolver.register(ref, handler, validator)`
 *   - `unregister` → `HandlerResolver.unregister(ref)`
 *
 * Implementations MAY accept re-registration on the same `handlerRef`
 * (last-writer wins) — needed when a component re-renders with new
 * captured deps.
 */
export interface ToolBridge {
  register(
    handlerRef: string,
    handler: import("../data/tool-handler.js").ToolHandler,
    validator?: import("../data/validator.js").Validator,
  ): Unsubscribe;
  unregister(handlerRef: string): void;
}

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
import type { KnobsHarnessProtocol } from "./knobs-harness.js";

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
 * Extension bridges (sandbox, mcp, subscriptions, telemetry, …) attach
 * via TypeScript module augmentation from their respective packages —
 * see §"Bridge extensibility" below.
 *
 * Additional bridges MAY be added without breaking existing hooks —
 * components that reference an unsupplied bridge throw at render time,
 * surfacing a `missing-bridge` diagnostic.
 */
export interface HookBridges {
  readonly timeline: TimelineBridge;
  /**
   * Knobs are a full harness (ADR 26). `useBridges().knobs` returns a
   * `KnobsHarnessProtocol` — sync reads (get/has/list/subscribe/
   * subscribeAll) + async Operation-backed writes (set/register/
   * dispatch). The previous `KnobBridge` interface has retired.
   */
  readonly knobs: KnobsHarnessProtocol;
  readonly state: StateBridge;
  readonly data: DataBridge;
  readonly loop: LoopBridge;
  readonly session: SessionBridge;
  // Extension bridges (sandbox, mcp, subscriptions, telemetry, …) are
  // added here via TypeScript module augmentation from each extension
  // package. See "Bridge extensibility" below.
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
// Knob metadata (descriptors, value primitives)
// ============================================================================
//
// The full knob harness contract — including `set` / `register` / `dispatch`
// methods — lives in `./knobs-harness.ts` (`KnobsHarnessProtocol`). The
// types below carry the metadata shared between authors (declaring a
// knob's shape) and the harness (validating + presenting it).

/**
 * Semantic categorization of a knob's value, derived from its `valueType`
 * + constraints. Drives the model-facing `set_knob` tool description
 * and the default `<Knobs />` section formatter.
 *
 *   - `toggle`  boolean
 *   - `range`   number with `min` and/or `max`
 *   - `number`  unconstrained number
 *   - `select`  string with non-empty `options`
 *   - `text`    unconstrained string
 */
export type KnobSemanticType = "toggle" | "range" | "number" | "select" | "text";

/**
 * Primitive value cell a knob carries. Wire-safe.
 */
export type KnobValueType = "string" | "number" | "boolean";

export type KnobPrimitive = string | number | boolean;

/**
 * Descriptor payload supplied to `KnobBridge.register`. The bridge
 * synthesizes the full {@link KnobDescriptor} (which includes `id` +
 * current `value`) from this payload.
 *
 * All fields are optional. Validation MAY rely on whichever subset the
 * caller supplied — the bridge does not enforce shape consistency
 * beyond what's declared. v1 parity field-for-field (see
 * `packages/core/src/hooks/knob.ts`).
 */
export interface KnobRegistration {
  readonly description?: string;
  readonly defaultValue?: KnobPrimitive;
  readonly valueType?: KnobValueType;
  /** Logical grouping for batch dispatch via `set_knob(group, value)`. */
  readonly group?: string;
  /** Enum constraint. The model's `set_knob` tool surfaces these as options. */
  readonly options?: readonly KnobPrimitive[];
  /** Inclusive lower bound (number knobs). */
  readonly min?: number;
  /** Inclusive upper bound (number knobs). */
  readonly max?: number;
  readonly step?: number;
  /** Max string length (string knobs). */
  readonly maxLength?: number;
  /** Regex pattern (string knobs); applied via `new RegExp(pattern)`. */
  readonly pattern?: string;
  readonly required?: boolean;
  /**
   * "Momentary" knob: auto-resets to `defaultValue` after the model reads
   * it. Used for one-shot triggers ("do this once") and edge-triggered
   * events. Reset semantics are owned by `useKnob` / `<Knobs />`, not
   * by the bridge.
   */
  readonly momentary?: boolean;
  /**
   * Hide this knob from the default `<Knobs />` section listing. Useful
   * for internally-managed knobs (e.g., per-message collapse state)
   * that would otherwise clutter the model's view.
   */
  readonly inline?: boolean;
  /**
   * Custom validator. Return `true` if valid, or an error message
   * string to surface to the model. Non-serializable — cross-process
   * bridges drop this field.
   */
  readonly validate?: (value: KnobPrimitive) => true | string;
  /** Standard-Schema-compliant validator (opaque to spec). */
  readonly schema?: unknown;
}

/**
 * Full descriptor returned by `KnobBridge.list`. Combines the
 * registration metadata with the current `value`.
 */
export interface KnobDescriptor extends KnobRegistration {
  readonly id: string;
  readonly value: unknown;
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

// ============================================================================
// Bridge extensibility
// ============================================================================
//
// Extension packages (`@agentick/sandbox`, `@agentick/mcp`,
// `@agentick/subscriptions`, etc.) augment {@link HookBridges} with
// their own typed slots via TypeScript module augmentation:
//
//   declare module "@agentick/spec" {
//     interface HookBridges {
//       readonly sandbox?: SandboxBridge;
//     }
//   }
//
// Adopters who install the package see the slot typed correctly; adopters
// who don't, never see it. The reconciler harness threads the bridge bag
// through unchanged — extension React components consume their slot via
// `useBridges().sandbox`.
//
// @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md

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

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

import type { ContentBlock } from "../data/content-blocks.js";
import type { Unsubscribe } from "./inbox.js";

export type { Unsubscribe };

// ============================================================================
// Aggregate
// ============================================================================

/**
 * Bundle of bridges the runtime supplies to a reconciler harness mount.
 *
 * **Per ADR 27 (modular built-ins):** this interface is intentionally a
 * minimal seed. Every harness package — built-in (timeline, knobs,
 * state, gates) and optional (sandbox, mcp, subscriptions) — registers
 * its slot via TypeScript module augmentation:
 *
 *   declare module "@agentick/spec" {
 *     interface HookBridges {
 *       readonly timeline: TimelineHarnessProtocol;
 *     }
 *   }
 *
 * Spec stays neutral about what's on the substrate. The harness package
 * imports its own `augment.ts` as a side effect, adding the slot to the
 * type. Adopters who import the harness package (transitively, via the
 * `agentick` metapackage or directly) see the slot typed correctly.
 *
 * The slots declared in this file are the small interface-only contracts
 * that don't have a dedicated harness package — `data`, `loop`,
 * `session`, `tools`. Anything backed by a real harness (timeline,
 * knobs, state, sandbox, ...) augments from its own package.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */
export interface HookBridges {
  /**
   * Blocking async resolution (the `useData` backbone). Reference impl
   * `InMemoryDataBridge` lives in `@agentick/reconciler-react`. The
   * interface stays in spec because it's the no-Suspense contract the
   * reconciler render loop is built against.
   */
  readonly data: DataBridge;
  /** Imperative tick control. The reactor for `useLoopControl()`. */
  readonly loop: LoopBridge;
  /** Snapshot view of the current session identity. Read-only. */
  readonly session: SessionBridge;
  /**
   * Tool registration bridge — exposed when the session's tool
   * executor is wired. Enables reconciler-side tools (e.g. the
   * React-flavored `createTool` with `use()` hook in
   * `@agentick/reconciler-react`) to register handlers at render
   * time so they close over React-Context-derived deps.
   */
  readonly tools?: ToolBridge;
  // Foundational and optional harness slots (timeline, knobs, state,
  // sandbox, mcp, ...) are added by their respective packages via
  // `declare module "@agentick/spec"` augmentation. They do NOT live in
  // this interface body — see ADR 27.
}

// ============================================================================
// SnapshotCapable — marker interface for harnesses with snapshot support
// ============================================================================

/**
 * Harnesses whose protocol extends this declare that they round-trip
 * their state through `exportSnapshot()` / `importSnapshot()`. The
 * reconciler harness iterates over `HookBridges` slots at snapshot time
 * and feature-tests for this contract; no harness-specific knowledge
 * lives in the reconciler.
 *
 * Concrete harness protocols MAY add optional parameters to
 * `importSnapshot` (e.g., a hydration mode) — adding optional
 * parameters to an inherited method is structurally compatible.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */
export interface SnapshotCapable<TSnapshot = unknown> {
  exportSnapshot(): TSnapshot;
  importSnapshot(snapshot: TSnapshot): void | Promise<void>;
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

// The `TimelineBridge` / `TimelineSnapshot` / `TimelineEntrySummary` shapes
// retired in ADR 26 Step 5a. The timeline now lives in a full harness
// (`TimelineHarnessProtocol`) and exposes the canonical `TimelineEntry[]`
// shape directly — no summary projection. See ./timeline-harness.ts.

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
// State — retired; see StateHarnessProtocol
// ============================================================================
//
// Per ADR 26, `StateBridge` was retired. The session-internal K/V
// surface is now `StateHarnessProtocol` (in `./state-harness.ts`).
// `useSessionState<T>(key, initial)` reads via `useBridges().state`
// against that harness.

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

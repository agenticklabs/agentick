/**
 * Hook bridges — runtime-provided implementations that React hooks
 * inside a compiler harness call into.
 *
 * Hooks like `useTimeline`, `useKnob`, `useData`, `useLoopControl`
 * cannot reach across the spec firewall directly — the runtime never
 * hands a React component a live `Session` object. Instead, the
 * runtime constructs *bridges* (one implementation per protocol the
 * hook needs) and passes them in via `MountInput.bridges`. The
 * compiler harness wraps the React render in a context provider
 * carrying these bridges; hooks consume them via `useContext`.
 *
 * Pluggability: any object satisfying a bridge interface can be
 * supplied. Tests pass in-memory stubs; cluster impls pass remote
 * proxies; persistent runtimes pass durable accessors. The compiler
 * harness does not know or care.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Hook bridges
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md §Hooks model
 */

import type { Unsubscribe } from "./inbox.js";
import type { ExecutorProtocol } from "./executor.js";
import type { StoreCtx } from "./store-ctx.js";
import type { LanguageModelExecutionResult } from "../data/execution-result.js";
import type { ExecutionTarget } from "../data/execution-target.js";

export type { Unsubscribe };

// ============================================================================
// Aggregate
// ============================================================================

/**
 * Bundle of bridges the runtime supplies to a compiler harness mount.
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
   * `InMemoryDataBridge` lives in `@agentick/compiler`. The
   * interface stays in spec because it's the no-Suspense contract the
   * compiler render loop is built against.
   */
  readonly data: DataBridge;
  /** Imperative tick control. The reactor for `useLoopControl()`. */
  readonly loop: LoopBridge;
  /** Snapshot view of the current session identity. Read-only. */
  readonly session: SessionBridge;
  /**
   * Tool registration bridge — exposed when the session's tool
   * executor is wired. Enables compiler-side tools (e.g. the
   * React-flavored `createTool` with `use()` hook in
   * `@agentick/compiler-react`) to register handlers at render
   * time so they close over React-Context-derived deps.
   */
  readonly tools?: ToolBridge;
  /**
   * Model registration bridge — the live side of ADR 56's tree-declared
   * per-tick model. Mirrors {@link tools} exactly: the IR carries a
   * serializable `RuntimeDeclarations.model` (`{ modelRef, parameters }`)
   * while the run-ready {@link RegisteredModel} (executor + target)
   * registers here under that `modelRef`. The loop resolves the ref per
   * tick and runs the resolved model, taking precedence over the send
   * override and the session/app default.
   *
   * Exposed when the session wires a `ModelBridge` into the mount
   * (reference impl `InMemoryModelBridge` in `@agentick/compiler`).
   * `compiler-react`'s `useModelRegistration` registers through it at
   * render time; whoever owns the adapter (the session default, the
   * deferred `<Model>` sugar) constructs the `RegisteredModel`.
   *
   * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
   */
  readonly models?: ModelBridge;
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
 * compiler harness iterates over `HookBridges` slots at snapshot time
 * and feature-tests for this contract; no harness-specific knowledge
 * lives in the compiler.
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

/**
 * Runtime feature-detection for {@link SnapshotCapable}. The composition
 * root (the session harness's snapshot/restore fold, the compiler
 * harness's mount snapshot) scans a bridge bag and picks up any slot that
 * duck-types to the contract — no hardcoded slot names, per ADR 27. A
 * harness need only expose `exportSnapshot` + `importSnapshot` (declaring
 * `SnapshotCapable<T>` on its protocol is the typed way; a bare duck-type
 * like `InMemoryDataBridge` still works).
 *
 * Sibling to {@link isChannelSnapshotProvider} in `../data/channels.ts`.
 */
export function isSnapshotCapable(x: unknown): x is SnapshotCapable {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as { exportSnapshot?: unknown }).exportSnapshot === "function" &&
    typeof (x as { importSnapshot?: unknown }).importSnapshot === "function"
  );
}

// ============================================================================
// CheckpointCapable — the leaf hook for store-backed harnesses
// ============================================================================

/**
 * What a checkpoint hook receives: the store scope key, the epoch stamp a
 * store SHOULD record so a skewed resume is diagnosable, the store-call
 * context, and the deadline a shutdown flush honors. There is deliberately
 * no `reason` — a hook that can see its trigger flushes differently per
 * trigger, and the single-recovery-path guarantee dies at the leaves.
 *
 * @see docs/proposals/v2/checkpointing.md §3.2
 */
export interface PersistCtx {
  readonly sessionId: string;
  readonly tick: number;
  readonly storeCtx: StoreCtx;
  readonly signal?: AbortSignal;
}

/** The hydrate-side twin of {@link PersistCtx}. */
export interface HydrateCtx {
  readonly sessionId: string;
  readonly tick: number;
  readonly storeCtx: StoreCtx;
  readonly signal?: AbortSignal;
}

/**
 * A harness that owns its durable state in its OWN store. `persist` flushes
 * write-behind to that store; `hydrate` loads the latest for the session
 * scope. No value crosses the seam — the composition root sequences the
 * fan-out and never sees harness state.
 *
 * A rejected `persist` aborts the caller's operation (a failed flush must
 * never be followed by an unmount); a rejected `hydrate` fails the resume.
 *
 * Feature-detected exactly as {@link SnapshotCapable}, which it supersedes.
 *
 * @see docs/proposals/v2/checkpointing.md §3.2
 */
export interface CheckpointCapable {
  persist(ctx: PersistCtx): Promise<void>;
  hydrate(ctx: HydrateCtx): Promise<void>;
}

/** Runtime feature-detection for {@link CheckpointCapable}. */
export function isCheckpointCapable(x: unknown): x is CheckpointCapable {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as { persist?: unknown }).persist === "function" &&
    typeof (x as { hydrate?: unknown }).hydrate === "function"
  );
}

/**
 * What a branch hook receives: the SOURCE session's id alongside the usual
 * checkpoint scope. The harness derives both scopes by its own composition
 * rule and copies at the store layer — no data crosses the seam.
 */
export interface BranchCtx extends HydrateCtx {
  readonly fromSessionId: string;
}

/**
 * A store-backed harness that can branch its scope — the fork transport
 * (checkpointing §5). `branch` copies the source scope's records onto this
 * harness's own scope in its OWN store (composable from read + append; a
 * store MAY override with a native copy), then leaves the projection as a
 * subsequent `hydrate` would find it. A harness without durable state simply
 * does not implement it.
 *
 * @see docs/proposals/v2/checkpointing.md §5
 */
export interface BranchCapable {
  branch(ctx: BranchCtx): Promise<void>;
}

/** Runtime feature-detection for {@link BranchCapable}. */
export function isBranchCapable(x: unknown): x is BranchCapable {
  return (
    x !== null && typeof x === "object" && typeof (x as { branch?: unknown }).branch === "function"
  );
}

// ============================================================================
// Data bridge — the no-Suspense contract
// ============================================================================

/**
 * Blocking async-data resolution for the compiler render loop.
 *
 * **Critical contract: this is NOT React Suspense.**
 *
 * The compiler does not use `<Suspense>` boundaries and does not
 * surface "loading" states in the rendered IR. Every `RenderedTree`
 * produced by the harness reflects a fully-resolved view of the
 * application.
 *
 * **Compiler-agnostic by design.** The protocol splits cache access
 * (`peek`) from fetch initiation (`fetch`) so each compiler can
 * compose them into its idiom:
 *
 *   - React: `useData` throws the pending Promise (Suspense-like).
 *   - Angular: convert to Observable via `from(promise)` or RxJS.
 *   - Signal-based: subscribe and re-evaluate the derived signal on
 *     cache change.
 *
 * Mechanics:
 *
 *   1. `peek(key)` returns the entry's current state — a tagged
 *      `DataEntry` (`value` / `pending` / `error`) — or `undefined`
 *      if no entry exists for `key`. Synchronous; allocates one
 *      tagged object per call.
 *   2. `fetch(key, fetcher)` initiates a fetch if no entry exists,
 *      joins the in-flight Promise if pending, or returns a resolved
 *      Promise of the cached value if already fulfilled. Always
 *      returns a Promise.
 *   3. `subscribe(key, listener)` notifies on any entry state change
 *      (value, pending, error). Used by compilers that need to
 *      re-render on cache mutation.
 *   4. When a fetcher rejects, the rejection is cached for that key.
 *      The next `peek(key)` returns `{ kind: "error", error }`. The
 *      next `fetch(key, …)` returns the rejected Promise of the
 *      cached error.
 *
 * Implementations:
 *   - In-memory: a `Map<key, Entry>` where Entry tracks
 *     pending Promise / fulfilled value / rejected error.
 *   - Durable: write-through to a persistent KV; the cache survives
 *     hibernation via `CompilerSnapshot.dataCache`.
 *
 * Implementations MUST be deterministic on repeated keys within one
 * mount session — same key → same fetcher → same cached value.
 */
export interface DataBridge {
  /**
   * Snapshot probe — returns the entry's current cache state for
   * `key`, or `undefined` when no entry exists. Synchronous. Allocates
   * one `DataEntry<T>` object per call (the tagged shape).
   */
  peek<T>(key: string): DataEntry<T> | undefined;

  /**
   * Initiate (or join) a fetch for `key`. Behavior:
   *
   *   - No entry exists → call `fetcher()`, cache the promise as
   *     pending, return the promise.
   *   - Entry is `pending` → return the in-flight promise (the
   *     supplied `fetcher` is ignored; idempotent on key).
   *   - Entry is `value` → return a resolved promise of the cached
   *     value (`fetcher` ignored).
   *   - Entry is `error` → return a rejected promise of the cached
   *     error (`fetcher` ignored).
   *
   * Invalidate via `invalidate(key)` first to force a re-fetch.
   */
  fetch<T>(key: string, fetcher: () => Promise<T>, options?: DataResolveOptions): Promise<T>;

  /**
   * Notify when the entry for `key` changes state (value / pending /
   * error / invalidated). Compilers use this to trigger re-render
   * on cache mutation. Returns an unsubscribe function.
   */
  subscribe(key: string, listener: () => void): Unsubscribe;

  /** Invalidate a cache entry. Next `fetch(key, …)` re-fetches. */
  invalidate(key: string): void;

  /** Invalidate every entry whose `tag` matches. */
  invalidateTag(tag: string): void;

  /** Cache probe (does not start a fetch). True iff a fresh `value` entry exists. */
  has(key: string): boolean;
}

/**
 * Tagged-union shape returned by {@link DataBridge.peek}. Compilers
 * dispatch on `kind` to translate cache state into their own
 * async idiom (throw for React Suspense, wrap in Observable for
 * Angular, etc.).
 */
export type DataEntry<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "pending"; readonly promise: Promise<T> }
  | { readonly kind: "error"; readonly error: unknown };

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
 * + constraints. Drives the model-facing `knob_set` tool description
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
  /** Logical grouping for batch dispatch via `knob_set(group, value)`. */
  readonly group?: string;
  /** Enum constraint. The model's `knob_set` tool surfaces these as options. */
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
   * Model-visible but not model-settable. The knob renders in the
   * `<Knobs />` section (with a `read-only` hint) so the model can read
   * the state, but the `knob_set` dispatch pipeline rejects writes by
   * name and skips it in group writes. Only application code mutates it
   * (via `harness.set` / the `useKnob` setter). Verified gates rely on
   * this to keep their state unforgeable.
   */
  readonly readOnly?: boolean;
  /**
   * Custom validator. Return `true` if valid, or an error message
   * string to surface to the model. Non-serializable — cross-process
   * bridges drop this field.
   */
  readonly validate?: (value: KnobPrimitive) => true | string;
  /**
   * Standard-Schema-compliant validator. Accepts Zod / Valibot /
   * ArkType / raw-via-`jsonSchema()` — any library that implements
   * the `StandardSchemaV1` contract. Used for richer validation
   * than the field-level constraints above can express.
   */
  readonly schema?: import("../data/standard-schema.js").StandardSchemaV1;
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
 * Components inside the compiler can request that the loop continue
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
  /**
   * Running, but blocked on a human — at least one elicitation is outstanding.
   * Distinct from `paused`, which is reserved for an operator explicitly
   * pausing a session: a UI needs to tell "someone stopped this" apart from
   * "someone needs to answer something". Named for the tasks harness's
   * `input_required`, which is the same state one level down.
   */
  | "input_required"
  | "paused"
  /**
   * Paged out — the live harness is gone but the session is not over. Written
   * by `session.close({ reason: "evicted" })`, which is what the app's memory
   * cap and idle sweep pass. A resume brings it back to `idle`; the store's
   * prune sweep passes over it.
   */
  | "hibernated"
  | "completed"
  | "failed"
  /** Hung up. The durable record survives as history; the session does not. */
  | "closed"
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
// who don't, never see it. The compiler harness threads the bridge bag
// through unchanged — extension React components consume their slot via
// `useBridges().sandbox`.
//
// @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md

// ============================================================================
// Tool bridge — render-time handler registration
// ============================================================================

/**
 * The tool bridge lets compiler-side tools register their handler
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

// ============================================================================
// Model bridge — render-time model registration (ADR 56)
// ============================================================================

/**
 * The resolved, run-ready model a `modelRef` maps to. Both fields are
 * already spec types, so the loop executor and `compiler-react` thread
 * a `RegisteredModel` WITHOUT importing `@agentick/model` — the spec
 * firewall holds. Post-ADR-52 there is ONE executor that consumes an
 * adapter, so a "per-model executor" is just that one executor
 * constructed with that model's adapter; whoever owns the adapter builds
 * the `RegisteredModel` and registers it.
 *
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 */
export interface RegisteredModel {
  readonly modelExecutor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  readonly target: ExecutionTarget;
}

/**
 * The live side of ADR 56 — the exact analogue of {@link ToolBridge}
 * (`handlerRef` in the IR ↔ live handler on the bridge). Maps a
 * serializable `modelRef` (carried in `RuntimeDeclarations.model`) to a
 * live {@link RegisteredModel}. The loop's `resolveModel` closes over an
 * instance and looks the ref up per tick.
 *
 * Implementations MAY accept re-registration on the same `modelRef`
 * (last-writer wins) — needed when a component re-renders with a new
 * captured model value.
 *
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 */
export interface ModelBridge {
  register(modelRef: string, model: RegisteredModel): Unsubscribe;
  unregister(modelRef: string): void;
  resolve(modelRef: string): RegisteredModel | undefined;
}

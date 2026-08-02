/**
 * CompilerHarness — Layer C.
 *
 * Concrete `BaseHarness<"compiler">` subclass implementing the
 * `CompilerProtocol`. One harness owns one container per mount; the
 * harness multiplexes over an internal `Map<mountId, MountState>` so a
 * single CompilerHarness instance can host multiple concurrent
 * mounts (e.g., multiple sessions on the same process).
 *
 * This first cut implements the synchronous render path:
 *   mount → store element + bridges
 *   renderTree → render synchronously, collect, return RenderedTree
 *
 * The render-until-stable loop (catching thrown Promises from
 * `useData`, awaiting them, re-rendering) is added next.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md
 */

import React, { type ReactNode } from "react";
import { omitUndefined } from "@agentick/utils";

import { Effect } from "effect";
import { runHarnessProtocol, ulid } from "@agentick/runtime";
import type {
  CollectTreeInterceptorsInput,
  DispatchLifecycleInput,
  EventBus,
  HookBridges,
  LifecycleProjectionTarget,
  Middleware,
  TreeInterceptionSource,
  MessageEnvelope,
  MessageHandlerError,
  MountInput,
  MountResult,
  OperationJournal,
  Operation,
  MessageInbox,
  ReconcileDiagnostic,
  ReconcileErrorChannel,
  CompilerFx,
  CompilerInboxMessage,
  CompilerProtocol,
  CompilerSnapshot,
  RenderContext,
  RenderTreeInput,
  RenderTreeResult,
  RenderToStringInput,
  RenderToStringResult,
  RerenderInput,
  RestoreInput,
  SnapshotInput,
  SubstrateError,
  UnmountInput,
} from "@agentick/spec";
import {
  AlreadyMounted,
  HandlerError,
  NotMounted,
  ReconcileError,
  RenderFailed,
  SPEC_VERSION,
} from "@agentick/spec";
import { BaseHarness } from "@agentick/runtime";

import {
  builtInToolsProjection,
  collect,
  CommandInterceptorRegistry,
  ContributorRegistry,
  createBuiltInRegistry,
  createContainer,
  createHostScope,
  InMemoryDataBridge,
  LifecycleDispatch,
  type Contributor,
  type DefaultProjection,
  type HostScope,
  type CompilerContainer,
} from "@agentick/compiler";
import {
  mcpServerInfoDefaultProjection,
  resourcesDefaultProjection,
  timelineDefaultProjection,
} from "./default-projections.js";
import { createCompiler, type FiberRoot, type Compiler } from "../react/compiler.js";
import { BridgeContext } from "../react/bridge-context.js";
import { LifecycleContext } from "../react/lifecycle-context.js";
import { InterceptorContext } from "../react/interceptor-context.js";
import { RenderContextContext } from "../react/render-context-context.js";
import {
  builtInFormatters,
  describeUnresolvedFormatter,
  formatTree,
  markdownFormatter,
  refOf,
  resolveFormatterRef,
  type DefinedFormatter,
  type FormatterResolution,
} from "@agentick/formatters";

// ADR 80/83 — light up the compile verb. `compiler:render-tree` (op
// `compiler:command:render-tree`) already routes through `runOperation`
// (see `renderTreeFx`), so typing it here mints `onBeforeCompilerRenderTree`
// / `onAfterCompilerRenderTree` on the derived `CommandHooks` surface. Input
// is the render request; output the settled `RenderTreeResult` — the exact
// generics of the `renderTreeFx` Operation below.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "compiler:render-tree": { input: RenderTreeInput; output: RenderTreeResult };
    // The remaining compile verbs (ADR 80/83). `mount` / `rerender` /
    // `render-to-string` each build a hand-rolled Operation and route through
    // `runOperation`, so typing them mints `onBefore/After<Verb>` on
    // `CommandHooks`. Generics are the declaration sites'.
    //
    // `compiler:unmount` is DELIBERATELY absent: its method is a plain
    // synchronous teardown that does NOT route through `runOperation`, so a
    // typed hook would never fire (misleading). It stays `mechanism`/deferred
    // until the teardown is wrapped.
    "compiler:mount": { input: MountInput; output: MountResult };
    "compiler:rerender": { input: RerenderInput; output: void };
    "compiler:render-to-string": { input: RenderToStringInput; output: RenderToStringResult };
  }
}

interface MountState {
  readonly mountId: string;
  element: ReactNode;
  elementVersion?: string;
  readonly bridges: HookBridges;
  readonly container: CompilerContainer;
  readonly compiler: Compiler;
  readonly root: FiberRoot;
  readonly registry: ContributorRegistry;
  readonly rootScope: HostScope;
  readonly lifecycle: LifecycleDispatch;
  /**
   * Per-mount registry of the tree's IN-PATH interceptors (ADR 89 §4) —
   * the `useGuardToolDispatch` / `useTransform*` / `useCommandInterceptor`
   * hooks land tagged `Middleware`s here, keyed by op tag. The session's
   * per-send forwarder pulls it via `collectTreeInterceptors`.
   */
  readonly commandInterceptors: CommandInterceptorRegistry;
  /** Current render's RenderContext envelope (ADR 54 / 55) — refreshed
   *  each render from Mount/RenderTree input; provided synchronously via
   *  RenderContextContext. */
  renderContext: RenderContext | null;
  /**
   * Captures the first render error surfaced via the host config's
   * `onUncaughtError` callback. Cleared at the start of each render
   * iteration. Set when a component throws a non-Promise error (real
   * bugs, missing-bridge errors, etc.).
   */
  renderError: unknown;
  /**
   * Set when the host config's `onCaughtError` fires, which React
   * triggers when an in-tree `<ErrorBoundary>` (class component
   * componentDidCatch) catches a render error. Drives the
   * `error-boundary-active` info diagnostic.
   *
   * NOT reset per iteration — React fires `onCaughtError` once per
   * caught error, typically during mount. Subsequent renders of the
   * now-in-caught-state boundary don't re-fire. Consumed (cleared)
   * when the diagnostic is emitted.
   */
  errorBoundaryFiredInLastRender: boolean;
}

export interface CompilerHarnessOptions {
  /** Override the built-in contributor set with caller-supplied registry. */
  readonly registry?: ContributorRegistry;
  /**
   * Override the built-in formatter set. Keyed by `FormatterRef.id`. When
   * omitted, the markdown / xml / text reference formatters from
   * `@agentick/formatters` are pre-loaded.
   *
   * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2
   */
  readonly formatters?: ReadonlyMap<string, DefinedFormatter>;
  /**
   * `FormatterRef.id` to dispatch when an entry doesn't pin its own
   * formatter (no `renderedWith` field). Defaults to the markdown
   * formatter's id — markdown is the path of least surprise for LLM
   * input.
   */
  readonly defaultFormatterId?: string;
}

/**
 * Default cap on render-until-stable iterations. Exceeding this means a
 * component is requesting data that can't settle (probably a bug —
 * e.g., `useData` calls that depend on each other unboundedly).
 */
const DEFAULT_MAX_ITERATIONS = 10;

/** Shared frozen empty for `collectTreeInterceptors` on an absent mount. */
const EMPTY_INTERCEPTORS: readonly Middleware<unknown, unknown, unknown>[] = Object.freeze([]);

export class CompilerHarness
  extends BaseHarness<"compiler">
  implements CompilerProtocol, LifecycleProjectionTarget, TreeInterceptionSource
{
  private readonly mounts = new Map<string, MountState>();
  private readonly registry: ContributorRegistry;
  private readonly formatters: ReadonlyMap<string, DefinedFormatter>;
  private readonly defaultFormatterId: string;
  /** `defaultFormatterId` as a ref — the root scope's binding when a mount pins none. */
  private readonly defaultFormatterRef: import("@agentick/spec").FormatterRef;
  /**
   * Mount IDs that have already produced a Suspense heuristic warning.
   * One warning per mount — rerendering with the same Suspense tree
   * shouldn't flood stderr.
   */
  private readonly suspenseWarnedMounts = new Set<string>();

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: CompilerHarnessOptions = {},
  ) {
    super("compiler", scopeId, journal, bus, inbox);
    this.registry = options.registry ?? createBuiltInRegistry();
    this.formatters = options.formatters ?? builtInFormatters();
    this.defaultFormatterId = options.defaultFormatterId ?? markdownFormatter.__identity.id;
    const registeredDefault = this.formatters.get(this.defaultFormatterId);
    this.defaultFormatterRef =
      registeredDefault !== undefined ? refOf(registeredDefault) : { id: this.defaultFormatterId };
  }

  // ──────────────────────── Contributor registration ────────────────────────

  registerContributor(contributor: Contributor): void {
    this.registry.register(contributor);
  }

  // ──────────────────────── CompilerProtocol ────────────────────────

  mount(input: MountInput): Promise<MountResult> {
    // HAND-BUILT by doctrine (ADR 51 §1.2): MountInput carries a live
    // React element + the HookBridges bag — non-serializable input can
    // never be a declared command. Also preserves the deterministic
    // mountId-keyed idempotency opId the registry (ulid-minted) can't.
    const op: Operation<MountInput, MountResult> = {
      opId: input.opId ?? `compiler:mount:${input.mountId}`,
      surface: "compiler",
      name: "compiler:command:mount",
      scope: { sessionId: input.sessionId, executionId: input.executionId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({ try: () => this.mountBody(i), catch: (e: unknown) => e }),
      ),
    );
  }

  rerender(input: RerenderInput): Promise<void> {
    // Resolve scope synchronously — if the mount doesn't exist, surface
    // NotMounted as a Promise rejection (callers `.rejects.toMatchObject`).
    return runHarnessProtocol(
      Effect.suspend(() => {
        const state = this.tryMountState(input.mountId);
        if (!state) {
          return Effect.fail(new NotMounted({ mountId: input.mountId }));
        }
        // HAND-BUILT by doctrine (ADR 51 §1.2): RerenderInput carries a
        // live React element — non-serializable input can never be a
        // declared command.
        const op: Operation<RerenderInput, void> = {
          opId: input.opId ?? `compiler:rerender:${input.mountId}`,
          surface: "compiler",
          name: "compiler:command:rerender",
          scope: { sessionId: state.bridges.session.id },
          input,
        };
        return this.runOperation(op, (i) =>
          Effect.sync(() => {
            state.element = i.element as ReactNode;
            if (i.elementVersion !== undefined) state.elementVersion = i.elementVersion;
            this.renderOnce(state);
            this.maybeWarnSuspense(i.element);
          }),
        );
      }),
    );
  }

  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * loop reaches `compiler.fx.renderTree(...)` to compose the render
   * into one fiber tree (Stage 3); the plain `renderTree(...)` Promise
   * below is the derived facade. Both drive the SAME Operation.
   */
  get fx(): CompilerFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      renderTree: (input) => this.renderTreeFx(input),
    };
  }

  /**
   * The composable `renderTree` Effect the harness builds — the
   * `.fx.renderTree` twin. Returns the `runOperation(op, body)` Effect
   * un-run, so an in-process caller stays in one fiber. {@link renderTree}
   * is the facade. Failures inhabit the compiler's error taxonomy:
   * `NotMounted` (guard) and `RenderFailed` ({@link renderTreeBody} throws
   * it on render error); any other throw is wrapped in `RenderFailed`.
   */
  private renderTreeFx(
    input: RenderTreeInput,
  ): Effect.Effect<RenderTreeResult, ReconcileErrorChannel | SubstrateError, never> {
    return Effect.suspend(() => {
      const state = this.tryMountState(input.mountId);
      if (!state) {
        return Effect.fail(new NotMounted({ mountId: input.mountId }));
      }
      // HAND-BUILT — NOT by §1.2 doctrine (payload is JSON-shaped) but
      // by registry shape: per-input scope (mountId →
      // state.bridges.session.id + input.executionId) vs the nullary
      // command-scope fn; caller-supplied `input.opId` idempotency vs
      // registry-minted `${verb}:${ulid()}`; and the existing
      // "compiler:render:" opId prefix can't coexist with the
      // derived "compiler:command:render-tree" op name (the registry
      // derives both from one verb string). See the ADR-51 note above
      // handleMessage.
      const op: Operation<RenderTreeInput, RenderTreeResult, ReconcileErrorChannel> = {
        opId: input.opId ?? `compiler:render:${input.mountId}:${ulid()}`,
        surface: "compiler",
        name: "compiler:command:render-tree",
        scope: {
          sessionId: state.bridges.session.id,
          executionId: input.executionId,
        },
        input,
      };
      return this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.renderTreeBody(i, state),
          // renderTreeBody throws typed `RenderFailed` on render error;
          // pass typed compiler errors through, wrap anything else so the
          // `E` channel stays the compiler taxonomy.
          catch: (e: unknown): ReconcileErrorChannel =>
            e instanceof ReconcileError
              ? (e as ReconcileErrorChannel)
              : new RenderFailed({ cause: e }),
        }),
      );
    });
  }

  renderTree(input: RenderTreeInput): Promise<RenderTreeResult> {
    return runHarnessProtocol(this.renderTreeFx(input));
  }

  renderToString(input: RenderToStringInput): Promise<RenderToStringResult> {
    return runHarnessProtocol(
      Effect.suspend(() => {
        const state = this.tryMountState(input.mountId);
        if (!state) {
          return Effect.fail(new NotMounted({ mountId: input.mountId }));
        }
        // HAND-BUILT: same registry-shape blockers as renderTree above
        // (nullary command-scope fn can't resolve the per-mount
        // sessionId, caller-supplied `input.opId` would be dropped,
        // NotMounted must fail before an Operation exists).
        const op: Operation<RenderToStringInput, RenderToStringResult> = {
          opId: input.opId ?? `compiler:render-to-string:${input.mountId}:${ulid()}`,
          surface: "compiler",
          name: "compiler:command:render-to-string",
          scope: { sessionId: state.bridges.session.id },
          input,
        };
        return this.runOperation(op, (i) =>
          Effect.tryPromise({
            try: () => this.renderToStringBody(i, state),
            catch: (e: unknown) => e,
          }),
        );
      }),
    );
  }

  /**
   * `LifecycleProjectionTarget` (ADR 89 §4) — route ONE projected
   * lifecycle event to this mount's registered `useOn*` handlers. The
   * events come from the SESSION's command-hook forwarders
   * (`loop:run-execution` / `loop:tick` / `tool:dispatch` /
   * `model:generate[_stream]`); this harness owns no feed of its own.
   * Handler throws are isolated inside the per-mount dispatch; a
   * missing mount rejects `NotMounted` (the forwarders only route to
   * their own live mount).
   */
  async dispatchLifecycle(input: DispatchLifecycleInput): Promise<void> {
    const state = this.tryMountState(input.mountId);
    if (!state) throw new NotMounted({ mountId: input.mountId });
    await state.lifecycle.dispatch(input.event);
  }

  /**
   * `TreeInterceptionSource` (ADR 89 §4) — return the in-path interceptors
   * (`guard` / `transform`) this mount's tree currently registers for
   * `command` (an op tag, `ctx.op`). The SESSION's per-send forwarder pulls
   * this at every operation, orders the result guards-outermost, and
   * composes it around the op body. A PULL, not a push: an unmounted mount
   * (torn down mid-execution) yields `[]`, so a stale registration never
   * fires — the unmount-safety contract, for free.
   */
  collectTreeInterceptors(
    input: CollectTreeInterceptorsInput,
  ): readonly Middleware<unknown, unknown, unknown>[] {
    const state = this.tryMountState(input.mountId);
    if (!state) return EMPTY_INTERCEPTORS;
    return state.commandInterceptors.collect(input.command);
  }

  async unmount(input: UnmountInput): Promise<void> {
    const state = this.mounts.get(input.mountId);
    if (!state) return;
    state.lifecycle.clear();
    state.commandInterceptors.clear();
    state.container.children.length = 0;
    this.mounts.delete(input.mountId);
    this.suspenseWarnedMounts.delete(input.mountId);
  }

  async snapshot(input: SnapshotInput): Promise<CompilerSnapshot> {
    const state = this.mountState(input.mountId);
    // Per ADR 27: bridge state is captured generically by iterating
    // every slot on `HookBridges` and feature-testing for
    // `SnapshotCapable`. No harness-specific knowledge in the
    // compiler. Component-local hook state (raw `useState` /
    // `useReducer`) is NOT captured by design — see ADR 22 §D1.
    // Components persisting state across hibernation use
    // `useSessionState(key, initial)` to land values in the StateHarness.
    const bridges = captureBridgeSnapshots(state.bridges);
    const dataCache =
      state.bridges.data instanceof InMemoryDataBridge ? state.bridges.data.exportSnapshot() : [];
    return {
      specVersion: SPEC_VERSION,
      mountId: state.mountId,
      ...omitUndefined({ elementVersion: state.elementVersion }),
      bridges: bridges as CompilerSnapshot["bridges"],
      dataCache,
      subscriptions: [],
    };
  }

  async restore(input: RestoreInput): Promise<void> {
    const state = this.mounts.get(input.mountId);
    if (!state) return;
    if (input.elementVersion !== undefined) state.elementVersion = input.elementVersion;
    // Apply bridge state from the snapshot before the next renderTree.
    if (state.bridges.data instanceof InMemoryDataBridge) {
      state.bridges.data.importSnapshot(input.snapshot.dataCache);
    }
    await applyBridgeSnapshots(state.bridges, input.snapshot.bridges);
  }

  // ──────────────────────── inbox dispatch ────────────────────────

  // ADR 51 status — ZERO compiler verbs are declarable commands today;
  // every Operation literal in this file stays hand-built. Per verb:
  //
  //  - mount / rerender: input carries a live React element (and, for
  //    mount, the HookBridges bag) — non-serializable input is
  //    unaddressable by doctrine (ADR 51 §1.2). Permanent.
  //  - renderTree / renderToString: JSON-shaped payloads, but blocked by
  //    the registry's current shape. (a) Scope must be resolved per
  //    input (mountId → state.bridges.session.id + input.executionId) —
  //    this harness multiplexes mounts, so scopeId is NOT a sessionId
  //    and the nullary `scope: () => EventScope` idiom that carried the
  //    state/timeline/knobs migrations cannot reproduce it. (b) The
  //    MountScopedInput caller-supplied `opId` idempotency contract
  //    would be silently dropped — the registry always mints
  //    `${verb}:${ulid()}`. (c) NotMounted resolves BEFORE the Operation
  //    is built (a missing mount journals no envelopes); the registry
  //    path would journal requested → failed pairs.
  //  - recompile / unmount / invalidate (this switch): the spec-frozen
  //    `CompilerInboxMessage` wire types are UNPREFIXED, while
  //    `this.command()` hard-requires `${surface}:`-prefixed verbs and
  //    `dispatchMessage` routes by exact `msg.type` — migrating them is
  //    a spec wire-type rename, i.e. a wire-shape change. Additionally,
  //    `invalidate` is deliberately NOT an Operation (sync cache poke,
  //    zero envelopes) and `recompile` is not 1:1 with renderTree (it
  //    synthesizes `sessionId: ""`).
  //
  // TODO(adr-51-wave): unblock renderTree/renderToString by extending
  // BaseHarness.command with input-aware scope (`scope?: (input: I) =>
  // EventScope`) + caller-opId passthrough; unblock this switch by
  // renaming the CompilerInboxMessage types to `compiler:`-prefixed
  // canonical verbs in spec-next. Both are cross-package contract
  // changes — out of scope for a single-harness migration.
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const m = msg as MessageEnvelope<CompilerInboxMessage | undefined>;
    const payload = m.payload;
    if (!payload) return Effect.succeed(undefined);
    switch (payload.type) {
      case "recompile":
        return Effect.tryPromise({
          try: () => this.renderTree({ mountId: payload.mountId, sessionId: "" }),
          catch: (cause): MessageHandlerError => new HandlerError({ cause }),
        });
      case "unmount":
        return Effect.tryPromise({
          try: () => this.unmount({ mountId: payload.mountId }),
          catch: (cause): MessageHandlerError => new HandlerError({ cause }),
        });
      case "invalidate":
        return Effect.sync(() => this.handleInvalidate(payload));
      default:
        return Effect.fail(new HandlerError({ cause: new Error("unknown compiler message type") }));
    }
  }

  // ──────────────────────── internals ────────────────────────

  private async mountBody(input: MountInput): Promise<MountResult> {
    if (this.mounts.has(input.mountId)) {
      throw new AlreadyMounted({ mountId: input.mountId });
    }
    const rootScope = createHostScope({
      // No caller ref → the harness's OWN default, named honestly. The
      // library-level sentinel (`{ id: "default" }`) would resolve to the same
      // formatter, but it names a formatter that isn't registered, so every
      // entry inheriting it would look like an unresolved request.
      formatter: input.defaultFormatter ?? this.defaultFormatterRef,
      path: [`mount:${input.mountId}`],
    });
    const container = createContainer({ mountId: input.mountId, rootScope });
    // We need a mutable handle to the future MountState so the
    // host-config error callbacks can write `renderError` on it. The
    // state object is constructed first, then the compiler is
    // attached.
    const state: MountState = {
      mountId: input.mountId,
      element: input.element as ReactNode,
      ...omitUndefined({ elementVersion: input.elementVersion }),
      bridges: input.bridges,
      container,
      compiler: null as unknown as Compiler,
      root: null as unknown as FiberRoot,
      registry: this.registry,
      rootScope,
      lifecycle: new LifecycleDispatch(),
      commandInterceptors: new CommandInterceptorRegistry(),
      renderContext: input.renderContext ?? null,
      renderError: null,
      errorBoundaryFiredInLastRender: false,
    };
    const compiler = createCompiler({
      container,
      idPrefix: input.mountId,
      onUncaughtError: (err) => {
        // Only retain the first render error per iteration; subsequent
        // errors during the same render are typically cascades.
        if (state.renderError === null) state.renderError = err;
      },
      onCaughtError: () => {
        // Fires when an in-tree <ErrorBoundary> (getDerivedStateFromError /
        // componentDidCatch) catches a render error. The boundary
        // handles fallback rendering; we just flag so the loop can
        // surface an `error-boundary-active` info diagnostic.
        state.errorBoundaryFiredInLastRender = true;
      },
      onRecoverableError: () => {
        // React 19 emits these for non-fatal issues (hydration mismatch,
        // missing keys, etc.). No-op here — they're advisory.
      },
    });
    (state as { compiler: Compiler }).compiler = compiler;
    (state as { root: FiberRoot }).root = compiler.createRoot();
    this.mounts.set(input.mountId, state);

    // Apply snapshot BEFORE the initial render so useData / useKnob /
    // useSessionState hooks see restored values on first invocation.
    const restoredFromSnapshot = input.snapshot !== undefined;
    if (input.snapshot) {
      if (state.bridges.data instanceof InMemoryDataBridge) {
        state.bridges.data.importSnapshot(input.snapshot.dataCache);
      }
      await applyBridgeSnapshots(state.bridges, input.snapshot.bridges);
    }

    // First render — populates the host tree and lets sync components
    // commit. With a restored snapshot, useData hits cached values
    // immediately (no fetch starts on first render).
    this.renderOnce(state);
    // ADR 54 (a) — flush passive effects so useEffect-registered
    // lifecycle listeners (useOnTickEnd, useContextInfo, …) are LIVE
    // before the first tick dispatches. Without this the whole useOn*
    // family is inert in production (render() leaves effects scheduled
    // on the Scheduler, not run).
    state.compiler.flushPassiveEffects();

    // Suspense heuristic — warn the FIRST time we see a `<Suspense>`
    // boundary in the input element tree. The DataBridge contract is
    // explicitly no-Suspense (`docs/proposals/v2/blueprint/03`), so a
    // user-authored Suspense boundary will render its fallback into the
    // IR with no way for us to clean that up. Warn loudly once.
    this.maybeWarnSuspense(input.element);

    return { mountId: input.mountId, restoredFromSnapshot };
  }

  /**
   * @param pinned - When set, this formatter renders EVERY entry, whatever
   *   `renderedWith` says. `renderToString({ formatter })` uses it: the caller
   *   asked for one dialect for the whole output, and a dialect now decides
   *   how sections read, so it has to be in force during the block pass
   *   rather than applied to blocks another dialect already lowered.
   */
  private async renderTreeBody(
    input: RenderTreeInput,
    state: MountState,
    pinned?: DefinedFormatter,
  ): Promise<RenderTreeResult> {
    // ADR 54 / 55 — refresh the current render's RenderContext envelope
    // BEFORE rendering, so useContextInfo / useRenderContext read THIS
    // render's facts synchronously while the IR is produced.
    if (input.renderContext !== undefined) state.renderContext = input.renderContext;
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const diagnostics: ReconcileDiagnostic[] = [];
    let iterations = 0;
    let hitMax = false;

    // Track whether boundary diagnostics have been emitted this call —
    // we report at most one of each kind per renderTree, not one per
    // ErrorBoundary diagnostic is emitted at most once per renderTree.
    let errorBoundaryEmitted = false;

    // Render-until-stable. The DataBridge tracks in-flight Promises
    // independently of whether React caught the throw — so the loop's
    // termination condition is "bridge has no pending fetches",
    // regardless of React's error handling for thrown Promises.
    const dataBridge = state.bridges.data;
    const isMemBridge = dataBridge instanceof InMemoryDataBridge;

    // ErrorBoundary firing during mount/initial render — emit on the
    // first renderTree.
    if (state.errorBoundaryFiredInLastRender && !errorBoundaryEmitted) {
      diagnostics.push({
        severity: "info",
        code: "error-boundary-active",
        message:
          "An in-tree <ErrorBoundary> caught a render error and rendered its fallback. The fallback content appears in the IR.",
      });
      errorBoundaryEmitted = true;
      state.errorBoundaryFiredInLastRender = false; // consume
    }

    for (iterations = 0; iterations < maxIterations; iterations++) {
      state.renderError = null;
      this.renderOnce(state);

      // Late ErrorBoundary emission — covers errors that surface
      // mid-loop (e.g., an error thrown after a useData resolves).
      if (state.errorBoundaryFiredInLastRender && !errorBoundaryEmitted) {
        diagnostics.push({
          severity: "info",
          code: "error-boundary-active",
          message:
            "An in-tree <ErrorBoundary> caught a render error and rendered its fallback. The fallback content appears in the IR.",
        });
        errorBoundaryEmitted = true;
        state.errorBoundaryFiredInLastRender = false; // consume
      }

      const pending = isMemBridge ? dataBridge.pending() : null;

      // If the render produced a real error AND no pending data
      // explains it, terminate with RenderFailed.
      if (state.renderError !== null && (pending === null || pending.length === 0)) {
        throw new RenderFailed({ cause: state.renderError });
      }

      if (pending === null) {
        // Custom DataBridge implementation without pending-tracking —
        // single-pass render. Future work: add `hasPending` to the
        // protocol so any bridge can drive the loop.
        break;
      }
      if (pending.length === 0) break;

      // Await every in-flight fetch (allSettled — failures cache as
      // rejected entries; the next render throws them synchronously
      // and the loop will see no pending and terminate). When the
      // caller supplied `awaitTimeoutMs`, race the wait against a
      // timer — exceeding the budget surfaces an `await-timeout`
      // diagnostic and terminates the loop.
      const settled = Promise.allSettled(pending);
      if (input.awaitTimeoutMs !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), input.awaitTimeoutMs);
        });
        const outcome = await Promise.race([settled.then(() => "settled" as const), timeout]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === "timeout") {
          diagnostics.push({
            severity: "warning",
            code: "await-timeout",
            message: `render-until-stable: useData await exceeded ${input.awaitTimeoutMs}ms; terminating with partial IR`,
          });
          break;
        }
      } else {
        await settled;
      }
    }

    if (iterations >= maxIterations) {
      hitMax = true;
      diagnostics.push({
        severity: "warning",
        code: "max-iterations",
        message: `render-until-stable exceeded ${maxIterations} iterations`,
      });
    }

    // One last collect against the now-stable host tree.
    //
    // Surfacing defaults (ADR 63): the compiler-agnostic `tools` default
    // plus the compiler-supplied `timeline` default (bound to THIS
    // mount's bridges). Each runs lazily — only when the tree didn't
    // override its key (a `<Timeline>` suppresses the timeline fold; a
    // `<Tools>` override, Wave 4b, would suppress tools). Absence of
    // `<Timeline>` therefore still surfaces the conversation — the
    // default-on behavior.
    const defaults: readonly DefaultProjection[] = [
      builtInToolsProjection,
      timelineDefaultProjection(state.bridges),
      // Wave 4b (ADR 62 / 63) — both read their bridge structurally
      // (no harness import) and contribute nothing when the bridge is
      // absent / empty, so mounts without resources / MCP are unaffected.
      resourcesDefaultProjection(state.bridges),
      mcpServerInfoDefaultProjection(state.bridges),
    ];
    const collected = collect({
      roots: state.container.children,
      registry: state.registry,
      rootScope: state.rootScope,
      defaults,
    });
    for (const d of collected.diagnostics) {
      diagnostics.push({
        severity: d.severity,
        code: d.code ?? "diagnostic",
        message: d.message,
        ...omitUndefined({ path: d.path, metadata: d.metadata }),
      });
    }

    // ADR 63 retired the `timeline-not-rendered` diagnostic: the
    // timeline now surfaces via the `timeline` default projection
    // (above) whenever no `<Timeline>` overrides it, so a conversation
    // can no longer be silently dropped by omitting the component.

    // Formatter pass — collect produces SemanticContentBlocks (with
    // optional `semanticNode` sidecars on TextBlocks); dispatch them
    // through the active formatter so the returned tree carries
    // wire-shape ContentBlocks only. See ADR 22 §D2 + §D5.
    const tree = this.applyFormatters(
      collected.tree,
      state.rootScope.formatters.default,
      diagnostics,
      pinned,
    );

    return {
      tree,
      diagnostics,
      iterations: hitMax ? maxIterations : iterations + 1,
    };
  }

  /**
   * Walk a freshly-collected `RenderedTree` and replace each entry's
   * content with the formatter-flattened version. The formatter for an
   * entry is resolved via the same `id → format` fallback chain used by
   * `renderToString`'s dispatch.
   *
   * A ref that resolves to NEITHER an id nor a format match renders in a
   * format the adopter did not ask for, so it earns a `formatter-unresolved`
   * warning on `diagnostics` — once per distinct ref, not once per entry (the
   * same "at most one of each kind per renderTree" rule the boundary
   * diagnostics follow).
   */
  private applyFormatters(
    tree: import("@agentick/spec").RenderedTree,
    fallback: import("@agentick/spec").FormatterRef,
    diagnostics: ReconcileDiagnostic[],
    pinned?: DefinedFormatter,
  ): import("@agentick/spec").RenderedTree {
    const reported = new Set<string>();
    const resolve = (ref: import("@agentick/spec").FormatterRef): DefinedFormatter => {
      if (pinned !== undefined) return pinned;
      const resolution = resolveFormatterFromMap(this.formatters, ref, this.defaultFormatterId);
      if (resolution.match === "fallback") {
        const key = `${ref.id} ${ref.format ?? ""}`;
        if (!reported.has(key)) {
          reported.add(key);
          diagnostics.push(unresolvedFormatterDiagnostic(ref, resolution.formatter));
        }
      }
      return resolution.formatter;
    };

    const entries = tree.context.entries.map((entry) => {
      const fmt = resolve(entry.renderedWith ?? fallback);
      const formatted = fmt(
        entry.content as readonly import("@agentick/spec").SemanticContentBlock[],
      );
      return { ...entry, content: formatted };
    });
    const rootContent =
      tree.content && tree.content.length > 0
        ? resolve(tree.renderedWith ?? fallback)(
            tree.content as readonly import("@agentick/spec").SemanticContentBlock[],
          )
        : tree.content;
    return {
      ...tree,
      context: { ...tree.context, entries },
      ...omitUndefined({ content: rootContent }),
    };
  }

  /**
   * Render-to-string body.
   *
   * Drives renderTreeBody internally to produce a stable `RenderedTree`,
   * then flattens to a string via a default serializer that respects
   * the in-scope `FormatterRef.format` (markdown / xml / text / …).
   *
   * The formatter harness (Phase 4a) will replace the default serializer
   * with proper formatter dispatch. Today the serializer is a pragmatic
   * markdown-flavored flatten that covers the common authoring cases:
   * sections render as `## title\n\nbody`, messages render as
   * `**{role}:** body`, free-root content concatenates as text.
   *
   * Subtree extraction is the caller's job — use renderTree + filter
   * the entries you want + your own serializer. No selector grammar
   * is baked in.
   */
  private async renderToStringBody(
    input: RenderToStringInput,
    state: MountState,
  ): Promise<RenderToStringResult> {
    // Two modes:
    //  - Explicit caller override (`input.formatter`): apply to every
    //    entry regardless of its `renderedWith`. The caller wants a
    //    specific output format, and that has to be in force during the
    //    BLOCK pass — a dialect decides how a section reads, so pinning it
    //    only at serialization time would frame markdown headings in xml.
    //  - No override: honor per-entry `renderedWith` (set by JSX scope
    //    providers like <XML>/<Markdown>). Falls back to the root
    //    scope's default when an entry doesn't pin one.
    const fallback = state.rootScope.formatters.default;
    const requestedRef = input.formatter ?? fallback;
    const resolved = resolveFormatterFromMap(
      this.formatters,
      requestedRef,
      this.defaultFormatterId,
    );

    const tree = await this.renderTreeBody(
      {
        mountId: input.mountId,
        sessionId: state.bridges.session.id,
        ...omitUndefined({ maxIterations: input.maxIterations }),
      },
      state,
      input.formatter === undefined ? undefined : resolved.formatter,
    );

    // A caller-pinned formatter is resolved HERE, not in `applyFormatters`, so
    // its unresolvable case needs its own report — otherwise
    // `renderToString({ formatter: { id: "typo" } })` silently serializes in
    // the default format.
    const diagnostics =
      resolved.match === "fallback"
        ? [...tree.diagnostics, unresolvedFormatterDiagnostic(requestedRef, resolved.formatter)]
        : tree.diagnostics;
    // `renderTreeBody` already ran the block pass; `formatTree` only flattens
    // and frames. Running the blocks through a formatter a second time
    // double-escapes and mangles the section frames the first pass emitted.
    const text = formatTree(
      tree.tree,
      resolved.formatter,
      // respect per-entry renderedWith only when caller did NOT pin a
      // formatter — `opts.formatters` enables per-entry lookup;
      // omitting it forces the resolved formatter for every entry.
      input.formatter === undefined ? { formatters: this.formatters } : {},
    );
    const mimeType = mimeForFormatter(requestedRef);

    return {
      payload: { text, mimeType },
      diagnostics,
      iterations: tree.iterations,
    };
  }

  /**
   * Render the mount once with the BridgeProvider wrap.
   *
   * Errors thrown during render (including the Promises that `useData`
   * uses for the no-Suspense blocking primitive) are caught at the
   * render() call site, NOT via the host-config's onUncaughtError. This
   * matches the v1 pattern and is necessary because react-reconciler
   * 0.33's onUncaughtError can fire during a retry that React performs
   * for thrown Promises — which would cascade into runaway re-renders.
   * The try/catch here short-circuits that retry.
   */
  private renderOnce(state: MountState): void {
    // Wrap with BridgeContext (runtime bridges) and LifecycleContext
    // (per-mount handler registry). User hooks consume the appropriate
    // context. The two contexts are siblings, not nested in meaning —
    // nesting order is arbitrary.
    const wrapped = React.createElement(
      BridgeContext.Provider,
      { value: state.bridges },
      React.createElement(
        LifecycleContext.Provider,
        { value: state.lifecycle },
        React.createElement(
          InterceptorContext.Provider,
          { value: state.commandInterceptors },
          React.createElement(
            RenderContextContext.Provider,
            { value: state.renderContext },
            state.element,
          ),
        ),
      ),
    );
    try {
      state.compiler.render(wrapped, state.root);
      // Flush passive effects post-commit (ADR 54 (a)) — a component
      // mounting mid-run registers its lifecycle listeners here.
      state.compiler.flushPassiveEffects();
    } catch (err) {
      // Promises from useData are tracked via the bridge; the loop
      // detects them via hasPending(). Plain errors are real failures.
      if (!isThenable(err) && state.renderError === null) {
        state.renderError = err;
      }
    }
  }

  private mountState(mountId: string): MountState {
    const state = this.mounts.get(mountId);
    if (!state) throw new NotMounted({ mountId });
    return state;
  }

  private tryMountState(mountId: string): MountState | undefined {
    return this.mounts.get(mountId);
  }

  /**
   * Emit a one-shot warning if the input element tree statically contains
   * a `<Suspense>` boundary. The DataBridge contract is no-Suspense — any
   * fallback rendered into the IR is silently wrong from the model's
   * perspective. We warn rather than throw because some apps legitimately
   * want to wrap third-party React code that uses Suspense; they need to
   * know what's getting into context.
   *
   * Static — Suspense returned from a function component is not caught.
   * The mount-time scan covers the common case (user wraps their JSX in
   * `<Suspense>`); dynamic Suspense remains a documented gap.
   */
  private maybeWarnSuspense(element: unknown): void {
    // Walk every mount that hasn't warned yet — `element` may be from
    // mount or rerender, and we key off whichever mount the call site
    // belongs to.
    for (const [mountId, state] of this.mounts) {
      if (state.element !== element) continue;
      if (this.suspenseWarnedMounts.has(mountId)) return;
      if (!elementTreeContainsSuspense(element)) return;
      this.suspenseWarnedMounts.add(mountId);
      // eslint-disable-next-line no-console
      console.warn(
        `[@agentick/compiler-react] mount "${mountId}" contains a <Suspense> boundary. ` +
          `The DataBridge contract is no-Suspense — useData throws + the render-until-stable ` +
          `loop awaits. A user-placed <Suspense> will render its fallback into the IR. ` +
          `Remove the boundary or accept the fallback in model context.`,
      );
      return;
    }
  }

  private handleInvalidate(
    payload: Extract<CompilerInboxMessage, { type: "invalidate" }>,
  ): undefined {
    const state = this.mounts.get(payload.mountId);
    if (!state) return;
    if (payload.keys) {
      for (const k of payload.keys) state.bridges.data.invalidate(k);
    }
    if (payload.tags) {
      for (const t of payload.tags) state.bridges.data.invalidateTag(t);
    }
    return undefined;
  }
}

/**
 * Iterate every slot on `bridges` and capture its snapshot if the slot
 * exposes the `SnapshotCapable` contract (`exportSnapshot()`).
 * Generic — no harness-specific knowledge. Per ADR 27, any harness
 * that extends `SnapshotCapable<T>` on its protocol gets its snapshot
 * captured automatically; impls that happen to expose `exportSnapshot`
 * without declaring it on the protocol (like `InMemoryDataBridge`)
 * still work via runtime feature detection.
 *
 * The `data` slot is excluded here because the compiler keeps its
 * snapshot in the top-level `dataCache` field for back-compat — see
 * `CompilerSnapshot` in `@agentick/spec`.
 */
function captureBridgeSnapshots(bridges: HookBridges): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, bridge] of Object.entries(bridges)) {
    if (name === "data") continue; // captured separately as dataCache
    if (bridge === null || bridge === undefined) continue;
    const exportFn = (bridge as { exportSnapshot?: () => unknown }).exportSnapshot;
    if (typeof exportFn === "function") {
      out[name] = exportFn.call(bridge);
    }
  }
  return out;
}

/**
 * Apply per-slot snapshot payloads to the bridges. Iterates entries in
 * the snapshot map; for each bridge that exposes `importSnapshot`,
 * invokes it with the recorded value. Async-aware — `importSnapshot`
 * may return a Promise (e.g., TimelineHarness) and we await all
 * concurrently for restore-before-render ordering.
 */
async function applyBridgeSnapshots(
  bridges: HookBridges,
  snapshotBridges: Readonly<Record<string, unknown>> | undefined,
): Promise<void> {
  if (!snapshotBridges) return;
  const pending: Promise<unknown>[] = [];
  for (const [name, value] of Object.entries(snapshotBridges)) {
    if (value === undefined) continue;
    const bridge = (bridges as unknown as Record<string, unknown>)[name];
    if (bridge === null || bridge === undefined) continue;
    const importFn = (bridge as { importSnapshot?: (s: unknown) => unknown }).importSnapshot;
    if (typeof importFn === "function") {
      const result = importFn.call(bridge, value);
      if (result instanceof Promise) pending.push(result);
    }
  }
  if (pending.length > 0) await Promise.all(pending);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Heuristic scan of a React element tree for `<Suspense>` boundaries.
 * Returns `true` if any descendant element's `type` is `React.Suspense`.
 *
 * Static — only sees Suspense boundaries present in the input element
 * tree. Suspense returned from a function component's output is invisible
 * until render. We accept that gap: this is a *warning* heuristic, not a
 * correctness contract.
 *
 * Traversal stops at function components — we can't render them without
 * the compiler. The common case (a user wraps their tree in
 * `<Suspense>` at the root, or inside a top-level layout) is caught.
 */
function elementTreeContainsSuspense(node: unknown): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return false;
  if (typeof node === "string" || typeof node === "number") return false;
  if (Array.isArray(node)) {
    for (const child of node) if (elementTreeContainsSuspense(child)) return true;
    return false;
  }
  if (typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === React.Suspense) return true;
  // Walk children of intrinsics + fragments. Function components are
  // opaque — we don't invoke them.
  const children = el.props?.children;
  if (children !== undefined && elementTreeContainsSuspense(children)) return true;
  return false;
}

// ============================================================================
// Formatter resolution + mime mapping (renderToString helpers)
//
// `serializeTreeToString` + per-format framing/flatten helpers
// previously lived here as the "Phase 4a pending" inline serializer.
// They moved to `@agentick/formatters` as `formatTree` + the
// per-formatter `frameSection` / `frameMessage` / `blocksToText`
// methods on each `DefinedFormatter`. The harness now delegates the
// entire tree-to-string serialization to `formatTree`.
//
// What remains:
//  - `resolveFormatterFromMap` — used by `applyFormatters` (the
//    per-entry block-level formatter pass that renderTreeBody runs
//    against tree.context.entries) AND by `renderToStringBody` to
//    resolve the effective default formatter before calling
//    `formatTree`.
//  - `mimeForFormatter` — maps a FormatterRef to a MIME type for
//    the `renderToString` result payload. Small enough to keep
//    inline; could move to formatters-next later if other consumers
//    need it.
// ============================================================================

/**
 * Resolve a ref against the harness's registry, reporting HOW it matched.
 *
 * The id → format → fallback chain itself lives in `@agentick/formatters`
 * (`resolveFormatterRef`) — the same lookup `formatTree` runs, so the per-entry
 * pass here and the string serialization there can never disagree. What this
 * wrapper adds is the harness's fallback: the formatter registered under
 * `defaultId`, or a no-op standing in for markdown when even that is absent.
 *
 * A `"fallback"` match means the adopter asked for a formatter the registry
 * cannot serve and got a DIFFERENT output format. Callers surface it as a
 * `formatter-unresolved` diagnostic — see `applyFormatters`.
 */
function resolveFormatterFromMap(
  formatters: ReadonlyMap<string, DefinedFormatter>,
  ref: import("@agentick/spec").FormatterRef,
  defaultId: string,
): FormatterResolution {
  const fallback =
    formatters.get(defaultId) ??
    // Last-resort: a no-op formatter pretending to be markdown.
    (Object.assign((b: readonly import("@agentick/spec").SemanticContentBlock[]) => b, {
      __identity: { id: "formatter.markdown", format: "markdown" as const },
    }) as DefinedFormatter);
  return resolveFormatterRef(formatters, ref, fallback);
}

/**
 * The `formatter-unresolved` warning. `ReconcileDiagnosticCode` is an OPEN list
 * — implementations MAY surface additional codes — and this one is the formatter
 * twin of the collect walker's `MISSING_*` contributor diagnostics: the tree is
 * still produced, but it carries a known defect (content rendered in a format
 * nobody asked for). `metadata` carries the machine-readable halves so devtools
 * can link the ref back to its `<FormatScope>`.
 */
function unresolvedFormatterDiagnostic(
  ref: import("@agentick/spec").FormatterRef,
  used: DefinedFormatter,
): ReconcileDiagnostic {
  return {
    severity: "warning",
    code: "formatter-unresolved",
    message: describeUnresolvedFormatter(ref, used),
    metadata: {
      requestedId: ref.id,
      ...(ref.format !== undefined ? { requestedFormat: ref.format } : {}),
      usedId: used.__identity.id,
      usedFormat: used.__identity.format,
    },
  };
}

function mimeForFormatter(formatter: import("@agentick/spec").FormatterRef): string {
  const format = formatter.format ?? "markdown";
  if (format === "markdown") return "text/markdown";
  if (format === "xml") return "application/xml";
  if (format === "json") return "application/json";
  return "text/plain";
}

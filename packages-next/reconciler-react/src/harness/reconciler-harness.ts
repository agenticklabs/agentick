/**
 * ReconcilerHarness — Layer C.
 *
 * Concrete `BaseHarness<"reconciler">` subclass implementing the
 * `ReconcilerProtocol`. One harness owns one container per mount; the
 * harness multiplexes over an internal `Map<mountId, MountState>` so a
 * single ReconcilerHarness instance can host multiple concurrent
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
import { Effect } from "effect";
import { runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  EventBus,
  HookBridges,
  MessageEnvelope,
  MessageHandlerError,
  MountInput,
  MountResult,
  NotifyLifecycleInput,
  OperationJournal,
  Operation,
  MessageInbox,
  ReconcileDiagnostic,
  ReconcilerInboxMessage,
  ReconcilerProtocol,
  ReconcilerSnapshot,
  RenderTreeInput,
  RenderTreeResult,
  RenderToStringInput,
  RenderToStringResult,
  RerenderInput,
  RestoreInput,
  SnapshotInput,
  UnmountInput,
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";
import { BaseHarness } from "@agentick/runtime-next";

import {
  collect,
  ContributorRegistry,
  createBuiltInRegistry,
  createContainer,
  createHostScope,
  InMemoryDataBridge,
  LifecycleStore,
  type Contributor,
  type HostScope,
  type ReconcilerContainer,
} from "@agentick/reconciler-next";
import { createReconciler, type FiberRoot, type Reconciler } from "../react/reconciler.js";
import { BridgeContext } from "../react/bridge-context.js";
import { LifecycleContext } from "../react/lifecycle-context.js";
import {
  builtInFormatters,
  markdownFormatter,
  type DefinedFormatter,
} from "@agentick/formatters-next";

interface MountState {
  readonly mountId: string;
  element: ReactNode;
  elementVersion?: string;
  readonly bridges: HookBridges;
  readonly container: ReconcilerContainer;
  readonly reconciler: Reconciler;
  readonly root: FiberRoot;
  readonly registry: ContributorRegistry;
  readonly rootScope: HostScope;
  readonly lifecycle: LifecycleStore;
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

export interface ReconcilerHarnessOptions {
  /** Override the built-in contributor set with caller-supplied registry. */
  readonly registry?: ContributorRegistry;
  /**
   * Override the built-in formatter set. Keyed by `FormatterRef.id`. When
   * omitted, the markdown / xml / text reference formatters from
   * `@agentick/formatters-next` are pre-loaded.
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

export class ReconcilerHarness extends BaseHarness<"reconciler"> implements ReconcilerProtocol {
  private readonly mounts = new Map<string, MountState>();
  private readonly registry: ContributorRegistry;
  private readonly formatters: ReadonlyMap<string, DefinedFormatter>;
  private readonly defaultFormatterId: string;
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
    options: ReconcilerHarnessOptions = {},
  ) {
    super("reconciler", scopeId, journal, bus, inbox);
    this.registry = options.registry ?? createBuiltInRegistry();
    this.formatters = options.formatters ?? builtInFormatters();
    this.defaultFormatterId = options.defaultFormatterId ?? markdownFormatter.__identity.id;
  }

  // ──────────────────────── Contributor registration ────────────────────────

  registerContributor(contributor: Contributor): void {
    this.registry.register(contributor);
  }

  // ──────────────────────── ReconcilerProtocol ────────────────────────

  mount(input: MountInput): Promise<MountResult> {
    const op: Operation<MountInput, MountResult> = {
      opId: input.opId ?? `reconciler:mount:${input.mountId}`,
      surface: "reconciler",
      name: "reconciler:command:mount",
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
          return Effect.fail({ _tag: "NotMounted", mountId: input.mountId } as const);
        }
        const op: Operation<RerenderInput, void> = {
          opId: input.opId ?? `reconciler:rerender:${input.mountId}`,
          surface: "reconciler",
          name: "reconciler:command:rerender",
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

  renderTree(input: RenderTreeInput): Promise<RenderTreeResult> {
    return runHarnessProtocol(
      Effect.suspend(() => {
        const state = this.tryMountState(input.mountId);
        if (!state) {
          return Effect.fail({ _tag: "NotMounted", mountId: input.mountId } as const);
        }
        const op: Operation<RenderTreeInput, RenderTreeResult> = {
          opId: input.opId ?? `reconciler:render:${input.mountId}:${ulid()}`,
          surface: "reconciler",
          name: "reconciler:command:render-tree",
          scope: {
            sessionId: state.bridges.session.id,
            executionId: input.executionId,
          },
          input,
        };
        return this.runOperation(op, (i) =>
          Effect.tryPromise({
            try: () => this.renderTreeBody(i, state),
            catch: (e: unknown) => e,
          }),
        );
      }),
    );
  }

  renderToString(input: RenderToStringInput): Promise<RenderToStringResult> {
    return runHarnessProtocol(
      Effect.suspend(() => {
        const state = this.tryMountState(input.mountId);
        if (!state) {
          return Effect.fail({ _tag: "NotMounted", mountId: input.mountId } as const);
        }
        const op: Operation<RenderToStringInput, RenderToStringResult> = {
          opId: input.opId ?? `reconciler:render-to-string:${input.mountId}:${ulid()}`,
          surface: "reconciler",
          name: "reconciler:command:render-to-string",
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

  async notifyLifecycle(input: NotifyLifecycleInput): Promise<void> {
    const state = this.tryMountState(input.mountId);
    if (!state) throw { _tag: "NotMounted", mountId: input.mountId };
    await state.lifecycle.dispatch(input.event);
  }

  async unmount(input: UnmountInput): Promise<void> {
    const state = this.mounts.get(input.mountId);
    if (!state) return;
    state.lifecycle.clear();
    state.container.children.length = 0;
    this.mounts.delete(input.mountId);
    this.suspenseWarnedMounts.delete(input.mountId);
  }

  async snapshot(input: SnapshotInput): Promise<ReconcilerSnapshot> {
    const state = this.mountState(input.mountId);
    // Per ADR 27: bridge state is captured generically by iterating
    // every slot on `HookBridges` and feature-testing for
    // `SnapshotCapable`. No harness-specific knowledge in the
    // reconciler. Component-local hook state (raw `useState` /
    // `useReducer`) is NOT captured by design — see ADR 22 §D1.
    // Components persisting state across hibernation use
    // `useSessionState(key, initial)` to land values in the StateHarness.
    const bridges = captureBridgeSnapshots(state.bridges);
    const dataCache =
      state.bridges.data instanceof InMemoryDataBridge ? state.bridges.data.exportSnapshot() : [];
    return {
      specVersion: SPEC_VERSION,
      mountId: state.mountId,
      ...(state.elementVersion !== undefined ? { elementVersion: state.elementVersion } : {}),
      bridges: bridges as ReconcilerSnapshot["bridges"],
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

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const m = msg as MessageEnvelope<ReconcilerInboxMessage | undefined>;
    const payload = m.payload;
    if (!payload) return Effect.succeed(undefined);
    switch (payload.type) {
      case "recompile":
        return Effect.tryPromise({
          try: () => this.renderTree({ mountId: payload.mountId, sessionId: "" }),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "unmount":
        return Effect.tryPromise({
          try: () => this.unmount({ mountId: payload.mountId }),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "invalidate":
        return Effect.sync(() => this.handleInvalidate(payload));
      default:
        return Effect.fail({
          _tag: "HandlerError",
          cause: new Error("unknown reconciler message type"),
        });
    }
  }

  // ──────────────────────── internals ────────────────────────

  private async mountBody(input: MountInput): Promise<MountResult> {
    if (this.mounts.has(input.mountId)) {
      throw { _tag: "AlreadyMounted", mountId: input.mountId };
    }
    const rootScope = createHostScope({
      formatter: input.defaultFormatter ?? { id: "default" },
      path: [`mount:${input.mountId}`],
    });
    const container = createContainer({ mountId: input.mountId, rootScope });
    // We need a mutable handle to the future MountState so the
    // host-config error callbacks can write `renderError` on it. The
    // state object is constructed first, then the reconciler is
    // attached.
    const state: MountState = {
      mountId: input.mountId,
      element: input.element as ReactNode,
      ...(input.elementVersion !== undefined ? { elementVersion: input.elementVersion } : {}),
      bridges: input.bridges,
      container,
      reconciler: null as unknown as Reconciler,
      root: null as unknown as FiberRoot,
      registry: this.registry,
      rootScope,
      lifecycle: new LifecycleStore(),
      renderError: null,
      errorBoundaryFiredInLastRender: false,
    };
    const reconciler = createReconciler({
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
    (state as { reconciler: Reconciler }).reconciler = reconciler;
    (state as { root: FiberRoot }).root = reconciler.createRoot();
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

    // Suspense heuristic — warn the FIRST time we see a `<Suspense>`
    // boundary in the input element tree. The DataBridge contract is
    // explicitly no-Suspense (`docs/proposals/v2/blueprint/03`), so a
    // user-authored Suspense boundary will render its fallback into the
    // IR with no way for us to clean that up. Warn loudly once.
    this.maybeWarnSuspense(input.element);

    return { mountId: input.mountId, restoredFromSnapshot };
  }

  private async renderTreeBody(
    input: RenderTreeInput,
    state: MountState,
  ): Promise<RenderTreeResult> {
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
        throw {
          _tag: "RenderFailed",
          cause: state.renderError,
        };
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
    const collected = collect({
      roots: state.container.children,
      registry: state.registry,
      rootScope: state.rootScope,
    });
    for (const d of collected.diagnostics) {
      diagnostics.push({
        severity: d.severity,
        code: d.code ?? "diagnostic",
        message: d.message,
        ...(d.path !== undefined ? { path: d.path } : {}),
        ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
      });
    }

    // Formatter pass — collect produces SemanticContentBlocks (with
    // optional `semanticNode` sidecars on TextBlocks); dispatch them
    // through the active formatter so the returned tree carries
    // wire-shape ContentBlocks only. See ADR 22 §D2 + §D5.
    const tree = this.applyFormatters(collected.tree, state.rootScope.formatters.default);

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
   */
  private applyFormatters(
    tree: import("@agentick/spec-next").RenderedTree,
    fallback: import("@agentick/spec-next").FormatterRef,
  ): import("@agentick/spec-next").RenderedTree {
    const entries = tree.context.entries.map((entry) => {
      const ref = entry.renderedWith ?? fallback;
      const fmt = resolveFormatterFromMap(this.formatters, ref, this.defaultFormatterId);
      const formatted = fmt(
        entry.content as readonly import("@agentick/spec-next").SemanticContentBlock[],
      );
      return { ...entry, content: formatted };
    });
    const rootContent =
      tree.content && tree.content.length > 0
        ? (() => {
            const ref = tree.renderedWith ?? fallback;
            const fmt = resolveFormatterFromMap(this.formatters, ref, this.defaultFormatterId);
            return fmt(
              tree.content as readonly import("@agentick/spec-next").SemanticContentBlock[],
            );
          })()
        : tree.content;
    return {
      ...tree,
      context: { ...tree.context, entries },
      ...(rootContent !== undefined ? { content: rootContent } : {}),
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
    const tree = await this.renderTreeBody(
      {
        mountId: input.mountId,
        sessionId: state.bridges.session.id,
        ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
      },
      state,
    );

    // Two modes:
    //  - Explicit caller override (`input.formatter`): apply to every
    //    entry regardless of its `renderedWith`. The caller wants a
    //    specific output format.
    //  - No override: honor per-entry `renderedWith` (set by JSX scope
    //    providers like <XML>/<Markdown>). Falls back to the root
    //    scope's default when an entry doesn't pin one.
    const fallback = state.rootScope.formatters.default;
    const effective = input.formatter ?? fallback;
    const text = serializeTreeToString(tree.tree, effective, {
      respectEntryFormatter: input.formatter === undefined,
      defaultFormatterId: this.defaultFormatterId,
      formatters: this.formatters,
    });
    const mimeType = mimeForFormatter(effective);

    return {
      payload: { text, mimeType },
      diagnostics: tree.diagnostics,
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
      React.createElement(LifecycleContext.Provider, { value: state.lifecycle }, state.element),
    );
    try {
      state.reconciler.render(wrapped, state.root);
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
    if (!state) throw { _tag: "NotMounted", mountId };
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
        `[@agentick/reconciler-react] mount "${mountId}" contains a <Suspense> boundary. ` +
          `The DataBridge contract is no-Suspense — useData throws + the render-until-stable ` +
          `loop awaits. A user-placed <Suspense> will render its fallback into the IR. ` +
          `Remove the boundary or accept the fallback in model context.`,
      );
      return;
    }
  }

  private handleInvalidate(
    payload: Extract<ReconcilerInboxMessage, { type: "invalidate" }>,
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
 * The `data` slot is excluded here because the reconciler keeps its
 * snapshot in the top-level `dataCache` field for back-compat — see
 * `ReconcilerSnapshot` in `@agentick/spec-next`.
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
 * the reconciler. The common case (a user wraps their tree in
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
// Default tree-to-string serializer (until formatter harness lands)
// ============================================================================

/**
 * Pragmatic flatten of a `RenderedTree` to a string. Honors the
 * formatter's `format` hint when known (markdown, xml, text). The
 * formatter harness (Phase 4a) will replace this with real formatter
 * dispatch.
 *
 * Renders the WHOLE mount in declaration order: every context entry
 * (sections + messages), plus free-root content when present. Subtree
 * extraction is the caller's job — use renderTree + filter + custom
 * serialize.
 */
interface SerializeOptions {
  readonly respectEntryFormatter: boolean;
  readonly defaultFormatterId: string;
  readonly formatters: ReadonlyMap<string, DefinedFormatter>;
}

/**
 * Walk the {@link RenderedTree} and serialize each entry through the
 * appropriate formatter. Formatters do block-level work (markdown
 * fences, XML wrapping); message/section framing happens here in the
 * reconciler.
 *
 * Dispatch:
 *   - When `respectEntryFormatter` is true, an entry's `renderedWith.id`
 *     wins; falls back to the requested formatter when missing.
 *   - When false (explicit caller override), the requested formatter
 *     applies to every entry.
 *   - Missing formatters fall back to `defaultFormatterId` (markdown).
 */
function serializeTreeToString(
  tree: import("@agentick/spec-next").RenderedTree,
  requestedFormatter: import("@agentick/spec-next").FormatterRef,
  options: SerializeOptions,
): string {
  const parts: string[] = [];

  for (const entry of tree.context.entries) {
    const formatter = resolveFormatter(entry.renderedWith, requestedFormatter, options);
    const body = formatter(
      entry.content as readonly import("@agentick/spec-next").SemanticContentBlock[],
    );
    const bodyText = blocksToText(body);
    const framed =
      entry.kind === "section"
        ? frameSection(entry, bodyText, formatter.__identity.format)
        : frameMessage(entry, bodyText, formatter.__identity.format);
    parts.push(framed);
  }

  if (tree.content && tree.content.length > 0) {
    const formatter = resolveFormatter(tree.renderedWith, requestedFormatter, options);
    const body = formatter(
      tree.content as readonly import("@agentick/spec-next").SemanticContentBlock[],
    );
    parts.push(blocksToText(body));
  }

  return parts.filter((p) => p.length > 0).join("\n\n");
}

/**
 * Map-only formatter resolution. Shared by the formatter pass in
 * `renderTreeBody` and by `serializeTreeToString`'s entry dispatch.
 * Mirrors {@link resolveFormatter}'s fallback chain: exact id match,
 * then format match, then the configured default, then a structural
 * markdown no-op.
 */
function resolveFormatterFromMap(
  formatters: ReadonlyMap<string, DefinedFormatter>,
  ref: import("@agentick/spec-next").FormatterRef,
  defaultId: string,
): DefinedFormatter {
  const byId = formatters.get(ref.id);
  if (byId) return byId;
  if (ref.format) {
    for (const fmt of formatters.values()) {
      if (fmt.__identity.format === ref.format) return fmt;
    }
  }
  return (
    formatters.get(defaultId) ??
    (Object.assign((b: readonly import("@agentick/spec-next").SemanticContentBlock[]) => b, {
      __identity: { id: "formatter.markdown", format: "markdown" as const },
    }) as DefinedFormatter)
  );
}

function resolveFormatter(
  entryRef: import("@agentick/spec-next").FormatterRef | undefined,
  requested: import("@agentick/spec-next").FormatterRef,
  options: SerializeOptions,
): DefinedFormatter {
  const ref = options.respectEntryFormatter ? (entryRef ?? requested) : requested;
  // First try the exact id. Then fall back to any formatter whose
  // identity.format matches the requested format (so adopters can pass
  // `{ format: "xml" }` without knowing the canonical id).
  const byId = options.formatters.get(ref.id);
  if (byId) return byId;
  if (ref.format) {
    for (const fmt of options.formatters.values()) {
      if (fmt.__identity.format === ref.format) return fmt;
    }
  }
  return (
    options.formatters.get(options.defaultFormatterId) ??
    // Last-resort: a no-op formatter pretending to be markdown.
    (Object.assign((b: readonly import("@agentick/spec-next").SemanticContentBlock[]) => b, {
      __identity: { id: "formatter.markdown", format: "markdown" as const },
    }) as DefinedFormatter)
  );
}

function blocksToText(blocks: readonly import("@agentick/spec-next").ContentBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    out.push(blockToText(block));
  }
  return out.filter((s) => s.length > 0).join("\n\n");
}

function blockToText(block: import("@agentick/spec-next").ContentBlock): string {
  switch (block.type) {
    case "text":
    case "reasoning":
    case "xml":
    case "csv":
    case "html":
      return block.text ?? "";
    case "code":
      return block.text;
    case "json":
      return block.text ?? (block.data !== undefined ? JSON.stringify(block.data) : "");
    case "image": {
      const src = block.source.type === "url" ? block.source.url : "[binary]";
      return `![${block.altText ?? ""}](${src})`;
    }
    case "document":
    case "audio":
    case "video": {
      const src = block.source.type === "url" ? block.source.url : "[binary]";
      return `[${block.type}](${src})`;
    }
    case "tool_use":
      return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
    case "tool_result":
      return blocksToText(block.content);
    case "user_action":
    case "system_event":
    case "state_change":
      return block.text ?? "";
    case "custom":
      return block.content;
    case "generated_image":
      return `![generated image](data:${block.mimeType};base64,${block.data.slice(0, 16)}…)`;
    case "generated_file":
      return `[generated file](${block.uri})`;
    case "executable_code":
      return block.code;
    case "code_execution_result":
      return block.output;
    default:
      return "";
  }
}

function frameSection(
  entry: import("@agentick/spec-next").SectionEntry,
  body: string,
  format: string,
): string {
  if (format === "xml") {
    const title = entry.title ? ` title="${escapeAttr(entry.title)}"` : "";
    return `<section id="${escapeAttr(entry.id)}"${title}>\n${body}\n</section>`;
  }
  if (format === "text") {
    return entry.title ? `${entry.title}\n${body}` : body;
  }
  return entry.title ? `## ${entry.title}\n\n${body}` : body;
}

function frameMessage(
  entry: import("@agentick/spec-next").MessageEntry,
  body: string,
  format: string,
): string {
  if (format === "xml") {
    return `<message role="${escapeAttr(entry.role)}">\n${body}\n</message>`;
  }
  if (format === "text") {
    return `${entry.role}: ${body}`;
  }
  return `**${entry.role}:** ${body}`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mimeForFormatter(formatter: import("@agentick/spec-next").FormatterRef): string {
  const format = formatter.format ?? "markdown";
  if (format === "markdown") return "text/markdown";
  if (format === "xml") return "application/xml";
  if (format === "json") return "application/json";
  return "text/plain";
}

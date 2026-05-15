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
import { ulid } from "@agentick/runtime";
import type {
  EventBus,
  HookBridges,
  MessageEnvelope,
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
  RenderResourceInput,
  RenderResourceResult,
  RenderTreeInput,
  RenderTreeResult,
  RenderToStringInput,
  RenderToStringResult,
  RerenderInput,
  RestoreInput,
  SnapshotInput,
  UnmountInput,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import { BaseHarness } from "@agentick/runtime";

import type { ReconcilerContainer } from "../host/container.js";
import { createContainer } from "../host/container.js";
import { createHostScope, type HostScope } from "../host/host-context.js";
import { createReconciler, type FiberRoot, type Reconciler } from "../react/reconciler.js";
import { collect } from "../collect/collect.js";
import { ContributorRegistry } from "../collect/registry.js";
import { createBuiltInRegistry } from "../collect/contributors/built-ins.js";
import type { Contributor } from "../collect/contributor.js";
import { BridgeContext } from "../react/bridge-context.js";
import { LifecycleContext } from "../react/lifecycle-context.js";
import { InMemoryDataBridge } from "../bridges/in-memory-data-bridge.js";
import { LifecycleStore } from "./lifecycle-store.js";

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
  strictNoSuspense: boolean;
  /**
   * Captures the first render error surfaced via the host config's
   * `onUncaughtError` callback. Cleared at the start of each render
   * iteration. Set when a component throws a non-Promise error (real
   * bugs, missing-bridge errors, etc.).
   */
  renderError: unknown;
}

export interface ReconcilerHarnessOptions {
  /** Override the built-in contributor set with caller-supplied registry. */
  readonly registry?: ContributorRegistry;
}

/**
 * Default cap on render-until-stable iterations. Exceeding this means a
 * component is requesting data that can't settle (probably a bug —
 * e.g., `useData` calls that depend on each other unboundedly).
 */
const DEFAULT_MAX_ITERATIONS = 10;

export class ReconcilerHarness
  extends BaseHarness<"reconciler">
  implements ReconcilerProtocol
{
  private readonly mounts = new Map<string, MountState>();
  private readonly registry: ContributorRegistry;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ReconcilerHarnessOptions = {},
  ) {
    super("reconciler", scopeId, journal, bus, inbox);
    this.registry = options.registry ?? createBuiltInRegistry();
  }

  // ──────────────────────── Contributor registration ────────────────────────

  registerContributor(contributor: Contributor): void {
    this.registry.register(contributor);
  }

  // ──────────────────────── ReconcilerProtocol ────────────────────────

  async mount(input: MountInput): Promise<MountResult> {
    const op: Operation<MountInput, MountResult> = {
      opId: input.opId ?? `reconciler:mount:${input.mountId}`,
      surface: "reconciler",
      name: "reconciler:command:mount",
      scope: { sessionId: input.sessionId, executionId: input.executionId },
      input,
    };
    return this.runOperation(op, async (i) => this.mountBody(i));
  }

  async rerender(input: RerenderInput): Promise<void> {
    const op: Operation<RerenderInput, void> = {
      opId: input.opId ?? `reconciler:rerender:${input.mountId}`,
      surface: "reconciler",
      name: "reconciler:command:rerender",
      scope: { sessionId: this.mountState(input.mountId).bridges.session.id },
      input,
    };
    return this.runOperation(op, async (i) => {
      const state = this.mountState(i.mountId);
      state.element = i.element as ReactNode;
      if (i.elementVersion !== undefined) state.elementVersion = i.elementVersion;
      this.renderOnce(state);
    });
  }

  async renderTree(input: RenderTreeInput): Promise<RenderTreeResult> {
    const state = this.mountState(input.mountId);
    const op: Operation<RenderTreeInput, RenderTreeResult> = {
      // Each renderTree call must get a unique opId — Date.now() at
      // millisecond precision collides for back-to-back calls. ULID is
      // monotonic + collision-safe.
      opId: input.opId ?? `reconciler:render:${input.mountId}:${ulid()}`,
      surface: "reconciler",
      name: "reconciler:command:render-tree",
      scope: { sessionId: state.bridges.session.id, executionId: input.executionId },
      input,
    };
    return this.runOperation(op, async (i) => this.renderTreeBody(i, state));
  }

  async renderToString(input: RenderToStringInput): Promise<RenderToStringResult> {
    // Free-root rendering — Phase 3.10+. Stub returns spec-conformant
    // empty payload + a diagnostic explaining what's not yet wired.
    const _state = this.mountState(input.mountId);
    void _state;
    return {
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [
        {
          severity: "warning",
          code: "render-to-string-not-implemented",
          message: "renderToString is not yet implemented; returning empty payload",
        },
      ],
      iterations: 0,
    };
  }

  async renderResource(input: RenderResourceInput): Promise<RenderResourceResult> {
    const _state = this.mountState(input.mountId);
    void _state;
    return {
      content: [],
      diagnostics: [
        {
          severity: "warning",
          code: "render-resource-not-implemented",
          message: "renderResource is not yet implemented; returning empty content",
        },
      ],
      iterations: 0,
    };
  }

  async notifyLifecycle(input: NotifyLifecycleInput): Promise<void> {
    const state = this.mountState(input.mountId);
    await state.lifecycle.dispatch(input.event);
  }

  async unmount(input: UnmountInput): Promise<void> {
    const state = this.mounts.get(input.mountId);
    if (!state) return;
    state.lifecycle.clear();
    state.container.children.length = 0;
    this.mounts.delete(input.mountId);
  }

  async snapshot(input: SnapshotInput): Promise<ReconcilerSnapshot> {
    const state = this.mountState(input.mountId);
    // Bridge state — data cache + knobs — is captured when the bridges
    // expose `exportSnapshot()`. Hook state (useState/useReducer) is
    // not yet captured; that requires walking React's fiber tree.
    // TODO(snapshot): traverse fiber tree to extract hook state per
    // component path so hibernate-and-resume preserves component-local
    // state across process boundaries.
    const dataCache =
      state.bridges.data instanceof InMemoryDataBridge
        ? state.bridges.data.exportSnapshot()
        : [];
    const knobs = exportKnobs(state.bridges);
    return {
      specVersion: SPEC_VERSION,
      mountId: state.mountId,
      ...(state.elementVersion !== undefined ? { elementVersion: state.elementVersion } : {}),
      hookStates: [],
      dataCache,
      knobs,
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
    importKnobs(state.bridges, input.snapshot.knobs);
    // Hook state restoration is deferred (see snapshot()).
  }

  // ──────────────────────── inbox dispatch ────────────────────────

  protected async handleMessage(msg: MessageEnvelope): Promise<unknown> {
    const m = msg as MessageEnvelope<ReconcilerInboxMessage | undefined>;
    const payload = m.payload;
    if (!payload) return undefined;
    switch (payload.type) {
      case "recompile":
        return this.renderTree({ mountId: payload.mountId, sessionId: "" });
      case "unmount":
        return this.unmount({ mountId: payload.mountId });
      case "invalidate":
        return this.handleInvalidate(payload);
      default:
        throw new Error(`unknown reconciler message type`);
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
      strictNoSuspense: input.strictNoSuspense ?? false,
      renderError: null,
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
        // Errors caught by an in-tree <ErrorBoundary> are handled by
        // user code; the framework surfaces them as info diagnostics
        // via the host config rather than blocking the render.
      },
      onRecoverableError: () => {
        // React 19 emits these for non-fatal issues (hydration mismatch,
        // missing keys, etc.). No-op here — they're advisory.
      },
    });
    (state as { reconciler: Reconciler }).reconciler = reconciler;
    (state as { root: FiberRoot }).root = reconciler.createRoot();
    this.mounts.set(input.mountId, state);

    // Apply snapshot BEFORE the initial render so useData / useKnob
    // hooks see restored values on first invocation. Hook state
    // (useState/useReducer) restoration is deferred — see snapshot().
    const restoredFromSnapshot = input.snapshot !== undefined;
    if (input.snapshot) {
      if (state.bridges.data instanceof InMemoryDataBridge) {
        state.bridges.data.importSnapshot(input.snapshot.dataCache);
      }
      importKnobs(state.bridges, input.snapshot.knobs);
    }

    // First render — populates the host tree and lets sync components
    // commit. With a restored snapshot, useData hits cached values
    // immediately (no fetch starts on first render).
    this.renderOnce(state);

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

    // Render-until-stable. The DataBridge tracks in-flight Promises
    // independently of whether React caught the throw — so the loop's
    // termination condition is "bridge has no pending fetches",
    // regardless of React's error handling for thrown Promises.
    for (iterations = 0; iterations < maxIterations; iterations++) {
      state.renderError = null;
      this.renderOnce(state);

      const dataBridge = state.bridges.data;
      const pending =
        dataBridge instanceof InMemoryDataBridge ? dataBridge.pending() : null;

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
      // and the loop will see no pending and terminate).
      await Promise.allSettled(pending);
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

    return {
      tree: collected.tree,
      diagnostics,
      iterations: hitMax ? maxIterations : iterations + 1,
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
    // Wrap with both BridgeContext (runtime bridges) and LifecycleContext
    // (per-mount handler registry). User hooks consume the appropriate
    // context. The two contexts are siblings, not nested in meaning —
    // nesting order is arbitrary.
    const wrapped = React.createElement(
      BridgeContext.Provider,
      { value: state.bridges },
      React.createElement(
        LifecycleContext.Provider,
        { value: state.lifecycle },
        state.element,
      ),
    );
    try {
      state.reconciler.render(wrapped, state.root);
    } catch (err) {
      // Promises from useData are tracked via the bridge; the loop
      // detects them via hasPending(). Plain errors are real failures.
      if (!isThenable(err)) {
        if (state.renderError === null) state.renderError = err;
      }
    }
  }

  private mountState(mountId: string): MountState {
    const state = this.mounts.get(mountId);
    if (!state) throw { _tag: "NotMounted", mountId };
    return state;
  }

  private handleInvalidate(payload: Extract<ReconcilerInboxMessage, { type: "invalidate" }>): void {
    const state = this.mounts.get(payload.mountId);
    if (!state) return;
    if (payload.keys) {
      for (const k of payload.keys) state.bridges.data.invalidate(k);
    }
    if (payload.tags) {
      for (const t of payload.tags) state.bridges.data.invalidateTag(t);
    }
  }
}

/**
 * Read knob values from the bridge. Prefers `exportSnapshot()` when the
 * bridge exposes it (preserves any internal ordering/metadata); falls
 * back to walking `list()` results.
 */
function exportKnobs(bridges: HookBridges): Readonly<Record<string, unknown>> {
  const k = bridges.knobs as { exportSnapshot?: () => Readonly<Record<string, unknown>> };
  if (typeof k.exportSnapshot === "function") return k.exportSnapshot();
  const out: Record<string, unknown> = {};
  for (const item of bridges.knobs.list()) out[item.id] = item.value;
  return out;
}

/**
 * Apply knob values to the bridge. Prefers `importSnapshot()` when the
 * bridge exposes it (more efficient + atomic); falls back to a
 * per-entry `set()` walk.
 */
function importKnobs(
  bridges: HookBridges,
  values: Readonly<Record<string, unknown>>,
): void {
  const k = bridges.knobs as { importSnapshot?: (v: Readonly<Record<string, unknown>>) => void };
  if (typeof k.importSnapshot === "function") {
    k.importSnapshot(values);
    return;
  }
  for (const [id, value] of Object.entries(values)) bridges.knobs.set(id, value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

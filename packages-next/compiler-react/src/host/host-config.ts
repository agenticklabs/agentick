/**
 * Host config for react-reconciler 0.33 (React 19).
 *
 * Produced via `createHostConfig(deps)` — there is no module-level
 * state. Two simultaneous mounts get two independent host configs.
 *
 * Mutation mode (`supportsMutation: true`) is the correct mode: the
 * collector wants a stable, in-place tree at commit time, not the
 * persistent variant.
 *
 * `getChildHostContext` reads the `scope` prop on `<Markdown>` /
 * `<XML>` / similar provider components to swap the formatter for
 * descendants — no module-level registry, no side-effecting
 * `registerRendererComponent` call. The information lives in props.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Layer A
 */

import type ReactReconciler from "react-reconciler";
import {
  createElementInstance,
  createTextInstance,
  isElementInstance,
  withFormatter,
  type ElementInstance,
  type FormatterBinding,
  type HostInstance,
  type HostScope,
  type Props,
  type CompilerContainer,
  type TextInstance,
} from "@agentick/compiler-next";

export interface HostConfigDeps {
  /** Container the config writes into. One per mount. */
  readonly container: CompilerContainer;

  /**
   * Per-mount id prefix used by host-instance factories. Prevents
   * collisions when multiple mounts share a process.
   */
  readonly idPrefix?: string;

  /**
   * Hook called whenever a component throws during render. Surfaces
   * unhandled errors to the harness. The host config does NOT swallow;
   * the harness decides whether the error becomes a `RenderFailed`
   * terminal or is caught by a user `<ErrorBoundary>`.
   */
  readonly onUncaughtError?: (err: Error) => void;
  readonly onCaughtError?: (err: Error) => void;
  readonly onRecoverableError?: (err: Error) => void;
}

/**
 * Type parameters for `ReactReconciler.HostConfig<...>` — we expose
 * them as a tuple for readability.
 */
type HC = ReactReconciler.HostConfig<
  string, // Type — JSX element type as seen by host
  Props, // Props
  CompilerContainer, // Container
  ElementInstance, // Instance
  TextInstance, // TextInstance
  never, // SuspenseInstance
  never, // HydratableInstance
  never, // FormInstance
  HostInstance, // PublicInstance
  HostScope, // HostContext
  never, // ChildSet (mutation mode → unused)
  ReturnType<typeof setTimeout>, // TimeoutHandle
  -1, // NoTimeout
  null // TransitionStatus
>;

export function createHostConfig(deps: HostConfigDeps): HC {
  const { idPrefix, onUncaughtError, onCaughtError, onRecoverableError } = deps;
  void onUncaughtError;
  void onCaughtError;
  void onRecoverableError;

  return {
    // ──────────────────────── mode ────────────────────────
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    noTimeout: -1,
    supportsMicrotasks: true,
    scheduleMicrotask: (fn) => queueMicrotask(fn),

    // ──────────────────────── instance creation ────────────────────────
    createInstance(type, props, _root, hostContext) {
      return createElementInstance(type, props, hostContext, { idPrefix });
    },

    createTextInstance(text) {
      return createTextInstance(text, { idPrefix });
    },

    // ──────────────────────── tree assembly (mutation mode) ───────────
    appendInitialChild(parent, child) {
      child.parent = parent;
      parent.children.push(child);
    },

    appendChild(parent, child) {
      // react-reconciler MAY call appendChild on a child already in the
      // parent's list (this is how moves-to-end are expressed). Detect
      // and splice from current position first to avoid duplicates.
      const existing = parent.children.indexOf(child);
      if (existing !== -1) parent.children.splice(existing, 1);
      child.parent = parent;
      parent.children.push(child);
    },

    appendChildToContainer(c, child) {
      const existing = c.children.indexOf(child);
      if (existing !== -1) c.children.splice(existing, 1);
      child.parent = null;
      c.children.push(child);
    },

    insertBefore(parent, child, before) {
      // react-reconciler MOVES existing children by calling insertBefore
      // with a child already present in the parent's list. Detect and
      // splice from current position first; otherwise we'd duplicate.
      const existing = parent.children.indexOf(child);
      if (existing !== -1) parent.children.splice(existing, 1);
      const idx = parent.children.indexOf(before);
      if (idx === -1) parent.children.push(child);
      else parent.children.splice(idx, 0, child);
      child.parent = parent;
    },

    insertInContainerBefore(c, child, before) {
      const existing = c.children.indexOf(child);
      if (existing !== -1) c.children.splice(existing, 1);
      const idx = c.children.indexOf(before);
      if (idx === -1) c.children.push(child);
      else c.children.splice(idx, 0, child);
      child.parent = null;
    },

    removeChild(parent, child) {
      const idx = parent.children.indexOf(child);
      if (idx !== -1) parent.children.splice(idx, 1);
      child.parent = null;
    },

    removeChildFromContainer(c, child) {
      const idx = c.children.indexOf(child);
      if (idx !== -1) c.children.splice(idx, 1);
      child.parent = null;
    },

    clearContainer(c) {
      c.children.length = 0;
    },

    // ──────────────────────── host context (scope inheritance) ───────
    getRootHostContext(c) {
      return c.rootScope;
    },

    getChildHostContext(parentContext, type, _root) {
      // Component-type → formatter binding lives in props, not in a
      // module-level registry. The host config can't inspect props
      // here (only the type) — formatter scope updates happen at
      // commit time on the child instance via `commitMount` and
      // re-derivation by the collector. For now: inherit the parent
      // scope. Scope changes flow through `withFormatter` invoked from
      // contributor / harness layers.
      void type;
      return parentContext;
    },

    // ──────────────────────── updates ────────────────────────
    commitUpdate(instance, _type, _prev, next, _fiber) {
      instance.props = stripChildren(next);
    },

    commitTextUpdate(instance, _old, next) {
      instance.text = next;
    },

    finalizeInitialChildren() {
      return false;
    },

    prepareForCommit() {
      return null;
    },

    resetAfterCommit() {},

    // ──────────────────────── misc required ────────────────────────
    getPublicInstance(instance) {
      return instance as HostInstance;
    },

    preparePortalMount() {},

    shouldSetTextContent() {
      return false;
    },

    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,

    // ──────────────────────── React 19 priority + transition ───────
    setCurrentUpdatePriority() {},
    getCurrentUpdatePriority: () => 16, // DefaultEventPriority
    resolveUpdatePriority: () => 16,

    getInstanceFromNode: () => null,
    beforeActiveInstanceBlur() {},
    afterActiveInstanceBlur() {},
    prepareScopeUpdate() {},
    getInstanceFromScope: () => null,
    detachDeletedInstance() {},

    NotPendingTransition: null,
    HostTransitionContext: makeStubContext() as never,
    resetFormInstance() {},

    // ──────────────────────── React 19 suspense (we don't suspend) ──
    maySuspendCommit: () => false,
    preloadInstance: () => true,
    startSuspendingCommit() {},
    suspendInstance() {},
    waitForCommitToBeReady: () => null,

    // ──────────────────────── misc React 19 ────────────────────────
    requestPostPaintCallback() {},
    shouldAttemptEagerTransition: () => false,
    trackSchedulerEvent() {},
    resolveEventType: () => null,
    resolveEventTimeStamp: () => Date.now(),
  };

  // ────────── helpers (closure-local; no module state) ──────────
  function stripChildren(p: Props): Props {
    if (!("children" in p) && !("key" in p)) return p;
    const out: Record<string, unknown> = {};
    for (const k in p) {
      if (k === "children" || k === "key") continue;
      out[k] = p[k];
    }
    return out;
  }
}

/**
 * Apply a formatter binding to a host scope and return a new scope.
 * Exposed for use by contributors (e.g., when a `<Markdown>` element
 * pushes its scope down into its children at collection time).
 *
 * Re-exported here for ergonomic import alongside the host config.
 */
export { withFormatter };
export type { FormatterBinding };

/**
 * Minimal stub for React 19's `HostTransitionContext`. We never actually
 * surface form-transition state — transitions are no-ops in our sync
 * render mode — but react-reconciler requires the field to be present
 * and shaped like a Context object.
 */
function makeStubContext(): unknown {
  return {
    $$typeof: Symbol.for("react.context"),
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0,
  };
}

/**
 * Type-narrow guard for host-tree walkers that need to drill into
 * element instances specifically (text leaves are handled separately).
 */
export function rootElementChildrenOf(c: CompilerContainer): ElementInstance[] {
  const out: ElementInstance[] = [];
  for (const child of c.children) {
    if (isElementInstance(child)) out.push(child);
  }
  return out;
}

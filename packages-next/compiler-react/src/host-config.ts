/**
 * `createHostConfig(deps)` — the react-reconciler host-config factory.
 *
 * Owns the bridge between react-reconciler's commit-phase callbacks
 * (createInstance, appendChild, commitUpdate, ...) and our internal
 * `HostInstance` tree (from `@agentick/reconciler-next`). The factory
 * is parameterized via `deps` so reconciler-react-next can EXTEND it
 * — pass extra callbacks for mutation observers, instance-augmentation,
 * etc. — without re-implementing the react-reconciler protocol.
 *
 * Mutation mode (`supportsMutation: true`): react-reconciler commits
 * an in-place mutable tree; we walk the committed tree post-commit
 * to produce IR.
 *
 * No bridges or scheduler integration here. Those are reactive concerns
 * provided by Context wrappers (BridgeProvider / LifecycleContext)
 * supplied by reconciler-react-next when it mounts. The compiler
 * mounts without those wrappers and so reactive hooks have nowhere to
 * route — but react-reconciler still does the function-component-call
 * + Context-propagation + commit work correctly.
 *
 * Adapted from reconciler-react-next/src/host/host-config.ts.
 */

import {
  createElementInstance,
  createTextInstance,
  type ElementInstance,
  type HostInstance,
  type HostScope,
  type Props,
  type ReconcilerContainer,
  type TextInstance,
} from "@agentick/reconciler-next";
import type ReactReconciler from "react-reconciler";

export interface HostConfigDeps {
  /** Container the config writes into. One per mount. */
  readonly container: ReconcilerContainer;
  /**
   * Per-mount id prefix used by host-instance factories. Prevents
   * collisions when multiple mounts share a process.
   */
  readonly idPrefix?: string;
  /**
   * Optional callbacks reconciler-react-next passes when it extends
   * this host config — none of these fire from the compiler's own
   * use, but they're the seam where reactive features hook in.
   */
  readonly onCommit?: (instance: ElementInstance) => void;
  readonly onInstanceCreated?: (instance: ElementInstance) => void;
}

type HC = ReactReconciler.HostConfig<
  string,
  Props,
  ReconcilerContainer,
  ElementInstance,
  TextInstance,
  never,
  never,
  never,
  HostInstance,
  HostScope,
  never,
  ReturnType<typeof setTimeout>,
  -1,
  null
>;

export function createHostConfig(deps: HostConfigDeps): HC {
  const { idPrefix, onCommit, onInstanceCreated } = deps;

  return {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    noTimeout: -1,
    supportsMicrotasks: true,
    scheduleMicrotask: (fn) => queueMicrotask(fn),

    createInstance(type, props, _root, hostContext) {
      const instance = createElementInstance(type, props, hostContext, { idPrefix });
      onInstanceCreated?.(instance);
      return instance;
    },

    createTextInstance(text) {
      return createTextInstance(text, { idPrefix });
    },

    appendInitialChild(parent, child) {
      child.parent = parent;
      parent.children.push(child);
    },

    appendChild(parent, child) {
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

    getRootHostContext(c) {
      return c.rootScope;
    },

    getChildHostContext(parentContext) {
      return parentContext;
    },

    commitUpdate(instance, _type, _prev, next) {
      instance.props = stripReservedProps(next);
      onCommit?.(instance);
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

    getPublicInstance(instance) {
      return instance as HostInstance;
    },

    preparePortalMount() {},

    shouldSetTextContent() {
      return false;
    },

    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,

    setCurrentUpdatePriority() {},
    getCurrentUpdatePriority: () => 16,
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

    maySuspendCommit: () => false,
    preloadInstance: () => true,
    startSuspendingCommit() {},
    suspendInstance() {},
    waitForCommitToBeReady: () => null,

    requestPostPaintCallback() {},
    shouldAttemptEagerTransition: () => false,
    trackSchedulerEvent() {},
    resolveEventType: () => null,
    resolveEventTimeStamp: () => Date.now(),
  };
}

function stripReservedProps(p: Props): Props {
  if (!("children" in p) && !("key" in p)) return p;
  const out: Record<string, unknown> = {};
  for (const k in p) {
    if (k === "children" || k === "key") continue;
    out[k] = p[k];
  }
  return out;
}

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

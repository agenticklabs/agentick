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

import type { ReactNode } from "react";
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
  strictNoSuspense: boolean;
}

export interface ReconcilerHarnessOptions {
  /** Override the built-in contributor set with caller-supplied registry. */
  readonly registry?: ContributorRegistry;
}

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
      state.reconciler.render(state.element, state.root);
    });
  }

  async renderTree(input: RenderTreeInput): Promise<RenderTreeResult> {
    const state = this.mountState(input.mountId);
    const op: Operation<RenderTreeInput, RenderTreeResult> = {
      opId: input.opId ?? `reconciler:render:${input.mountId}:${Date.now()}`,
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
    // Phase 3.10+: dispatch event.kind to registered useOnTickStart /
    // useOnTickEnd / useOnExecutionEnd / useOnError hooks. For now,
    // store on bridges.session-adjacent state if needed and re-render.
    void input;
  }

  async unmount(input: UnmountInput): Promise<void> {
    const state = this.mounts.get(input.mountId);
    if (!state) return;
    state.container.children.length = 0;
    this.mounts.delete(input.mountId);
  }

  async snapshot(input: SnapshotInput): Promise<ReconcilerSnapshot> {
    const state = this.mountState(input.mountId);
    // Phase 3.10+: capture hook state from React fiber tree. For now,
    // return a spec-shaped empty snapshot so persistence round-trips.
    return {
      specVersion: SPEC_VERSION,
      mountId: state.mountId,
      ...(state.elementVersion !== undefined ? { elementVersion: state.elementVersion } : {}),
      hookStates: [],
      dataCache: [],
      knobs: collectKnobs(state.bridges),
      subscriptions: [],
    };
  }

  async restore(input: RestoreInput): Promise<void> {
    // Phase 3.10+: apply snapshot.hookStates / dataCache to the live
    // mount before the next render. For now, just remember the
    // elementVersion in case the runtime checks it.
    const state = this.mounts.get(input.mountId);
    if (!state) return;
    if (input.elementVersion !== undefined) state.elementVersion = input.elementVersion;
    void input.snapshot;
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
    const reconciler = createReconciler({ container, idPrefix: input.mountId });
    const root = reconciler.createRoot();
    const state: MountState = {
      mountId: input.mountId,
      element: input.element as ReactNode,
      ...(input.elementVersion !== undefined ? { elementVersion: input.elementVersion } : {}),
      bridges: input.bridges,
      container,
      reconciler,
      root,
      registry: this.registry,
      rootScope,
      strictNoSuspense: input.strictNoSuspense ?? false,
    };
    this.mounts.set(input.mountId, state);

    // Initial render so the host tree is populated.
    state.reconciler.render(state.element, state.root);

    const restoredFromSnapshot = input.snapshot !== undefined;
    if (restoredFromSnapshot) {
      // Phase 3.10+: apply snapshot before first renderTree.
      void input.snapshot;
    }

    return { mountId: input.mountId, restoredFromSnapshot };
  }

  private async renderTreeBody(
    _input: RenderTreeInput,
    state: MountState,
  ): Promise<RenderTreeResult> {
    // Synchronous render (no useData loop yet — Phase 3.10).
    state.reconciler.render(state.element, state.root);
    const result = collect({
      roots: state.container.children,
      registry: state.registry,
      rootScope: state.rootScope,
    });
    return {
      tree: result.tree,
      diagnostics: result.diagnostics.map((d) => ({
        severity: d.severity,
        code: d.code ?? "diagnostic",
        message: d.message,
        ...(d.path !== undefined ? { path: d.path } : {}),
        ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
      })),
      iterations: 1,
    };
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

function collectKnobs(bridges: HookBridges): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of bridges.knobs.list()) out[k.id] = k.value;
  return out;
}

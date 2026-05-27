/**
 * `defineReconciler` — callback-style `ReconcilerProtocol` factory.
 *
 * Lives in `@agentick/runtime` (not a reconciler-specific package)
 * because the factory is reconciler-implementation-agnostic — it lets
 * adopters wire any reconciler (Angular, Vue, custom) to the framework
 * without depending on `@agentick/reconciler-react`.
 *
 * MVP scope: callback bundle satisfies the protocol; required callbacks
 * are `mount`, `unmount`, `renderTree`. Other methods default to either
 * no-ops or "method not configured" — adopters override what they need.
 *
 * ```ts
 * const myReconciler = defineReconciler({
 *   mount: async (input) => ({ mountId: ulid() }),
 *   unmount: async () => {},
 *   renderTree: async (input) => ({
 *     mountId: input.mountId,
 *     tree: ...,
 *     diagnostics: { warnings: [], errors: [] },
 *   }),
 * });
 *
 * const app = await createApp(<Agent />, {
 *   executor: openai("gpt-4o"),
 *   reconciler: myReconciler,
 * });
 * ```
 *
 * Most adopters use the bundled `ReconcilerHarness` from
 * `@agentick/reconciler-react`. `defineReconciler` exists for the
 * cases where the React reconciler isn't the right fit (Angular impl,
 * custom DSL, test harness with no JSX).
 *
 * @see docs/proposals/v2/IMPLEMENTATION-PLAN.md (FAÇADE.6)
 */

import { Effect } from "effect";
import {
  BaseHarness,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  MountInput,
  MountResult,
  NotifyLifecycleInput,
  Operation,
  OperationJournal,
  ReconcilerFactory,
  ReconcilerFactoryDeps,
  ReconcilerProtocol,
  ReconcilerSnapshot,
  RenderToStringInput,
  RenderToStringResult,
  RenderTreeInput,
  RenderTreeResult,
  RerenderInput,
  RestoreInput,
  SnapshotInput,
  UnmountInput,
} from "@agentick/spec";

// ============================================================================
// Public API
// ============================================================================

export interface DefineReconcilerInput {
  // ── Required: lifecycle + canonical render ───────────────────────────
  readonly mount: (input: MountInput) => Promise<MountResult>;
  readonly unmount: (input: UnmountInput) => Promise<void>;
  readonly renderTree: (input: RenderTreeInput) => Promise<RenderTreeResult>;

  // ── Optional: secondary surfaces ─────────────────────────────────────
  readonly rerender?: (input: RerenderInput) => Promise<void>;
  readonly renderToString?: (input: RenderToStringInput) => Promise<RenderToStringResult>;
  readonly notifyLifecycle?: (input: NotifyLifecycleInput) => Promise<void>;
  readonly snapshot?: (input: SnapshotInput) => Promise<ReconcilerSnapshot>;
  readonly restore?: (input: RestoreInput) => Promise<void>;
}

export function defineReconciler(spec: DefineReconcilerInput): ReconcilerFactory {
  const factory = (deps?: ReconcilerFactoryDeps): ReconcilerProtocol => {
    const scopeId = deps?.scopeId ?? `define-reconciler:${ulid()}`;
    const journal = deps?.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? new LocalInbox();
    return new CallbackReconciler(scopeId, journal, bus, inbox, spec);
  };
  return Object.assign(factory, { reconcilerFactory: true as const });
}

// ============================================================================
// CallbackReconciler
// ============================================================================

class CallbackReconciler extends BaseHarness<"reconciler"> implements ReconcilerProtocol {
  private readonly spec: DefineReconcilerInput;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    spec: DefineReconcilerInput,
  ) {
    super("reconciler", scopeId, journal, bus, inbox);
    this.spec = spec;
  }

  // ──────── ReconcilerProtocol ────────

  mount(input: MountInput): Promise<MountResult> {
    const op: Operation<MountInput, MountResult> = {
      opId: `reconciler:mount:${ulid()}`,
      surface: "reconciler",
      name: "reconciler:command:mount",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => Effect.promise(() => this.spec.mount(i))),
    );
  }

  rerender(input: RerenderInput): Promise<void> {
    if (!this.spec.rerender) return Promise.resolve();
    const op: Operation<RerenderInput, void> = {
      opId: `reconciler:rerender:${ulid()}`,
      surface: "reconciler",
      name: "reconciler:command:rerender",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => Effect.promise(() => this.spec.rerender!(i))),
    );
  }

  renderTree(input: RenderTreeInput): Promise<RenderTreeResult> {
    const op: Operation<RenderTreeInput, RenderTreeResult> = {
      opId: `reconciler:render-tree:${ulid()}`,
      surface: "reconciler",
      name: "reconciler:command:render-tree",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => Effect.promise(() => this.spec.renderTree(i))),
    );
  }

  renderToString(input: RenderToStringInput): Promise<RenderToStringResult> {
    if (!this.spec.renderToString) {
      return Promise.reject(new Error("defineReconciler: renderToString() not configured"));
    }
    return this.spec.renderToString(input);
  }

  notifyLifecycle(input: NotifyLifecycleInput): Promise<void> {
    if (!this.spec.notifyLifecycle) return Promise.resolve();
    return this.spec.notifyLifecycle(input);
  }

  unmount(input: UnmountInput): Promise<void> {
    const op: Operation<UnmountInput, void> = {
      opId: `reconciler:unmount:${ulid()}`,
      surface: "reconciler",
      name: "reconciler:command:unmount",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => Effect.promise(() => this.spec.unmount(i))),
    );
  }

  snapshot(input: SnapshotInput): Promise<ReconcilerSnapshot> {
    if (!this.spec.snapshot) {
      return Promise.reject(new Error("defineReconciler: snapshot() not configured"));
    }
    return this.spec.snapshot(input);
  }

  restore(input: RestoreInput): Promise<void> {
    if (!this.spec.restore) return Promise.resolve();
    return this.spec.restore(input);
  }

  // ──────── inbox dispatch (deferred) ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("defineReconciler inbox dispatch not yet wired (FAÇADE.6 MVP)"),
    });
  }
}

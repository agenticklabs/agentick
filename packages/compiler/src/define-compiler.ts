/**
 * `defineCompiler` — callback-style `CompilerProtocol` factory.
 *
 * Lives in `@agentick/runtime` (not a compiler-specific package)
 * because the factory is compiler-implementation-agnostic — it lets
 * adopters wire any compiler (Angular, Vue, custom) to the framework
 * without depending on `@agentick/compiler-react`.
 *
 * MVP scope: callback bundle satisfies the protocol; required callbacks
 * are `mount`, `unmount`, `renderTree`. Other methods default to either
 * no-ops or "method not configured" — adopters override what they need.
 *
 * ```ts
 * const myCompiler = defineCompiler({
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
 *   model: openai("gpt-4o"),
 *   compiler: myCompiler,
 * });
 * ```
 *
 * Most adopters use the bundled `CompilerHarness` from
 * `@agentick/compiler-react`. `defineCompiler` exists for the
 * cases where the React compiler isn't the right fit (Angular impl,
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
  Operation,
  OperationJournal,
  CompilerFactory,
  CompilerFactoryDeps,
  CompilerFx,
  CompilerProtocol,
  CompilerSnapshot,
  RenderToStringInput,
  RenderToStringResult,
  RenderTreeInput,
  RenderTreeResult,
  RerenderInput,
  RestoreInput,
  SnapshotInput,
  SubstrateError,
  UnmountInput,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";

// ============================================================================
// Public API
// ============================================================================

export interface DefineCompilerInput {
  // ── Required: lifecycle + canonical render ───────────────────────────
  readonly mount: (input: MountInput) => Promise<MountResult>;
  readonly unmount: (input: UnmountInput) => Promise<void>;
  readonly renderTree: (input: RenderTreeInput) => Promise<RenderTreeResult>;

  // ── Optional: secondary surfaces ─────────────────────────────────────
  readonly rerender?: (input: RerenderInput) => Promise<void>;
  readonly renderToString?: (input: RenderToStringInput) => Promise<RenderToStringResult>;
  readonly snapshot?: (input: SnapshotInput) => Promise<CompilerSnapshot>;
  readonly restore?: (input: RestoreInput) => Promise<void>;
}

export function defineCompiler(spec: DefineCompilerInput): CompilerFactory {
  const factory = (deps?: CompilerFactoryDeps): CompilerProtocol => {
    const scopeId = deps?.scopeId ?? `define-compiler:${ulid()}`;
    const journal = deps?.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? new LocalInbox();
    return new CallbackCompiler(scopeId, journal, bus, inbox, spec);
  };
  return Object.assign(factory, { compilerFactory: true as const });
}

// ============================================================================
// CallbackCompiler
// ============================================================================

class CallbackCompiler extends BaseHarness<"compiler"> implements CompilerProtocol {
  private readonly spec: DefineCompilerInput;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    spec: DefineCompilerInput,
  ) {
    super("compiler", scopeId, journal, bus, inbox);
    this.spec = spec;
  }

  // ──────── CompilerProtocol ────────

  mount(input: MountInput): Promise<MountResult> {
    const op: Operation<MountInput, MountResult> = {
      opId: `compiler:mount:${ulid()}`,
      surface: "compiler",
      name: "compiler:command:mount",
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
      opId: `compiler:rerender:${ulid()}`,
      surface: "compiler",
      name: "compiler:command:rerender",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => Effect.promise(() => this.spec.rerender!(i))),
    );
  }

  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * loop reaches `compiler.fx.renderTree(...)` to compose the render
   * into one fiber tree (Stage 3); the plain `renderTree(...)` Promise
   * below is the derived facade. Both drive the SAME Operation —
   * `fx.renderTree` is `renderTree` minus the terminal `runPromise`.
   */
  get fx(): CompilerFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      renderTree: (input) => this.renderTreeFx(input),
    };
  }

  /**
   * The composable `renderTree` Effect the harness builds — the
   * `.fx.renderTree` twin. Returns `runOperation(op, body)` un-run, so an
   * in-process caller stays in one fiber. {@link renderTree} is the facade.
   * The render itself is an adopter callback via `Effect.promise` (a
   * rejection defects), so the `E` channel is just `SubstrateError`.
   */
  private renderTreeFx(
    input: RenderTreeInput,
  ): Effect.Effect<RenderTreeResult, SubstrateError, never> {
    const op: Operation<RenderTreeInput, RenderTreeResult, never> = {
      opId: `compiler:render-tree:${ulid()}`,
      surface: "compiler",
      name: "compiler:command:render-tree",
      scope: {},
      input,
    };
    return this.runOperation(op, (i) => Effect.promise(() => this.spec.renderTree(i)));
  }

  renderTree(input: RenderTreeInput): Promise<RenderTreeResult> {
    return runHarnessProtocol(this.renderTreeFx(input));
  }

  renderToString(input: RenderToStringInput): Promise<RenderToStringResult> {
    if (!this.spec.renderToString) {
      return Promise.reject(new Error("defineCompiler: renderToString() not configured"));
    }
    return this.spec.renderToString(input);
  }

  unmount(input: UnmountInput): Promise<void> {
    const op: Operation<UnmountInput, void> = {
      opId: `compiler:unmount:${ulid()}`,
      surface: "compiler",
      name: "compiler:command:unmount",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => Effect.promise(() => this.spec.unmount(i))),
    );
  }

  snapshot(input: SnapshotInput): Promise<CompilerSnapshot> {
    if (!this.spec.snapshot) {
      return Promise.reject(new Error("defineCompiler: snapshot() not configured"));
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
    return Effect.fail(
      new HandlerError({
        cause: new Error("defineCompiler inbox dispatch not yet wired (FAÇADE.6 MVP)"),
      }),
    );
  }
}

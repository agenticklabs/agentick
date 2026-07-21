/**
 * `defineToolExecutor` — callback-style `ToolExecutorProtocol` factory.
 *
 * Lets a user satisfy `ToolExecutorProtocol` without subclassing
 * `BaseHarness`. Bring a `dispatch(input)` callback (and optionally
 * `list` / `abort`), receive a `ToolExecutorFactory` ready to drop into
 * `createApp({ tools: ... })` (slot accepts factories alongside the
 * existing options shape).
 *
 * ```ts
 * const myTools = defineToolExecutor({
 *   async dispatch(input) {
 *     const result = await remoteToolService.run(input.name, input.input);
 *     return {
 *       toolCallId: input.toolCallId,
 *       name: input.name,
 *       content: [{ type: "text", text: result.text }],
 *       // isError?: true for a SOFT/domain error (ADR 70); throw for a HARD failure.
 *     };
 *   },
 * });
 *
 * const app = await createApp(<Agent />, {
 *   model: openai("gpt-4o-mini"),
 *   tools: myTools,
 * });
 * ```
 *
 * Under the hood the factory constructs a `CallbackToolExecutor` —
 * a thin `BaseHarness<"tool">` subclass that delegates the
 * `register / unregister / list / dispatch / abort` surface to the
 * supplied callbacks. The substrate phase contract (envelope sequence,
 * journal, OTel spans) applies uniformly.
 *
 * MVP scope: dispatch is REQUIRED; list defaults to the harness's
 * in-memory registry (register/unregister mutate it). Adopters who
 * want fully custom registry behavior provide their own list/register/
 * unregister callbacks (registry is then opaque to the harness).
 * Validation pipeline and confirmation flow are NOT replicated here;
 * adopters who want them should subclass `ToolExecutorHarness`.
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
} from "@agentick/runtime-next";
import type {
  AbortInput,
  DispatchInput,
  DispatchResult,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  RegisterToolInput,
  RemoveBoundToolsInput,
  ReplaceReconcilerToolsInput,
  RespondToToolCallInput,
  SubstrateError,
  ToolDeclaration,
  ToolExecutorErrorChannel,
  ToolExecutorFactory,
  ToolExecutorFactoryDeps,
  ToolExecutorFx,
  ToolExecutorProtocol,
  ToolListFilter,
  UnregisterToolInput,
} from "@agentick/spec-next";
import { HandlerError, ToolAbortedError, ToolValidationError } from "@agentick/spec-next";

import { InMemoryToolRegistry, sameBindingKey } from "./registry.js";
import { viaToOrigin } from "./provenance.js";
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// Public API
// ============================================================================

export interface DefineToolExecutorInput {
  /**
   * Per-dispatch callback. Receives the validated `DispatchInput`
   * (already-resolved name, validated input) and a context bag. Returns
   * the canonical `DispatchResult`.
   *
   * Throw to fail the dispatch — the harness translates exceptions into
   * the terminal envelope with `outcome: "failed"`.
   */
  readonly dispatch: (
    input: DispatchInput,
    ctx: {
      readonly signal?: AbortSignal;
    },
  ) => Promise<DispatchResult>;

  /**
   * Optional custom list callback. When omitted, the harness's internal
   * in-memory registry is used. Provide this when storage is external
   * (database, remote service, etc.).
   */
  readonly list?: (filter?: ToolListFilter) => Promise<readonly ToolDeclaration[]>;

  /**
   * Optional custom register callback. When omitted, the harness's
   * internal registry handles registration. Provide together with `list`
   * for fully-custom registry storage.
   */
  readonly register?: (input: RegisterToolInput) => Promise<void>;

  /**
   * Optional custom unregister callback. When omitted, the harness's
   * internal registry handles removal.
   */
  readonly unregister?: (input: UnregisterToolInput) => Promise<void>;

  /**
   * Optional custom abort callback. When omitted, the harness aborts
   * via the in-flight controller it tracks per dispatch.
   */
  readonly abort?: (input: AbortInput) => Promise<void>;

  /**
   * Optional custom `replaceReconcilerTools` callback. When omitted,
   * the harness's internal registry handles the atomic swap. Provide
   * together with the storage-set (`list`, `register`, `unregister`)
   * for fully-custom registry storage.
   */
  readonly replaceReconcilerTools?: (input: ReplaceReconcilerToolsInput) => Promise<void>;

  /**
   * Optional custom `removeBoundTools` callback. When omitted, the
   * harness's internal registry handles removal (bulk by binding key, or
   * the `name`-narrowed targeted remove). Returns the COUNT of
   * registrations removed — the honest existence signal the client-tool
   * wire path reads.
   */
  readonly removeBoundTools?: (input: RemoveBoundToolsInput) => Promise<number>;

  /**
   * Optional custom `compileForTick` callback. When omitted, the
   * harness's internal registry resolves precedence. Provide for
   * fully-custom registry storage that wants to short-circuit the
   * default resolver.
   */
  readonly compileForTick?: (filter?: ToolListFilter) => Promise<readonly ToolDeclaration[]>;
}

/**
 * Construct a `ToolExecutorFactory` from a callback bundle. Plug the
 * factory into `createApp({ tools: ... })` to share substrate, or
 * invoke standalone for testing.
 */
export function defineToolExecutor(spec: DefineToolExecutorInput): ToolExecutorFactory {
  const factory = (deps?: ToolExecutorFactoryDeps): ToolExecutorProtocol => {
    const scopeId = deps?.scopeId ?? `define-tool-executor:${ulid()}`;
    const journal = deps?.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? new LocalInbox();
    return new CallbackToolExecutor(scopeId, journal, bus, inbox, spec);
  };
  return Object.assign(factory, { toolExecutorFactory: true as const });
}

// ============================================================================
// CallbackToolExecutor
// ============================================================================

interface InFlightEntry {
  readonly toolCallId: string;
  readonly controller: AbortController;
}

class CallbackToolExecutor extends BaseHarness<"tool"> implements ToolExecutorProtocol {
  private readonly spec: DefineToolExecutorInput;
  private readonly registry: InMemoryToolRegistry;
  private readonly inFlight = new Map<string, InFlightEntry>();

  /**
   * Cancel an in-flight dispatch — a declared command (`tool:abort`),
   * identical to the reference `ToolExecutorHarness`. Declaring it here
   * closes the #31 gap: a `defineToolExecutor` executor is now
   * inbox-abortable (`BaseHarness.dispatchMessage` auto-routes a
   * `tool:abort` message to this command), where its `handleMessage`
   * previously rejected EVERY inbox message. Honors the adopter's custom
   * `abort` callback when supplied; otherwise fires the in-flight
   * controller synchronously.
   */
  readonly abort: (input: AbortInput) => Promise<void>;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    spec: DefineToolExecutorInput,
  ) {
    super("tool", scopeId, journal, bus, inbox);
    this.spec = spec;
    this.registry = new InMemoryToolRegistry();
    this.abort = this.command<AbortInput, void, unknown>({
      name: "tool:abort",
      scope: () => ({ sessionId: this.scopeId }),
      handler: (i) =>
        this.spec.abort
          ? Effect.tryPromise({ try: () => this.spec.abort!(i), catch: (cause) => cause })
          : Effect.sync(() => this.abortInFlight(i)),
    });
    // Registers the `tool:dispatch` command (reached via `commandEffect`
    // in `dispatchFx`, and inbox/wire dispatch-by-name). Return unused —
    // the public `dispatch` derives from the `.fx` twin.
    this.command<DispatchInput, DispatchResult, unknown>({
      name: "tool:dispatch",
      // Deterministic opId keyed by `toolCallId` — preserves dispatch
      // idempotency (repeat dispatch replays the cached terminal, no
      // re-execution). Mirrors ToolExecutorHarness (ADR 51).
      opId: (i) => i.opId ?? `tool:dispatch:${i.toolCallId}`,
      scope: (i) =>
        omitUndefined({
          sessionId: i.context.sessionId,
          executionId: i.context.executionId,
          tickId: i.context.tickId,
        }),
      handler: (i) => this.dispatchBody(i),
    });
  }

  // ──────── ToolExecutorProtocol ────────

  register(input: RegisterToolInput): Promise<void> {
    const op: Operation<RegisterToolInput, void> = {
      opId: input.opId ?? `tool:register:${input.registration.declaration.name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:register",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async () => {
            if (this.spec.register) {
              await this.spec.register(i);
            } else {
              this.registry.add(i.registration);
            }
          },
          catch: (cause) => ({
            _tag: "ToolHandlerError" as const,
            toolName: i.registration.declaration.name,
            cause,
          }),
        }),
      ),
    );
  }

  /**
   * Land a CLIENT's relayed tool-call result — identical inbox route to
   * {@link ToolExecutorHarness.respondToToolCall} (mirrors
   * `elicitation.respond`). A `defineToolExecutor` executor is equally
   * client-tool-capable: the result resolves through
   * `BaseHarness.dispatchMessage`'s `request-response` auto-intercept.
   */
  async respondToToolCall(input: RespondToToolCallInput): Promise<void> {
    const send = this.inbox.send(this.address, {
      type: "request-response",
      correlationId: input.correlationId,
      payload: { correlationId: input.correlationId, response: input.result },
    });
    await Effect.runPromise(
      send.pipe(
        Effect.catchAll((err) => {
          if (
            typeof err === "object" &&
            err !== null &&
            (err as { _tag?: string })._tag === "AddressNotFound"
          ) {
            return Effect.succeed(undefined);
          }
          return Effect.fail(err);
        }),
      ),
    );
  }

  unregister(input: UnregisterToolInput): Promise<void> {
    const op: Operation<UnregisterToolInput, void> = {
      opId: input.opId ?? `tool:unregister:${input.name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:unregister",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async () => {
            if (this.spec.unregister) {
              await this.spec.unregister(i);
            } else {
              this.registry.remove(i.name);
            }
          },
          catch: (cause) => ({ _tag: "ToolHandlerError" as const, toolName: i.name, cause }),
        }),
      ),
    );
  }

  async list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    // Pure read — bypass runOperation. Matches the reference harness.
    if (this.spec.list) return this.spec.list(filter);
    return this.registry.list(filter);
  }

  removeBoundTools(input: RemoveBoundToolsInput): Promise<number> {
    const op: Operation<RemoveBoundToolsInput, number> = {
      opId: input.opId ?? `tool:remove-bound:${input.binding.scope}:${ulid()}`,
      surface: "tool",
      name: "tool:command:remove-bound-tools",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async (): Promise<number> => {
            if (this.spec.removeBoundTools) {
              return await this.spec.removeBoundTools(i);
            }
            // Bulk binding sweep — clears a whole slice (lifecycle close, or
            // the `set_client_tools` client-slice clear). Reports the count.
            return this.registry.removeWhere((b) => sameBindingKey(b, i.binding));
          },
          catch: (cause) => cause,
        }),
      ),
    );
  }

  /**
   * The composable `replaceReconcilerTools` Effect — the
   * `.fx.replaceReconcilerTools` twin (see the harness impl for the
   * design). Returns `runOperation(op, body)` un-run so the loop composes
   * the reconciler-slice swap in-fiber. A binding mismatch (or a rejecting
   * spec override) surfaces as a tagged `ToolValidationError` on the `E`
   * channel. {@link replaceReconcilerTools} is the facade.
   */
  private replaceReconcilerToolsFx(
    input: ReplaceReconcilerToolsInput,
  ): Effect.Effect<void, ToolExecutorErrorChannel | SubstrateError, never> {
    const op: Operation<ReplaceReconcilerToolsInput, void, ToolExecutorErrorChannel> = {
      opId: input.opId ?? `tool:replace-reconciler:${input.mountId}:${ulid()}`,
      surface: "tool",
      name: "tool:command:replace-reconciler-tools",
      scope: {},
      input,
    };
    return this.runOperation(op, (i) =>
      Effect.tryPromise({
        try: async () => {
          if (this.spec.replaceReconcilerTools) {
            await this.spec.replaceReconcilerTools(i);
          } else {
            this.registry.replaceReconcilerSlice(i.mountId, i.registrations);
          }
        },
        catch: (cause): ToolExecutorErrorChannel =>
          new ToolValidationError({
            toolName: `reconciler-slice:${i.mountId}`,
            issues: [{ message: cause instanceof Error ? cause.message : String(cause) }],
            cause,
          }),
      }),
    );
  }

  replaceReconcilerTools(input: ReplaceReconcilerToolsInput): Promise<void> {
    return runHarnessProtocol(this.replaceReconcilerToolsFx(input));
  }

  /**
   * The composable `compileForTick` Effect — the `.fx.compileForTick`
   * twin. A pure read: `Effect.sync` over the registry, or `Effect.promise`
   * over an async spec override. No `runOperation`; the loop composes it
   * in-fiber. {@link compileForTick} is the bare-`async` facade.
   */
  private compileForTickFx(
    filter?: ToolListFilter,
  ): Effect.Effect<readonly ToolDeclaration[], never, never> {
    return this.spec.compileForTick
      ? Effect.promise(() => this.spec.compileForTick!(filter))
      : Effect.sync(() => this.registry.compileForTick(filter));
  }

  async compileForTick(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    if (this.spec.compileForTick) return this.spec.compileForTick(filter);
    return this.registry.compileForTick(filter);
  }

  /**
   * Dispatch through the declared `tool:dispatch` command. The public
   * in-process gate stamps PROVENANCE (ADR 51 §5/§6) off the dispatch
   * door: `via: "model"` → `origin: "model"`, `via: "dispatch"` →
   * `origin: "host"`. Inbox-delivered `tool:dispatch` messages are
   * stamped by their delivering gate instead (see {@link viaToOrigin}).
   */
  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * loop reaches `toolExecutor.fx.dispatch(...)` to compose a tool call
   * into one fiber tree (Stage 3); `dispatch(...)` below is the derived
   * facade. The twin hand-authors over `commandEffect` (not `fxProxy`) to
   * preserve the door → origin mapping the facade applies.
   */
  get fx(): ToolExecutorFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      dispatch: (input) => this.dispatchFx(input),
      replaceReconcilerTools: (input) => this.replaceReconcilerToolsFx(input),
      compileForTick: (filter) => this.compileForTickFx(filter),
    };
  }

  /**
   * The composable `dispatch` Effect — the `.fx.dispatch` twin. Resolves
   * the declared `tool:dispatch` command via `commandEffect`, stamping the
   * origin from the dispatch door, un-run. {@link dispatch} is the facade.
   * The body's declared `unknown` error is narrowed to the protocol
   * contract (`ToolExecutorError`); handler throws become a `DispatchResult`.
   */
  private dispatchFx(
    input: DispatchInput,
  ): Effect.Effect<DispatchResult, ToolExecutorErrorChannel | SubstrateError, never> {
    return this.commandEffect<DispatchInput, DispatchResult, ToolExecutorErrorChannel>(
      "tool:dispatch",
      input,
      { origin: viaToOrigin(input.context.via) },
    );
  }

  dispatch(input: DispatchInput): Promise<DispatchResult> {
    return runHarnessProtocol(this.dispatchFx(input));
  }

  /**
   * Default abort body — fires the in-flight AbortController with a real
   * `ToolAbortedError` instance (so the dispatch rejects with
   * `instanceof ToolAbortedError` on both the direct and inbox paths).
   * No-op for unknown ids. Used when the adopter supplies no custom
   * `abort` callback.
   */
  private abortInFlight(input: AbortInput): void {
    const entry = this.inFlight.get(input.toolCallId);
    if (!entry) return;
    entry.controller.abort(
      new ToolAbortedError({ toolCallId: input.toolCallId, reason: input.reason }),
    );
  }

  // ──────── inbox dispatch ────────

  /**
   * Inbox fallthrough. `abort` (`tool:abort`) is a declared command, so
   * `BaseHarness.dispatchMessage` auto-routes it before reaching here —
   * closing the gap where this method previously rejected EVERY inbox
   * message. Anything else is genuinely unknown ⇒ `HandlerError`.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error(`defineToolExecutor inbox: unknown message type "${msg.type}"`),
      }),
    );
  }

  // ──────── internals ────────

  private dispatchBody(input: DispatchInput): Effect.Effect<DispatchResult, unknown, never> {
    return Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        // Honor caller-supplied signal — when the caller aborts, we forward.
        if (input.signal) {
          if (input.signal.aborted) {
            controller.abort(input.signal.reason);
          } else {
            input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), {
              once: true,
            });
          }
        }
        this.inFlight.set(input.toolCallId, { toolCallId: input.toolCallId, controller });
        try {
          const result = await this.spec.dispatch(input, { signal: controller.signal });
          return result;
        } finally {
          this.inFlight.delete(input.toolCallId);
        }
      },
      catch: (cause) => {
        if (
          cause &&
          typeof cause === "object" &&
          "_tag" in cause &&
          typeof (cause as { _tag?: unknown })._tag === "string"
        ) {
          return cause;
        }
        return { _tag: "ToolHandlerError" as const, toolName: input.name, cause };
      },
    });
  }
}

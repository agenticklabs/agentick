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
 *       succeeded: true,
 *       content: [{ type: "text", text: result.text }],
 *     };
 *   },
 * });
 *
 * const app = await createApp(<Agent />, {
 *   executor: openai("gpt-4o-mini"),
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
  ToolDeclaration,
  ToolExecutorFactory,
  ToolExecutorFactoryDeps,
  ToolExecutorProtocol,
  ToolListFilter,
  UnregisterToolInput,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

import { InMemoryToolRegistry, sameBindingKey } from "./registry.js";
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
   * harness's internal registry handles bulk removal by binding key.
   */
  readonly removeBoundTools?: (input: RemoveBoundToolsInput) => Promise<void>;

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

  removeBoundTools(input: RemoveBoundToolsInput): Promise<void> {
    const op: Operation<RemoveBoundToolsInput, void> = {
      opId: input.opId ?? `tool:remove-bound:${input.binding.scope}:${ulid()}`,
      surface: "tool",
      name: "tool:command:remove-bound-tools",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async () => {
            if (this.spec.removeBoundTools) {
              await this.spec.removeBoundTools(i);
            } else {
              this.registry.removeWhere((b) => sameBindingKey(b, i.binding));
            }
          },
          catch: (cause) => cause,
        }),
      ),
    );
  }

  replaceReconcilerTools(input: ReplaceReconcilerToolsInput): Promise<void> {
    const op: Operation<ReplaceReconcilerToolsInput, void> = {
      opId: input.opId ?? `tool:replace-reconciler:${input.mountId}:${ulid()}`,
      surface: "tool",
      name: "tool:command:replace-reconciler-tools",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async () => {
            if (this.spec.replaceReconcilerTools) {
              await this.spec.replaceReconcilerTools(i);
            } else {
              this.registry.replaceReconcilerSlice(i.mountId, i.registrations);
            }
          },
          catch: (cause) => cause,
        }),
      ),
    );
  }

  async compileForTick(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    if (this.spec.compileForTick) return this.spec.compileForTick(filter);
    return this.registry.compileForTick(filter);
  }

  dispatch(input: DispatchInput): Promise<DispatchResult> {
    const op: Operation<DispatchInput, DispatchResult> = {
      opId: input.opId ?? `tool:dispatch:${input.toolCallId}`,
      surface: "tool",
      name: "tool:command:dispatch",
      scope: {
        ...omitUndefined({
          sessionId: input.context.sessionId,
          executionId: input.context.executionId,
          tickId: input.context.tickId,
        }),
      },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.dispatchBody(i)));
  }

  async abort(input: AbortInput): Promise<void> {
    if (this.spec.abort) {
      await this.spec.abort(input);
      return;
    }
    const entry = this.inFlight.get(input.toolCallId);
    if (!entry) return;
    entry.controller.abort({
      _tag: "ToolAbortedError",
      toolCallId: input.toolCallId,
      ...omitUndefined({ reason: input.reason }),
    });
  }

  // ──────── inbox dispatch (deferred) ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error("defineToolExecutor inbox dispatch not yet wired (FAÇADE.6 MVP)"),
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

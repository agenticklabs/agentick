/**
 * `ToolExecutorHarness` — reference implementation of
 * `ToolExecutorProtocol`.
 *
 * Extends `BaseHarness<"tool">` from `@agentick/runtime`. Owns:
 *
 *   - an in-memory tool registry (declaration + handlerRef + useDeps),
 *   - a handler resolver (handlerRef → handler + validator),
 *   - a per-call AbortController map for in-flight tracking.
 *
 * Validation, exposure checks, handler invocation, and abort all run
 * inside `runOperation`, so every dispatch produces the canonical
 * phase-contract envelope sequence
 * (`requested → before → terminal`) on `surface: "tool"`.
 *
 * Phase 4a.4 covers the happy path + abort. Confirmation flow (4a.5),
 * middleware + lifecycle handler hooks (4a.6), and inbox dispatcher
 * (4a.7) land in follow-up commits.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import { ulid } from "@agentick/runtime";
import { BaseHarness } from "@agentick/runtime";
import type {
  AbortInput,
  ContentBlock,
  DispatchInput,
  DispatchResult,
  EventBus,
  MessageEnvelope,
  MessageInbox,
  Operation,
  OperationJournal,
  RegisterToolInput,
  ToolDeclaration,
  ToolExecutorProtocol,
  ToolListFilter,
  ToolRegistration,
  UnregisterToolInput,
} from "@agentick/spec";

import { InMemoryToolRegistry } from "./registry.js";
import type {
  HandlerEntry,
  HandlerResolver,
  HandlerChannelSeed,
  ToolExecutorHarnessOptions,
  ToolHandlerCtx,
  ValidatorResult,
} from "./types.js";

interface InFlightEntry {
  readonly controller: AbortController;
  readonly toolName: string;
}

export class ToolExecutorHarness
  extends BaseHarness<"tool">
  implements ToolExecutorProtocol
{
  private readonly registry = new InMemoryToolRegistry();
  private readonly handlerResolver: HandlerResolver;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly stateStore = new Map<string, unknown>();
  private readonly defaultTimeoutMs?: number;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ToolExecutorHarnessOptions,
  ) {
    super("tool", scopeId, journal, bus, inbox);
    this.handlerResolver = options.handlerResolver;
    this.defaultTimeoutMs = options.defaultTimeoutMs;

    // Eager registrations applied synchronously so callers can dispatch
    // immediately after `await harness.ready`.
    if (options.initialTools) {
      for (const reg of options.initialTools) this.registry.add(reg);
    }
  }

  // ──────────────────────── ToolExecutorProtocol ────────────────────────

  async register(input: RegisterToolInput): Promise<void> {
    const name = input.registration.declaration.name;
    const op: Operation<RegisterToolInput, void> = {
      opId: input.opId ?? `tool:register:${name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:register",
      scope: {},
      input,
    };
    return this.runOperation(op, async (i) => {
      this.registry.add(i.registration);
    });
  }

  async unregister(input: UnregisterToolInput): Promise<void> {
    const op: Operation<UnregisterToolInput, void> = {
      opId: input.opId ?? `tool:unregister:${input.name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:unregister",
      scope: {},
      input,
    };
    return this.runOperation(op, async (i) => {
      this.registry.remove(i.name);
    });
  }

  async list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    // Pure read — bypass runOperation so list() doesn't pollute the
    // journal with no-op envelopes. Conformance only requires correct
    // shape; the bus / journal don't care about reads.
    return this.registry.list(filter);
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const op: Operation<DispatchInput, DispatchResult> = {
      opId: input.opId ?? `tool:dispatch:${input.toolCallId}`,
      surface: "tool",
      name: "tool:command:dispatch",
      scope: {
        sessionId: input.context.sessionId,
        executionId: input.context.executionId,
        tickId: input.context.tickId,
      },
      input,
    };
    return this.runOperation(op, async (i) => this.dispatchBody(i));
  }

  async abort(input: AbortInput): Promise<void> {
    const entry = this.inFlight.get(input.toolCallId);
    if (!entry) return; // no-op for unknown ids
    entry.controller.abort({
      _tag: "ToolAbortedError",
      toolCallId: input.toolCallId,
      reason: input.reason,
    });
    // The dispatchBody promise will see the abort + reject with
    // ToolAbortedError; we leave cleanup of inFlight to the dispatch
    // path's `finally`.
  }

  // ──────────────────────── State store (handler ctx) ────────────────────────

  /**
   * Read state previously set by a tool handler via
   * `ctx.setState(key, value)`. Used by the stateful tool render
   * pattern (`<Tool render={() => …}>`).
   */
  getState(key: string): unknown {
    return this.stateStore.get(key);
  }

  /** Snapshot the entire handler state map. */
  snapshotState(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(this.stateStore.entries());
  }

  // ──────────────────────── inbox dispatch ────────────────────────

  /**
   * Inbox dispatcher. The full message handling (abort + confirmation
   * response) lands in Phase 4a.7. For now we reject unknown messages
   * via the BaseHarness default `HandlerError` envelope.
   */
  protected async handleMessage(_msg: MessageEnvelope): Promise<unknown> {
    throw new Error("tool executor inbox dispatch not yet wired (Phase 4a.7)");
  }

  // ──────────────────────── internals ────────────────────────

  private async dispatchBody(input: DispatchInput): Promise<DispatchResult> {
    const reg = this.registry.get(input.name);
    if (!reg) {
      throw {
        _tag: "ToolNotFoundError",
        name: input.name,
        registered: this.registry.names(),
      } as const;
    }

    // Exposure check — the via field decides which door the tool is
    // allowed on.
    if (!reg.declaration.exposure.includes(input.context.via)) {
      throw {
        _tag: "ToolPermissionError",
        toolName: input.name,
        via: input.context.via,
        reason: `tool "${input.name}" is not exposed via "${input.context.via}"`,
      } as const;
    }

    // Resolve handler + validator.
    const entry = this.handlerResolver.resolve(reg.handlerRef);
    if (!entry) {
      throw {
        _tag: "ToolHandlerMissing",
        toolName: input.name,
        handlerRef: reg.handlerRef,
      } as const;
    }

    // Validate input.
    const result = await entry.validator.validate(input.input);
    if (isValidationFailure(result)) {
      throw {
        _tag: "ToolValidationError",
        toolName: input.name,
        issues: result.issues,
      } as const;
    }
    const validated = result.value;

    // Set up the per-dispatch abort plumbing. Composes:
    //   - harness-internal controller (signalled by `abort()` inbox / API)
    //   - caller-supplied `input.signal`
    //   - timeout (per-call → tool annotation → default)
    const controller = new AbortController();
    this.inFlight.set(input.toolCallId, { controller, toolName: input.name });

    const callerSignal = input.signal;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const timeoutMs =
      input.timeoutMs ?? reg.declaration.annotations?.timeout ?? this.defaultTimeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        controller.abort({
          _tag: "ToolTimeoutError",
          toolName: input.name,
          ms: timeoutMs,
        });
      }, timeoutMs);
    }

    // Build the handler context.
    const channelEmits: HandlerChannelSeed[] = [];
    const ctx: ToolHandlerCtx = {
      toolCallId: input.toolCallId,
      ...(input.context.sessionId !== undefined ? { sessionId: input.context.sessionId } : {}),
      ...(input.context.executionId !== undefined ? { executionId: input.context.executionId } : {}),
      ...(input.context.tickId !== undefined ? { tickId: input.context.tickId } : {}),
      signal: controller.signal,
      setState: (key: string, value: unknown): void => {
        this.stateStore.set(key, value);
      },
      emit: (seed: HandlerChannelSeed): void => {
        channelEmits.push(seed);
      },
    };

    const useDeps: Readonly<Record<string, unknown>> = {
      ...(reg.useDeps ?? {}),
      ...(input.context.use ?? {}),
    };

    const started = Date.now();
    try {
      // Fast-fail if already aborted (caller signal arrived before we
      // wired up our listener, or harness internal abort raced ahead).
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? {
          _tag: "ToolAbortedError",
          toolCallId: input.toolCallId,
        };
      }

      const handlerResult = entry.handler(validated, { ctx, use: useDeps });
      const content = await Promise.race([handlerResult, abortPromise(controller.signal)]);
      const durationMs = Date.now() - started;

      const dispatchResult: DispatchResult = {
        toolCallId: input.toolCallId,
        name: input.name,
        succeeded: true,
        content: content as readonly ContentBlock[],
        executedBy: "agentick",
        durationMs,
      };
      return dispatchResult;
    } catch (err) {
      // Distinguish abort-typed errors from handler errors. Abort
      // signals arrive via either:
      //   - controller.signal.reason (an aborted-tagged value), OR
      //   - the thrown `err` from abortPromise.
      const abortReason = controller.signal.aborted
        ? controller.signal.reason ?? err
        : undefined;
      if (abortReason !== undefined) {
        // Either a ToolAbortedError or a ToolTimeoutError, both tagged.
        throw isTaggedAbort(abortReason)
          ? abortReason
          : ({
              _tag: "ToolAbortedError",
              toolCallId: input.toolCallId,
              reason: typeof abortReason === "string" ? abortReason : undefined,
            } as const);
      }
      // Real handler error.
      throw {
        _tag: "ToolHandlerError",
        toolName: input.name,
        cause: err,
      } as const;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.inFlight.delete(input.toolCallId);
      // Channel seeds emitted by the handler are dropped here in
      // Phase 4a.4 — the session harness consumes them in 4a.6+
      // when wired through. Holding them in `channelEmits` for the
      // duration of the call gives observability harnesses a place to
      // hook in via subclassing.
      void channelEmits;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidationFailure(
  r: ValidatorResult,
): r is { value?: undefined; issues: ValidatorResult extends { issues: infer I } ? I : never } {
  return Array.isArray((r as { issues?: unknown }).issues);
}

/**
 * Resolves never; rejects with the signal's reason when the signal
 * aborts. Used in `Promise.race` to short-circuit a handler invocation
 * the moment an abort fires.
 */
function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
}

function isTaggedAbort(value: unknown): value is { readonly _tag: string } {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { _tag?: unknown })._tag;
  return tag === "ToolAbortedError" || tag === "ToolTimeoutError";
}

// Silence unused-import linting until 4a.6+ uses ToolRegistration alias.
void (undefined as unknown as ToolRegistration);

/**
 * BaseHarness — the inheritance point every concrete harness sits on.
 *
 * Composes journal + bus + inbox into the five-surface model:
 *
 *   ① Commands     — `runOperation` (heavy path with phase contract,
 *                    idempotency, journaling, observability)
 *   ② Inbox        — `handleMessage` (concrete subclass implements)
 *   ③ Lifecycle    — `.on*(fn)` via HandlerRegistry
 *   ④ Middleware   — `.use(mw)` via MiddlewareChain
 *   ⑤ Events       — `emit` (light path) + `emitDelta` (in-flight)
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §`BaseHarness` — the inheritance point
 * @see docs/proposals/v2/blueprint/01-harness-principle.md
 */

import type {
  CommandOutcome,
  EventBus,
  EventPhase,
  EventScope,
  EventSurface,
  HandlerVerdict,
  JournalingPolicy,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  ProtocolEvent,
  TerminalEvent,
} from "@agentick/spec";
import { DEFAULT_JOURNALING_POLICY } from "@agentick/spec";
import { ulid } from "./ulid.js";

export type Unsubscribe = () => void;

/**
 * Lifecycle handler. Runs at a phase boundary (typically `before`); may
 * return a {@link HandlerVerdict} to influence command execution.
 *
 * Returning `void` is equivalent to `{ kind: "proceed" }`.
 */
export type LifecycleHandler<I = unknown, R = unknown> = (
  input: I,
) =>
  | HandlerVerdict<R>
  | void
  | Promise<HandlerVerdict<R> | void>;

/**
 * Middleware. Wraps the command body — invoke `next()` to proceed or
 * return a value to short-circuit. Composes outer→inner: the first
 * middleware registered is the outermost.
 */
export type Middleware<I = unknown, R = unknown> = (
  input: I,
  next: (input: I) => Promise<R>,
) => Promise<R>;

// ============================================================================
// HandlerRegistry — keyed handler lists
// ============================================================================

export class HandlerRegistry {
  private handlers = new Map<string, LifecycleHandler<unknown, unknown>[]>();

  register<I, R>(key: string, handler: LifecycleHandler<I, R>): Unsubscribe {
    const list = this.handlers.get(key) ?? [];
    list.push(handler as LifecycleHandler<unknown, unknown>);
    this.handlers.set(key, list);
    return () => {
      const current = this.handlers.get(key);
      if (!current) return;
      const idx = current.indexOf(handler as LifecycleHandler<unknown, unknown>);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /**
   * Run all handlers for `key` in registration order. Returns the merged
   * verdict per: veto > replace > defer > proceed.
   */
  async run<I, R>(key: string, input: I): Promise<HandlerVerdict<R>> {
    const list = this.handlers.get(key) ?? [];
    let merged: HandlerVerdict<R> = { kind: "proceed" };
    for (const h of list) {
      const raw = await h(input);
      const v = (raw ?? { kind: "proceed" }) as HandlerVerdict<R>;
      merged = mergeVerdict(merged, v);
      // Veto short-circuits — additional handlers cannot un-veto.
      if (merged.kind === "veto") return merged;
    }
    return merged;
  }
}

/**
 * Verdict merge rule: veto > replace > defer > proceed.
 * First-veto wins; first-replace wins; deferreds use earliest retry.
 */
export function mergeVerdict<R>(a: HandlerVerdict<R>, b: HandlerVerdict<R>): HandlerVerdict<R> {
  if (a.kind === "veto") return a;
  if (b.kind === "veto") return b;
  if (a.kind === "replace") return a;
  if (b.kind === "replace") return b;
  if (a.kind === "defer" && b.kind === "defer") {
    const ra = a.retryAfter;
    const rb = b.retryAfter;
    if (ra === undefined) return b;
    if (rb === undefined) return a;
    return { kind: "defer", retryAfter: Math.min(ra, rb) };
  }
  if (a.kind === "defer") return a;
  if (b.kind === "defer") return b;
  return { kind: "proceed" };
}

// ============================================================================
// MiddlewareChain — outer→inner composition
// ============================================================================

export class MiddlewareChain {
  private middlewares: Middleware<unknown, unknown>[] = [];

  use<I, R>(mw: Middleware<I, R>): Unsubscribe {
    this.middlewares.push(mw as Middleware<unknown, unknown>);
    return () => {
      const idx = this.middlewares.indexOf(mw as Middleware<unknown, unknown>);
      if (idx >= 0) this.middlewares.splice(idx, 1);
    };
  }

  /**
   * Compose middlewares around a body. The first registered is outermost.
   */
  compose<I, R>(body: (input: I) => Promise<R>): (input: I) => Promise<R> {
    const list = this.middlewares.slice() as Middleware<I, R>[];
    return list.reduceRight<(input: I) => Promise<R>>(
      (next, mw) => (input) => mw(input, next),
      body,
    );
  }
}

// ============================================================================
// BaseHarness
// ============================================================================

export interface BaseHarnessOptions {
  readonly policy?: JournalingPolicy;
  /**
   * Auto-register on the inbox at construction. Set false for harnesses
   * that handle their own registration timing. Default: true.
   */
  readonly autoRegisterInbox?: boolean;
}

export abstract class BaseHarness<Surface extends EventSurface = EventSurface> {
  protected readonly address: string;
  protected readonly handlers = new HandlerRegistry();
  protected readonly middleware = new MiddlewareChain();
  private readonly policy: JournalingPolicy;
  private inboxUnsubscribe?: Unsubscribe;

  /**
   * Resolves once the harness has finished its async construction
   * tasks (inbox registration). Callers that need to send inbox
   * messages to this harness immediately after construction MUST
   * `await harness.ready` first — otherwise `inbox.send(address, ...)`
   * may race against registration and reject with `AddressNotFound`.
   *
   * Resolves immediately when `autoRegisterInbox: false`.
   */
  readonly ready: Promise<void>;

  constructor(
    protected readonly surface: Surface,
    protected readonly scopeId: string,
    protected readonly journal: OperationJournal,
    protected readonly bus: EventBus,
    protected readonly inbox: MessageInbox,
    options: BaseHarnessOptions = {},
  ) {
    this.address = `${surface}:${scopeId}`;
    this.policy = options.policy ?? DEFAULT_JOURNALING_POLICY;
    if (options.autoRegisterInbox !== false) {
      // Register is async only because cluster impls may need to
      // negotiate; local impls resolve synchronously. Either way,
      // `ready` is the deterministic readiness handle.
      this.ready = this.inbox
        .register(this.address, (msg) => this.dispatchMessage(msg))
        .then((unsub) => {
          this.inboxUnsubscribe = unsub;
        });
    } else {
      this.ready = Promise.resolve();
    }
  }

  // ──────── ① Commands (heavy path) ────────

  /**
   * Run an operation through the full phase contract:
   *
   *   idempotency check → requested → before (handlers + middleware) →
   *   body → terminal
   *
   * Returns the operation's result on success. Throws on failure /
   * vetoed / canceled / deferred (the caller can distinguish via
   * `instanceof OperationOutcomeError`).
   */
  protected async runOperation<I, R, E = unknown>(
    op: Operation<I, R, E>,
    body: (input: I) => Promise<R>,
  ): Promise<R> {
    // 1. Idempotency: replay terminal if op already completed.
    const cached = await this.journal.lookupTerminal(op.opId);
    if (cached.some) return this.replayTerminal<R>(cached.value);

    const scope: EventScope = op.scope ?? {};

    // 2. Append `requested`.
    await this.publish(this.makeEvent(op, "requested", scope));

    // 3. Append `before` and run handlers.
    await this.publish(this.makeEvent(op, "before", scope));
    const verdict = await this.handlers.run<I, R>("before", op.input);
    switch (verdict.kind) {
      case "veto":
        return this.terminate<R>(op, scope, "vetoed", { reason: verdict.reason });
      case "replace":
        return this.terminate<R>(op, scope, "replaced", {
          result: verdict.result,
          reason: verdict.reason,
        });
      case "defer":
        return this.terminate<R>(op, scope, "deferred", { retryAfter: verdict.retryAfter });
      case "proceed":
        break;
    }

    // 4. Compose middleware around body, then execute.
    const composed = this.middleware.compose<I, R>(body);
    try {
      const result = await composed(op.input);
      return this.terminate<R>(op, scope, "succeeded", { result });
    } catch (err) {
      const wrapped = err instanceof OperationOutcomeError ? err : undefined;
      if (wrapped) throw err;
      await this.terminate<R>(op, scope, "failed", { error: this.normalizeError(err) });
      throw err;
    }
  }

  // ──────── ⑤ Events (light path) ────────

  /** Emit a discrete event. No phase contract, no idempotency. */
  protected async emit(
    args: Omit<ProtocolEvent, "id" | "timestamp" | "surface"> & { readonly id?: string },
  ): Promise<void> {
    const envelope: ProtocolEvent = {
      ...args,
      id: args.id ?? ulid(),
      timestamp: Date.now(),
      surface: this.surface,
    };
    await this.publish(envelope);
  }

  /** Streaming progress within an active operation. */
  protected async emitDelta(
    op: Operation<unknown, unknown, unknown>,
    payload: unknown,
  ): Promise<void> {
    await this.publish(this.makeEvent(op, "delta", op.scope ?? {}, { payload }));
  }

  // ──────── ② Inbox dispatch ────────

  /**
   * Concrete harnesses override this with a typed switch on message.type.
   * Default: reject with `HandlerError`.
   */
  protected abstract handleMessage(msg: MessageEnvelope): Promise<unknown>;

  private async dispatchMessage(msg: MessageEnvelope): Promise<unknown> {
    try {
      return await this.handleMessage(msg);
    } catch (err) {
      const wrapped: MessageHandlerError = {
        _tag: "HandlerError",
        cause: err,
      };
      throw wrapped;
    }
  }

  // ──────── lifecycle ────────

  /** Detach this harness from the inbox. */
  async close(): Promise<void> {
    if (this.inboxUnsubscribe) {
      this.inboxUnsubscribe();
      this.inboxUnsubscribe = undefined;
    }
  }

  // ──────── helpers ────────

  private makeEvent(
    op: Operation<unknown, unknown, unknown>,
    phase: EventPhase,
    scope: EventScope,
    extra?: { payload?: unknown; outcome?: CommandOutcome; error?: ProtocolEvent["error"] },
  ): ProtocolEvent {
    return {
      id: ulid(),
      opId: op.opId,
      surface: op.surface ?? this.surface,
      name: op.name,
      phase,
      timestamp: Date.now(),
      scope,
      payload: extra?.payload,
      outcome: extra?.outcome,
      error: extra?.error,
    } as ProtocolEvent;
  }

  private async terminate<R>(
    op: Operation<unknown, R, unknown>,
    scope: EventScope,
    outcome: CommandOutcome,
    payload: Record<string, unknown>,
  ): Promise<R> {
    const error =
      outcome === "failed" ? (payload.error as ProtocolEvent["error"]) : undefined;
    const envelope = this.makeEvent(op, "terminal", scope, { payload, outcome, error });
    await this.publish(envelope);
    return this.replayTerminal<R>(this.payloadToTerminal(outcome, payload));
  }

  private payloadToTerminal(
    outcome: CommandOutcome,
    payload: Record<string, unknown>,
  ): TerminalEvent {
    switch (outcome) {
      case "succeeded":
        return { outcome, result: payload.result };
      case "failed":
        return { outcome, error: payload.error };
      case "canceled":
        return { outcome, reason: payload.reason as string | undefined };
      case "vetoed":
        return { outcome, reason: payload.reason as string | undefined };
      case "replaced":
        return {
          outcome,
          result: payload.result,
          reason: payload.reason as string | undefined,
        };
      case "deferred":
        return {
          outcome,
          retryAfter: payload.retryAfter as number | undefined,
        };
    }
  }

  private replayTerminal<R>(terminal: TerminalEvent): R {
    switch (terminal.outcome) {
      case "succeeded":
        return terminal.result as R;
      case "replaced":
        return terminal.result as R;
      case "failed":
        throw new OperationOutcomeError("failed", terminal);
      case "canceled":
        throw new OperationOutcomeError("canceled", terminal);
      case "vetoed":
        throw new OperationOutcomeError("vetoed", terminal);
      case "deferred":
        throw new OperationOutcomeError("deferred", terminal);
    }
  }

  private normalizeError(err: unknown): ProtocolEvent["error"] {
    if (err && typeof err === "object" && "message" in err) {
      const e = err as { name?: string; message?: string };
      return {
        name: e.name ?? "Error",
        message: typeof e.message === "string" ? e.message : String(err),
        data: err,
      };
    }
    return { name: "Error", message: String(err), data: err };
  }

  /**
   * Publish to bus + (conditionally) journal per policy.
   *
   * Decision order:
   *   1. `policy.override[exactName]`  drop | bus-only | always
   *   2. `policy.override[prefix]`     longest-prefix match
   *   3. `policy.alwaysJournal` / `policy.busOnly` phase rules
   *   4. Default-deny on unknown phases
   */
  private async publish(envelope: ProtocolEvent): Promise<void> {
    const decision = this.decide(envelope);
    if (decision !== "drop") await this.bus.publish(envelope);
    if (decision === "always" || decision === "journal") {
      await this.journal.append(envelope);
    }
  }

  private decide(envelope: ProtocolEvent): "always" | "journal" | "bus-only" | "drop" {
    const override = this.policy.override
      ? matchOverride(envelope.name, this.policy.override)
      : undefined;
    if (override === "drop") return "drop";
    if (override === "always") return "always";
    if (override === "bus-only") return "bus-only";
    if (this.policy.alwaysJournal.includes(envelope.phase)) return "journal";
    if (this.policy.busOnly.includes(envelope.phase)) return "bus-only";
    return "bus-only";
  }
}

function matchOverride(
  name: string,
  table: Readonly<Record<string, "always" | "bus-only" | "drop">>,
): "always" | "bus-only" | "drop" | undefined {
  if (name in table) return table[name];
  let best: { key: string; value: "always" | "bus-only" | "drop" } | undefined;
  for (const [key, value] of Object.entries(table)) {
    if (name.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, value };
    }
  }
  return best?.value;
}

/**
 * Thrown by `BaseHarness.runOperation` when an operation terminates with
 * a non-success outcome (failed, canceled, vetoed, deferred). The
 * `terminal` field exposes the typed envelope.
 */
export class OperationOutcomeError extends Error {
  readonly outcome: CommandOutcome;
  readonly terminal: TerminalEvent;
  constructor(outcome: CommandOutcome, terminal: TerminalEvent) {
    super(`operation outcome: ${outcome}`);
    this.name = "OperationOutcomeError";
    this.outcome = outcome;
    this.terminal = terminal;
  }
}

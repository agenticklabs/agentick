/**
 * `RequestResponseRegistry<TResp>` — bookkeeping primitive that pairs
 * outbound channel publishes with inbound responses arriving at the
 * harness's inbox.
 *
 * Pure mechanism, no transport. Owners (typically `BaseHarness`) hold
 * one registry, call `register(...)` when sending a request, and
 * `resolve(correlationId, response)` when an `request-response` inbox
 * message arrives. The Deferred returned by `register` is awaited by
 * the requesting fiber.
 *
 * Two users prove the abstraction: tool confirmation (refactored onto
 * it) and `session.request(...)` for app-level RPC.
 *
 * @see docs/proposals/v2/IMPLEMENTATION-PLAN.md (block 5 — request/response primitive)
 */

import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";

/**
 * Error union surfaced by `RequestResponseRegistry.register(...).promise`.
 * Owners may translate to a different error type at the harness boundary.
 */
export type RequestError =
  | { readonly _tag: "RequestTimeoutError"; readonly ms: number; readonly correlationId: string }
  | {
      readonly _tag: "RequestAbortedError";
      readonly correlationId: string;
      readonly reason?: unknown;
    }
  | {
      readonly _tag: "RequestCancelledError";
      readonly correlationId: string;
      readonly reason?: unknown;
    };

export interface RegisterOptions {
  readonly correlationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RegisteredRequest<TResp> {
  readonly correlationId: string;
  /**
   * Resolves with the response payload or fails with `RequestError`.
   * The fiber awaiting this is interrupt-safe — fiber interruption
   * (from the surrounding `runOperation` scope) automatically removes
   * the registry entry.
   */
  readonly promise: Promise<TResp>;
}

/**
 * Pure bookkeeping. No bus, no inbox. Owners wire transport around it.
 */
export class RequestResponseRegistry<TResp = unknown> {
  private readonly pending = new Map<string, Deferred.Deferred<TResp, RequestError>>();

  /**
   * Register a pending request. Returns a Promise that resolves when
   * `resolve(correlationId, response)` is called with a matching id,
   * or rejects on timeout / signal abort / explicit `cancel`.
   *
   * Internally races the registry's deferred against an `Effect.delay`
   * timeout and an `Effect.async` signal-watcher via `Effect.raceFirst`
   * (not `race`/`raceAll` — those require a success to settle; the
   * timeout/abort paths fail-fast and need `raceFirst`). The race
   * interrupts the losers; their finalizers (`Effect.delay`'s timer
   * cancellation, `Effect.async`'s cleanup callback) run automatically
   * — no manual `clearTimeout` / `removeEventListener` bookkeeping.
   * The registry map entry is removed atomically via `Effect.ensuring`.
   */
  register(opts: RegisterOptions): RegisteredRequest<TResp> {
    const { correlationId, timeoutMs, signal } = opts;
    const deferred = Effect.runSync(Deferred.make<TResp, RequestError>());
    this.pending.set(correlationId, deferred);

    // Chain races via Effect.raceFirst — settles on first to either
    // succeed OR fail. `Effect.raceAll` settles only on first SUCCESS
    // (waits for the rest to succeed if the first fails) — wrong for
    // timeout/abort which fail-fast.
    let program: Effect.Effect<TResp, RequestError, never> = Deferred.await(deferred);

    if (timeoutMs !== undefined && timeoutMs > 0) {
      const ms = timeoutMs;
      const timeoutEffect: Effect.Effect<TResp, RequestError, never> = Effect.fail<RequestError>({
        _tag: "RequestTimeoutError",
        ms,
        correlationId,
      }).pipe(Effect.delay(`${ms} millis`)) as Effect.Effect<TResp, RequestError, never>;
      program = Effect.raceFirst(program, timeoutEffect);
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        // Pre-aborted — short-circuit before scheduling anything.
        program = Effect.fail<RequestError>({
          _tag: "RequestAbortedError",
          correlationId,
          reason: signal.reason ?? "aborted",
        });
      } else {
        const signalEffect = Effect.async<TResp, RequestError, never>((resume) => {
          const onAbort = (): void =>
            resume(
              Effect.fail<RequestError>({
                _tag: "RequestAbortedError",
                correlationId,
                reason: signal.reason ?? "aborted",
              }),
            );
          signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", onAbort));
        });
        program = Effect.raceFirst(program, signalEffect);
      }
    }

    program = program.pipe(Effect.ensuring(Effect.sync(() => this.pending.delete(correlationId))));

    const promise = Effect.runPromiseExit(program).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) throw failure.value;
      throw new Error(Cause.pretty(exit.cause));
    });

    return { correlationId, promise };
  }

  /**
   * Resolve a pending request with the response payload. Returns
   * `true` if a matching entry was found and resolved; `false`
   * otherwise (unknown correlationId — typically a stale response
   * after timeout or cancellation).
   */
  resolve(correlationId: string, response: TResp): boolean {
    const deferred = this.pending.get(correlationId);
    if (!deferred) return false;
    // `Effect.runSync` — Deferred.succeed is a sync operation; running
    // it on a daemon fiber via `runFork` opens a microtask gap during
    // which a racing timeout/abort can win incorrectly. Settle the
    // deferred in the calling stack frame so the awaiting fiber sees
    // the result before any rescheduling.
    Effect.runSync(Deferred.succeed(deferred, response));
    return true;
  }

  /**
   * Cancel a pending request. The promise rejects with
   * `RequestCancelledError`. Used by abort flows that want to
   * propagate a specific reason.
   */
  cancel(correlationId: string, reason?: string): boolean {
    const deferred = this.pending.get(correlationId);
    if (!deferred) return false;
    Effect.runSync(
      Deferred.fail(deferred, {
        _tag: "RequestCancelledError",
        correlationId,
        ...(reason !== undefined ? { reason } : {}),
      }),
    );
    return true;
  }

  /** Cancel every pending request. Used on harness close. */
  cancelAll(reason?: string): void {
    for (const correlationId of Array.from(this.pending.keys())) {
      this.cancel(correlationId, reason);
    }
  }

  /** Diagnostic only. */
  size(): number {
    return this.pending.size;
  }

  /** Diagnostic only. */
  has(correlationId: string): boolean {
    return this.pending.has(correlationId);
  }
}

// Re-export Fiber here so callers don't need a separate Effect import.
void Fiber;

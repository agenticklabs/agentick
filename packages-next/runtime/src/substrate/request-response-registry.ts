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
  private readonly pending = new Map<
    string,
    {
      readonly deferred: Deferred.Deferred<TResp, RequestError>;
      readonly cleanup: () => void;
    }
  >();

  /**
   * Register a pending request. Returns a Promise that resolves when
   * `resolve(correlationId, response)` is called with a matching id,
   * or rejects on timeout / signal abort / explicit `cancel`.
   */
  register(opts: RegisterOptions): RegisteredRequest<TResp> {
    const { correlationId, timeoutMs, signal } = opts;

    // Run synchronously to materialize the Deferred + Promise pair.
    // Deferred.make is itself an Effect; we run it once here.
    const deferred = Effect.runSync(Deferred.make<TResp, RequestError>());

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const cleanups: Array<() => void> = [];
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        Effect.runFork(
          Deferred.fail(deferred, {
            _tag: "RequestTimeoutError",
            ms: timeoutMs,
            correlationId,
          }),
        );
        this.pending.delete(correlationId);
      }, timeoutMs);
      cleanups.push(() => clearTimeout(timeoutHandle));
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        Effect.runFork(
          Deferred.fail(deferred, {
            _tag: "RequestAbortedError",
            correlationId,
            reason: signal.reason ?? "aborted",
          }),
        );
      } else {
        const onAbort = () => {
          Effect.runFork(
            Deferred.fail(deferred, {
              _tag: "RequestAbortedError",
              correlationId,
              reason: signal.reason ?? "aborted",
            }),
          );
          this.pending.delete(correlationId);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", onAbort));
      }
    }

    const cleanup = () => {
      for (const c of cleanups) c();
    };
    this.pending.set(correlationId, { deferred, cleanup });

    // Materialize a Promise that drains the Deferred. Use
    // `runPromiseExit` so we can extract the raw tagged-union failure
    // instead of a FiberFailure-wrapped Error.
    const promise = (async () => {
      const exit = await Effect.runPromiseExit(
        Deferred.await(deferred).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              cleanup();
              this.pending.delete(correlationId);
            }),
          ),
        ),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) throw failure.value;
      throw new Error(Cause.pretty(exit.cause));
    })();

    return { correlationId, promise };
  }

  /**
   * Resolve a pending request with the response payload. Returns
   * `true` if a matching entry was found and resolved; `false`
   * otherwise (unknown correlationId — typically a stale response
   * after timeout or cancellation).
   */
  resolve(correlationId: string, response: TResp): boolean {
    const entry = this.pending.get(correlationId);
    if (!entry) return false;
    Effect.runFork(Deferred.succeed(entry.deferred, response));
    return true;
  }

  /**
   * Cancel a pending request. The promise rejects with
   * `RequestCancelledError`. Used by abort flows that want to
   * propagate a specific reason.
   */
  cancel(correlationId: string, reason?: string): boolean {
    const entry = this.pending.get(correlationId);
    if (!entry) return false;
    Effect.runFork(
      Deferred.fail(entry.deferred, {
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

/**
 * Per-mount lifecycle dispatch — the compiler's HALF of the lifecycle
 * projection (ADR 89 §4).
 *
 * Tracks handlers registered by user-supplied `useOnTickStart` /
 * `useOnTickEnd` / `useOnExecutionStart` / `useOnExecutionEnd` /
 * `useOnToolStart` / `useOnToolEnd` / `useOnModelGenerateStart` /
 * `useOnModelGenerateEnd` / `useOnError` hooks and fans a dispatched
 * event out to them. The EVENTS come from the real command-hook system:
 * the SESSION (the composition root) registers forwarders on the
 * constituent command hooks (`loop:run-execution`, `loop:tick`,
 * `tool:dispatch`, `model:generate[_stream]`) and routes each projected
 * event here via the harness's `dispatchLifecycle` (the
 * `LifecycleProjectionTarget` capability). The compiler owns NO feed of
 * its own — this class is the thin per-mount dispatch plus the catch-up
 * cache below, nothing more.
 *
 * **Tick-start catch-up.** Components that mount *during* a tick
 * register their `useOnTickStart` handler AFTER the tick-start event
 * has already been dispatched for that tick. Without intervention they
 * would never see tick-start until the *next* tick.
 *
 * The dispatch remembers the current tick-start event (cleared at
 * tick-end). Newly-registered tick-start handlers receive the cached
 * event immediately on registration, so a mid-tick mount catches up.
 *
 * The same pattern applies to `execution-start` for components that
 * mount mid-execution.
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

import type {
  LifecycleError,
  LifecycleEvent,
  LifecycleExecutionEnd,
  LifecycleExecutionStart,
  LifecycleModelGenerateEnd,
  LifecycleModelGenerateStart,
  LifecycleTickEnd,
  LifecycleTickStart,
  LifecycleToolEnd,
  LifecycleToolStart,
} from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";

/**
 * Kinds the dispatch routes and that user hooks register against.
 * `tick-start` and `execution-start` are catch-up eligible.
 */
export type LifecycleHandlerKind =
  | "tick-start"
  | "tick-end"
  | "execution-start"
  | "execution-end"
  | "tool-start"
  | "tool-end"
  | "model-generate-start"
  | "model-generate-end"
  | "error";

/** Map a handler kind to the narrowed event type it receives. */
type EventForKind<K extends LifecycleHandlerKind> = K extends "tick-start"
  ? LifecycleTickStart
  : K extends "tick-end"
    ? LifecycleTickEnd
    : K extends "execution-start"
      ? LifecycleExecutionStart
      : K extends "execution-end"
        ? LifecycleExecutionEnd
        : K extends "tool-start"
          ? LifecycleToolStart
          : K extends "tool-end"
            ? LifecycleToolEnd
            : K extends "model-generate-start"
              ? LifecycleModelGenerateStart
              : K extends "model-generate-end"
                ? LifecycleModelGenerateEnd
                : K extends "error"
                  ? LifecycleError
                  : never;

type Handler<E extends LifecycleEvent> = (event: E) => void | Promise<void>;

type AnyHandler = Handler<LifecycleEvent>;

export class LifecycleDispatch {
  private readonly handlers: Record<LifecycleHandlerKind, Set<AnyHandler>> = {
    "tick-start": new Set(),
    "tick-end": new Set(),
    "execution-start": new Set(),
    "execution-end": new Set(),
    "tool-start": new Set(),
    "tool-end": new Set(),
    "model-generate-start": new Set(),
    "model-generate-end": new Set(),
    error: new Set(),
  };

  /**
   * Custom lifecycle kinds — `LifecycleCustom` events whose `kind` is a
   * namespaced application-defined string. Keyed by exact kind match.
   *
   * Wired via `registerCustom(kind, handler)` (and the public
   * `useOnLifecycleCustom` hook).
   *
   * Backed by the shared `KeyedNotifier` primitive — async dispatch
   * with serial ordering propagates handler errors so the compiler
   * can react. `count(kind)` powers the unhandled-warning logic.
   */
  private readonly customHandlers: KeyedNotifier<string, LifecycleEvent> = createKeyedNotifier<
    string,
    LifecycleEvent
  >();

  /**
   * Track which custom kinds have already produced an "unhandled" warning
   * so a chatty dispatcher doesn't flood stderr.
   */
  private readonly warnedUnhandledKinds = new Set<string>();

  /**
   * Currently-active tick-start event (set on dispatch, cleared on
   * tick-end). Used to catch up handlers registered mid-tick.
   */
  private activeTickStart: LifecycleTickStart | null = null;
  /** Handlers that have already received the active tick-start. */
  private firedForTickStart = new Set<AnyHandler>();

  private activeExecutionStart: LifecycleExecutionStart | null = null;
  private firedForExecutionStart = new Set<AnyHandler>();

  /**
   * Register a handler. Returns an unsubscribe. If a tick-start (or
   * execution-start) is currently active AND this handler has not yet
   * received it, fire it now (catch-up).
   */
  register<K extends LifecycleHandlerKind>(kind: K, handler: Handler<EventForKind<K>>): () => void {
    const wrapped = handler as AnyHandler;
    this.handlers[kind].add(wrapped);

    if (kind === "tick-start" && this.activeTickStart && !this.firedForTickStart.has(wrapped)) {
      this.firedForTickStart.add(wrapped);
      void this.invokeSafely(wrapped, this.activeTickStart);
    } else if (
      kind === "execution-start" &&
      this.activeExecutionStart &&
      !this.firedForExecutionStart.has(wrapped)
    ) {
      this.firedForExecutionStart.add(wrapped);
      void this.invokeSafely(wrapped, this.activeExecutionStart);
    }

    return () => {
      this.handlers[kind].delete(wrapped);
      this.firedForTickStart.delete(wrapped);
      this.firedForExecutionStart.delete(wrapped);
    };
  }

  /**
   * Register a handler for an application-defined `LifecycleCustom`
   * kind (namespaced string, e.g. `"app:my-app:phase-x"`). Returns an
   * unsubscribe. Catch-up is NOT applied to custom kinds — application
   * code owns the replay semantics if it needs them.
   */
  registerCustom(
    kind: string,
    handler: (event: LifecycleEvent) => void | Promise<void>,
  ): () => void {
    return this.customHandlers.subscribe(kind, handler);
  }

  /**
   * Invoke ONE handler in isolation. A user-supplied lifecycle observer
   * that throws (or rejects) must never fail the run or float an
   * unhandled rejection: the tick-start / tick-end forwarders AWAIT
   * dispatch in the `loop:tick` command cascade (a propagated throw
   * would abort the tick), and the rest are fire-and-forget (a
   * propagated throw would float). Catch, log with the kind for triage,
   * and continue — one bad observer never takes down the loop or its
   * siblings. Mirrors React's "an effect that throws is surfaced, not
   * fatal" posture.
   */
  private async invokeSafely(handler: AnyHandler, event: LifecycleEvent): Promise<void> {
    try {
      await handler(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[@agentick/compiler] a lifecycle handler for "${event.kind}" threw; ` +
          `isolated so the run continues.`,
        err,
      );
    }
  }

  /**
   * Dispatch a lifecycle event. Invokes every registered handler for
   * `event.kind` and updates catch-up bookkeeping.
   *
   * Awaits handlers serially — Phase 3.10+ may add parallel dispatch
   * with a configurable join policy. For now serial gives deterministic
   * ordering for tests + matches v1's lifecycle semantics.
   */
  async dispatch(event: LifecycleEvent): Promise<void> {
    switch (event.kind) {
      case "tick-start": {
        const ev = event as LifecycleTickStart;
        this.activeTickStart = ev;
        this.firedForTickStart = new Set();
        for (const h of [...this.handlers["tick-start"]]) {
          this.firedForTickStart.add(h);
          await this.invokeSafely(h, ev);
        }
        return;
      }
      case "tick-end": {
        this.activeTickStart = null;
        for (const h of [...this.handlers["tick-end"]]) await this.invokeSafely(h, event);
        return;
      }
      case "execution-start": {
        const ev = event as LifecycleExecutionStart;
        this.activeExecutionStart = ev;
        this.firedForExecutionStart = new Set();
        for (const h of [...this.handlers["execution-start"]]) {
          this.firedForExecutionStart.add(h);
          await this.invokeSafely(h, ev);
        }
        return;
      }
      case "execution-end": {
        this.activeExecutionStart = null;
        for (const h of [...this.handlers["execution-end"]]) await this.invokeSafely(h, event);
        return;
      }
      case "tool-start": {
        for (const h of [...this.handlers["tool-start"]]) await this.invokeSafely(h, event);
        return;
      }
      case "tool-end": {
        for (const h of [...this.handlers["tool-end"]]) await this.invokeSafely(h, event);
        return;
      }
      case "model-generate-start": {
        for (const h of [...this.handlers["model-generate-start"]]) {
          await this.invokeSafely(h, event);
        }
        return;
      }
      case "model-generate-end": {
        for (const h of [...this.handlers["model-generate-end"]]) {
          await this.invokeSafely(h, event);
        }
        return;
      }
      case "error": {
        for (const h of [...this.handlers.error]) await this.invokeSafely(h, event);
        return;
      }
      default: {
        // `LifecycleCustom` — application-defined kinds. The spec
        // requires the kind to be namespaced (`"app:…"`). Dispatch to
        // any handlers registered via `registerCustom(kind, …)`. If
        // nothing is listening, log a one-shot warning so typos surface
        // instead of silently dropping events.
        const kind = event.kind;
        if (this.customHandlers.count(kind) > 0) {
          await this.customHandlers.notifyAsync(kind, event);
          return;
        }
        if (!this.warnedUnhandledKinds.has(kind)) {
          this.warnedUnhandledKinds.add(kind);
          // eslint-disable-next-line no-console
          console.warn(
            `[@agentick/compiler] LifecycleEvent kind "${kind}" dispatched ` +
              `with no registered handlers. Register one via ` +
              `useOnLifecycleCustom("${kind}", handler).`,
          );
        }
        return;
      }
    }
  }

  /** Diagnostic: counts of registered handlers. */
  counts(): Record<LifecycleHandlerKind, number> {
    return {
      "tick-start": this.handlers["tick-start"].size,
      "tick-end": this.handlers["tick-end"].size,
      "execution-start": this.handlers["execution-start"].size,
      "execution-end": this.handlers["execution-end"].size,
      "tool-start": this.handlers["tool-start"].size,
      "tool-end": this.handlers["tool-end"].size,
      "model-generate-start": this.handlers["model-generate-start"].size,
      "model-generate-end": this.handlers["model-generate-end"].size,
      error: this.handlers.error.size,
    };
  }

  /** Reset all state. Used on unmount. */
  clear(): void {
    for (const set of Object.values(this.handlers)) set.clear();
    this.customHandlers.clear();
    this.warnedUnhandledKinds.clear();
    this.activeTickStart = null;
    this.activeExecutionStart = null;
    this.firedForTickStart.clear();
    this.firedForExecutionStart.clear();
  }
}

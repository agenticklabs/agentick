/**
 * Per-mount lifecycle handler registry.
 *
 * Tracks handlers registered by user-supplied `useOnTickStart` /
 * `useOnTickEnd` / `useOnExecutionStart` / `useOnExecutionEnd` /
 * `useOnError` hooks. The harness's `notifyLifecycle` command
 * dispatches the matching event to every registered handler.
 *
 * **Tick-start catch-up.** Components that mount *during* a tick
 * register their `useOnTickStart` handler AFTER `notifyLifecycle({kind:
 * "tick-start"})` has already fired for that tick. Without
 * intervention they would never see tick-start until the *next* tick.
 *
 * The store remembers the current tick-start event (cleared at
 * tick-end). Newly-registered tick-start handlers receive the cached
 * event immediately on registration, so a mid-tick mount catches up.
 *
 * The same pattern applies to `execution-start` for components that
 * mount mid-execution.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

import type {
  LifecycleError,
  LifecycleEvent,
  LifecycleExecutionEnd,
  LifecycleExecutionStart,
  LifecycleTickEnd,
  LifecycleTickStart,
} from "@agentick/spec";

/**
 * Kinds the store dispatches and that user hooks register against.
 * `tick-start` and `execution-start` are catch-up eligible.
 */
export type LifecycleHandlerKind =
  | "tick-start"
  | "tick-end"
  | "execution-start"
  | "execution-end"
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
        : K extends "error"
          ? LifecycleError
          : never;

type Handler<E extends LifecycleEvent> = (event: E) => void | Promise<void>;

type AnyHandler = Handler<LifecycleEvent>;

export class LifecycleStore {
  private readonly handlers: Record<LifecycleHandlerKind, Set<AnyHandler>> = {
    "tick-start": new Set(),
    "tick-end": new Set(),
    "execution-start": new Set(),
    "execution-end": new Set(),
    error: new Set(),
  };

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
  register<K extends LifecycleHandlerKind>(
    kind: K,
    handler: Handler<EventForKind<K>>,
  ): () => void {
    const wrapped = handler as AnyHandler;
    this.handlers[kind].add(wrapped);

    if (kind === "tick-start" && this.activeTickStart && !this.firedForTickStart.has(wrapped)) {
      this.firedForTickStart.add(wrapped);
      void wrapped(this.activeTickStart);
    } else if (
      kind === "execution-start" &&
      this.activeExecutionStart &&
      !this.firedForExecutionStart.has(wrapped)
    ) {
      this.firedForExecutionStart.add(wrapped);
      void wrapped(this.activeExecutionStart);
    }

    return () => {
      this.handlers[kind].delete(wrapped);
      this.firedForTickStart.delete(wrapped);
      this.firedForExecutionStart.delete(wrapped);
    };
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
          await h(ev);
        }
        return;
      }
      case "tick-end": {
        this.activeTickStart = null;
        for (const h of [...this.handlers["tick-end"]]) await h(event);
        return;
      }
      case "execution-start": {
        const ev = event as LifecycleExecutionStart;
        this.activeExecutionStart = ev;
        this.firedForExecutionStart = new Set();
        for (const h of [...this.handlers["execution-start"]]) {
          this.firedForExecutionStart.add(h);
          await h(ev);
        }
        return;
      }
      case "execution-end": {
        this.activeExecutionStart = null;
        for (const h of [...this.handlers["execution-end"]]) await h(event);
        return;
      }
      case "error": {
        for (const h of [...this.handlers.error]) await h(event);
        return;
      }
      default:
        // Custom event kinds — silently ignored. Custom dispatch is a
        // future feature (the spec already documents `LifecycleCustom`
        // for application-defined kinds).
        return;
    }
  }

  /** Diagnostic: counts of registered handlers. */
  counts(): Record<LifecycleHandlerKind, number> {
    return {
      "tick-start": this.handlers["tick-start"].size,
      "tick-end": this.handlers["tick-end"].size,
      "execution-start": this.handlers["execution-start"].size,
      "execution-end": this.handlers["execution-end"].size,
      error: this.handlers.error.size,
    };
  }

  /** Reset all state. Used on unmount. */
  clear(): void {
    for (const set of Object.values(this.handlers)) set.clear();
    this.activeTickStart = null;
    this.activeExecutionStart = null;
    this.firedForTickStart.clear();
    this.firedForExecutionStart.clear();
  }
}

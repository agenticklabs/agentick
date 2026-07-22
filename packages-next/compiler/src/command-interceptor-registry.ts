/**
 * Per-mount command-interceptor registry — the compiler's HALF of the
 * TREE-SIDE interception projection (ADR 89 §4).
 *
 * The observe-only lifecycle projection ({@link LifecycleDispatch}) is a
 * PUSH: the session forwards command-hook events INTO the mount. This is
 * its in-path twin — a PULL. Components register REAL interceptors
 * (`guard` / `transform`, ADR 83) via the `useGuardToolDispatch` /
 * `useTransform*` / `useCommandInterceptor` hooks; each hook builds a
 * tagged Effect {@link Middleware} (closing over the component's latest
 * render state via a ref) and lands it here, keyed by the op tag the
 * command carries at dispatch (`ctx.op`, e.g. `"ToolDispatch"`).
 *
 * The SESSION owns the other end: a per-send tier-4 forwarder queries
 * {@link collect} at every operation (`command = ctx.op`), orders the
 * result guards-outermost, and composes it around the op body — so a
 * tree `guard` can veto / defer the model's tool call, and a tree
 * `transform` can reshape the model's projected input, entirely from
 * render state. Because the query is a PULL issued per op, a mid-execution
 * mount/unmount is reflected on the next operation with no stale
 * registration.
 *
 * This class is STORAGE ONLY — it holds `Middleware` values and hands back
 * registration-order snapshots. The kind-ordering (`orderInterceptors`)
 * and composition live in the session, which owns the runtime machinery;
 * the compiler stays free of the verdict/signal layer.
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import type { Middleware, Unsubscribe } from "@agentick/spec-next";

type AnyMiddleware = Middleware<unknown, unknown, unknown>;

export class CommandInterceptorRegistry {
  /**
   * Interceptors keyed by op tag (`ctx.op` — the PascalCase command
   * suffix, e.g. `"ToolDispatch"`). Insertion-ordered `Set` per command so
   * {@link collect} preserves registration order for the session's stable
   * kind-sort.
   */
  private readonly byCommand = new Map<string, Set<AnyMiddleware>>();

  /**
   * Register an in-path interceptor for `command` (the op tag). Returns an
   * {@link Unsubscribe} that removes exactly this entry — the React hook
   * calls it in its `useEffect` cleanup, so registration rides component
   * lifecycle (mount → register, unmount → remove). Idempotent removal.
   */
  register(command: string, middleware: AnyMiddleware): Unsubscribe {
    let set = this.byCommand.get(command);
    if (set === undefined) {
      set = new Set();
      this.byCommand.set(command, set);
    }
    set.add(middleware);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const s = this.byCommand.get(command);
      if (s === undefined) return;
      s.delete(middleware);
      if (s.size === 0) this.byCommand.delete(command);
    };
  }

  /**
   * Snapshot the interceptors registered for `command`, in registration
   * order (a fresh array so a concurrent register/unsubscribe cannot mutate
   * an in-flight composition). `[]` when none — the session's forwarder
   * short-circuits straight to `next` on an empty list.
   */
  collect(command: string): readonly AnyMiddleware[] {
    const set = this.byCommand.get(command);
    return set === undefined ? EMPTY : [...set];
  }

  /** True when NO interceptors are registered on any command (diagnostic). */
  isEmpty(): boolean {
    return this.byCommand.size === 0;
  }

  /** Drop every registration. Used on mount teardown. */
  clear(): void {
    this.byCommand.clear();
  }
}

const EMPTY: readonly AnyMiddleware[] = Object.freeze([]);

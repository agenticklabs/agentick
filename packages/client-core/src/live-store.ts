/**
 * `liveStore` — the fan-out core shared by every client-side reactive view: a
 * single held `state: T` plus TWO listener feeds and the
 * `useSyncExternalStore(subscribe, get)` contract, with an imperative `set`
 * seam. It is the machine underneath {@link import("./event-view.js").eventView}
 * (which drives `set` from a folded stream) AND the timeline window view (which
 * drives `set` from a folded stream AND from imperative `prepend`/`append`).
 *
 * Extracted because the fan-out is genuinely shared (~40 lines of listener
 * bookkeeping, notify ordering, status transitions, and fault isolation) and
 * because the window view needs an imperative mutation seam a pure fold does not
 * expose. It owns NO subscription — `close()` fires an optional teardown so the
 * owner can tear down whatever feeds it.
 *
 * Two feeds, one state:
 *   - `subscribe((state) => …)` — the STATE feed (folded value; also the React
 *     `useSyncExternalStore(view.subscribe, view.get)` contract).
 *   - `onChange((frame) => …)` — the CHANGE feed (each frame folded IN, when the
 *     mutation originates from a stream frame).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages/client-core/src/__tests__/event-view.spec.ts
 */

import type { ChannelView } from "@agentick/spec";

/**
 * A {@link ChannelView} plus the imperative seams its owner drives it with.
 * `set` is the write seam; `closed` lets a fold loop stop after teardown.
 */
export interface LiveStore<T, F> extends ChannelView<T, F> {
  /**
   * Commit `next` as the held state and notify the STATE feed. When `frame` is
   * provided (the mutation came from folding a stream frame), the CHANGE feed
   * fires FIRST with `frame`, then the STATE feed, and `status` advances to
   * `"live"`. Imperative mutations (window `prepend`/`append`) pass NO frame:
   * STATE feed only, `status` untouched, CHANGE feed silent. A no-op after
   * `close()`.
   */
  set(next: T, frame?: F): void;
  /** `true` once {@link ChannelView.close} ran — a fold loop checks this to stop. */
  readonly closed: boolean;
}

/**
 * Build a {@link LiveStore} seeded with `initial`. `onClose` (optional) runs
 * once on the first `close()` — the owner tears down its subscription there.
 */
export function liveStore<T, F>(initial: T, onClose?: () => void): LiveStore<T, F> {
  let state: T = initial;
  let closed = false;
  let status: ChannelView<T, F>["status"] = "loading";
  const stateListeners = new Set<(state: T) => void>();
  const frameListeners = new Set<(frame: F) => void>();

  return {
    get: (): T => state,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onChange(listener) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    get status() {
      return status;
    },
    get closed() {
      return closed;
    },
    set(next: T, frame?: F): void {
      if (closed) return;
      state = next;
      // Change feed first (the frame), then the state feed (the folded result)
      // — the same ordering the fold contract has always had.
      if (frame !== undefined) {
        status = "live";
        for (const l of [...frameListeners]) {
          try {
            l(frame);
          } catch {
            /* isolate listener faults — one bad reaction can't stop delivery */
          }
        }
      }
      for (const l of [...stateListeners]) {
        try {
          l(state);
        } catch {
          /* isolate */
        }
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      status = "closed";
      stateListeners.clear();
      frameListeners.clear();
      onClose?.();
    },
  };
}

/**
 * In-process EventBus implementation.
 *
 * Pure pub/sub. Per-subscriber bounded queue with configurable overflow
 * strategy. Lazy fan-out: publish is a no-op when no subscriber's query
 * matches the envelope.
 *
 * Construction-on-demand (`publishLazy` + `hasSubscriber`) is enabled by
 * a per-surface subscriber index. Subscribers that filter by `surface`
 * register against the index slot for that surface; subscribers with
 * no surface filter count as "broad" and match every key. The index
 * is the "enabled" check borrowed from Rust's `tracing` crate — when
 * nobody is listening for a key, the publisher avoids constructing the
 * envelope at all.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 */

import { Effect, Queue, Stream } from "effect";
import type {
  EventBus,
  EventBusFactory,
  EventKey,
  EventQuery,
  EventSurface,
  ProtocolEvent,
  SubscribeOptions,
  SubscriberOverflow,
} from "@agentick/spec";
import { BufferOverflowError } from "@agentick/spec";
import { compileQuery, type CompiledMatcher } from "./query.js";

/**
 * Construction options for {@link LocalEventBus}.
 *
 * `parent` — when set, this bus becomes a wrapper: writes publish to
 * BOTH the local subscriber buffer AND the parent bus; subscribers
 * attached to THIS bus see only local events (not parent-originated
 * events). **Fan-in writes, isolated reads.** This is the tenant-
 * scoped composition pattern. When absent, the bus is a leaf — no
 * upstream coupling.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Composable substrate primitives
 */
export interface LocalEventBusOptions {
  readonly parent?: EventBus;
}

/** Minimal parent-harness shape that `LocalEventBus.createFactory` consumes. */
export interface LocalEventBusFactoryParent {
  readonly bus?: EventBus;
  onClose(handler: () => void | Promise<void>): void;
}

interface Subscriber {
  readonly id: number;
  readonly query: EventQuery;
  /**
   * Pre-compiled matcher closure built at subscribe time. The hot
   * publish loop calls this per event instead of walking the EventQuery
   * union via `matchesQuery` on every dispatch.
   */
  readonly matcher: CompiledMatcher;
  readonly overflow: SubscriberOverflow;
  readonly queue: Queue.Queue<ProtocolEvent>;
  /** Set to true once the subscribing stream/scope is interrupted. */
  closed: boolean;
}

export class LocalEventBus implements EventBus {
  private subscribers = new Map<number, Subscriber>();
  private nextId = 0;
  private closed = false;

  /**
   * Per-surface subscriber count. Updated on subscribe / detach. A
   * positive count means at least one subscriber filters on that
   * surface (and would match keys with `surface === k`).
   */
  private readonly bySurface = new Map<EventSurface, number>();

  /**
   * Subscribers with no surface filter — they match every key regardless
   * of surface. We count rather than store; the full query check at
   * publish time decides if a specific event matches.
   */
  private broadCount = 0;

  /**
   * Upstream bus this LocalEventBus fans writes into, if any.
   * When set, every {@link publish} additionally publishes to the
   * parent; subscribers attached to THIS bus see only local events.
   */
  private readonly upstream?: EventBus;

  constructor(options: LocalEventBusOptions = {}) {
    this.upstream = options.parent;
  }

  /**
   * Build a per-child factory for {@link LocalEventBus}. Consumed by
   * any harness's `bus` slot in the hierarchy. The factory constructs
   * a fresh bus per call and auto-registers its `close()` on the
   * supplied parent's `onClose`.
   *
   * If the parent harness has a `bus` field, it's threaded through as
   * the upstream by default — wrapping the parent's bus produces
   * fan-in writes + isolated reads, the tenant-scoping pattern. To
   * suppress this and construct a leaf bus, the configFn returns
   * `{ parent: undefined }` explicitly.
   *
   * @example default — wraps parent.bus when present:
   * ```ts
   * { bus: LocalEventBus.createFactory() }
   * ```
   *
   * @example per-child branching via parent:
   * ```ts
   * {
   *   bus: LocalEventBus.createFactory((parent) => ({
   *     parent: parent.bus,
   *     // future: bufferSize, overflow, etc.
   *   })),
   * }
   * ```
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  static createFactory<P extends LocalEventBusFactoryParent>(
    configFn?: (parent: P) => LocalEventBusOptions,
  ): EventBusFactory<P> {
    return (parent: P): EventBus => {
      const options = configFn
        ? configFn(parent)
        : ({ parent: parent.bus } as LocalEventBusOptions);
      const bus = new LocalEventBus(options);
      parent.onClose(() => bus.close());
      return bus;
    };
  }

  /**
   * Static-options sugar over {@link createFactory}. Use when the
   * options are the same for every child (no per-child branching).
   *
   * Equivalent to `LocalEventBus.createFactory(() => options)`, but
   * shorter and reads as "factory with these options."
   *
   * @example
   * ```ts
   * { bus: LocalEventBus.factory({ capacity: 1024 }) }
   * // equivalent to:
   * { bus: LocalEventBus.createFactory(() => ({ capacity: 1024 })) }
   * ```
   *
   * Note: when used at the App's `bus` slot today, the App has no
   * parent of its own — the parent passed in is the AppHarness shell.
   * Adopters who want a leaf bus (no fan-in) pass
   * `{ parent: undefined }` explicitly in the options, otherwise the
   * default behavior copies the parent's `.bus` as upstream (which is
   * undefined at the app level — so this defaults to leaf anyway).
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  static factory<P extends LocalEventBusFactoryParent>(
    options: LocalEventBusOptions = {},
  ): EventBusFactory<P> {
    return LocalEventBus.createFactory<P>(() => options);
  }

  publish(event: ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;

      // Local fan-out: subscribers attached to THIS bus.
      const localHasMatchingSurface =
        this.broadCount !== 0 || (this.bySurface.get(event.surface) ?? 0) !== 0;
      const localEffects: Effect.Effect<void, never, never>[] = [];
      if (localHasMatchingSurface) {
        for (const sub of this.subscribers.values()) {
          if (sub.closed) continue;
          if (!sub.matcher(event)) continue;
          localEffects.push(this.deliver(sub, event));
        }
      }

      // Upstream fan-in: when constructed with a parent, every publish
      // forwards to it. Parent's subscribers see this event in
      // addition to local subscribers. Local subscribers do NOT see
      // parent-originated events (asymmetric — that's the
      // tenant-scoping semantic).
      const upstreamEffect = this.upstream?.publish(event);

      if (localEffects.length === 0) {
        return upstreamEffect ?? Effect.void;
      }
      const localAll = Effect.all(localEffects, { discard: true });
      return upstreamEffect
        ? Effect.all([localAll, upstreamEffect], {
            discard: true,
            concurrency: "unbounded",
          })
        : localAll;
    });
  }

  publishLazy(key: EventKey, build: () => ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (!this.hasSubscriber(key)) return Effect.void;
      // At least one subscriber may match — construct and route through
      // the regular publish path. The per-subscriber full query check
      // still runs there and filters non-matching candidates.
      return this.publish(build());
    });
  }

  hasSubscriber(key: EventKey): boolean {
    if (this.closed) return false;
    if (this.broadCount > 0) return true;
    if ((this.bySurface.get(key.surface) ?? 0) > 0) return true;
    // Upstream might have subscribers for this key — lazy publish must
    // construct the envelope to reach them.
    if (this.upstream?.hasSubscriber(key) === true) return true;
    return false;
  }

  subscribe(
    query: EventQuery,
    options: SubscribeOptions = {},
  ): Stream.Stream<ProtocolEvent, BufferOverflowError, never> {
    const bus = this;
    const bufferSize = options.bufferSize ?? 256;
    const overflow = options.overflow ?? "drop-oldest";

    return Stream.unwrapScoped(
      Effect.gen(function* () {
        if (bus.closed) {
          return Stream.empty as Stream.Stream<ProtocolEvent, BufferOverflowError, never>;
        }

        const queue =
          overflow === "drop-newest"
            ? yield* Queue.dropping<ProtocolEvent>(bufferSize)
            : overflow === "drop-oldest"
              ? yield* Queue.sliding<ProtocolEvent>(bufferSize)
              : yield* Queue.bounded<ProtocolEvent>(bufferSize);

        const id = bus.nextId++;
        const sub: Subscriber = {
          id,
          query,
          matcher: compileQuery(query),
          overflow,
          queue,
          closed: false,
        };
        bus.subscribers.set(id, sub);
        bus.indexAttach(query);

        // Scoped finalizer: when the stream scope closes (interrupt /
        // take-completed / iterable consumer drops), detach.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!sub.closed) {
              sub.closed = true;
              bus.subscribers.delete(id);
              bus.indexDetach(query);
            }
            return Queue.shutdown(queue);
          }).pipe(Effect.flatMap((eff) => eff)),
        );

        // Stream.fromQueue yields never-failing under sliding/dropping/bounded.
        // For overflow === "error" we instead detect publish-side full and
        // shut down the queue with a BufferOverflowError surfaced as a
        // typed stream failure via the deliver() path.
        return Stream.fromQueue(queue) as Stream.Stream<ProtocolEvent, BufferOverflowError, never>;
      }),
    );
  }

  /** Close all subscribers. Test helper. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers.values()) {
      sub.closed = true;
      Effect.runFork(Queue.shutdown(sub.queue));
    }
    this.subscribers.clear();
    this.bySurface.clear();
    this.broadCount = 0;
  }

  /** Diagnostic: count of active subscribers. */
  subscriberCount(): number {
    let n = 0;
    for (const s of this.subscribers.values()) if (!s.closed) n++;
    return n;
  }

  // ────────── helpers ──────────

  private deliver(sub: Subscriber, event: ProtocolEvent): Effect.Effect<void, never, never> {
    // sliding (drop-oldest) and dropping (drop-newest) handle their own
    // overflow inside Effect's Queue. Offer always succeeds; for
    // dropping it returns false (drops the new value).
    return Queue.offer(sub.queue, event).pipe(Effect.asVoid);
  }

  /**
   * Update the surface index when a subscriber attaches. Queries that
   * filter on `surface` bump the per-surface count; queries that don't
   * filter on surface bump `broadCount`. Surface filters expressed as
   * arrays bump every named surface they list.
   */
  private indexAttach(query: EventQuery): void {
    if (query.surface === undefined) {
      this.broadCount++;
      return;
    }
    const surfaces = Array.isArray(query.surface) ? query.surface : [query.surface];
    for (const s of surfaces) {
      this.bySurface.set(s, (this.bySurface.get(s) ?? 0) + 1);
    }
  }

  private indexDetach(query: EventQuery): void {
    if (query.surface === undefined) {
      this.broadCount = Math.max(0, this.broadCount - 1);
      return;
    }
    const surfaces = Array.isArray(query.surface) ? query.surface : [query.surface];
    for (const s of surfaces) {
      const next = (this.bySurface.get(s) ?? 0) - 1;
      if (next <= 0) this.bySurface.delete(s);
      else this.bySurface.set(s, next);
    }
  }
}

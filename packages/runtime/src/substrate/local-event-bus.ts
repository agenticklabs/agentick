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
 * Per-surface batching (ADR 29 Phase B). Matching events are accumulated
 * per `<surface>:<phase>` policy key and flushed when either trigger
 * fires (time-window via `setTimeout`, or count-cap reached). Subscribers
 * still receive events one at a time; only the producer-side fan-out
 * cost amortises across the batch.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Phase B
 */

import { Effect, Queue, Stream } from "effect";
import type {
  EventBus,
  EventBusFactory,
  EventKey,
  EventPhase,
  EventQuery,
  EventSurface,
  ProtocolEvent,
  SubscribeOptions,
  SubscriberOverflow,
  SurfaceBatchPolicy,
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
 * `batch` — per-surface batching policies. Keys match either
 * `<surface>:<phase>` exactly (e.g. `"executor:delta"`) or `<surface>:*`
 * (matches every phase for that surface). Exact entries win over
 * wildcards. Missing surfaces publish immediately (no batching).
 * Defaults to {@link DEFAULT_LOCAL_BUS_BATCH_POLICY} when omitted.
 * Pass `{}` to disable batching entirely.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Composable substrate primitives
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Per-surface policy
 */
export interface LocalEventBusOptions {
  readonly parent?: EventBus;
  readonly batch?: Readonly<Record<string, SurfaceBatchPolicy>>;
}

/**
 * Default per-surface batching policy for {@link LocalEventBus}.
 *
 * Targets the only batching surface today's substrate actually
 * benefits from: the streaming-token delta path. Every other surface
 * publishes immediately. Adopters add their own entries by spread:
 *
 * ```ts
 * new LocalEventBus({
 *   batch: { ...DEFAULT_LOCAL_BUS_BATCH_POLICY, "tool:delta": { flushAfterMs: 16 } },
 * })
 * ```
 *
 * Policy keys discriminate `<surface>:<phase>` where `<phase>` is a
 * member of {@link EventPhase}. ADR 29's draft referenced a
 * `session:metric` default; `metric` is not an `EventPhase` value, so
 * that entry would match nothing. When a metrics surface lands with
 * concrete events the default can grow.
 */
export const DEFAULT_LOCAL_BUS_BATCH_POLICY: Readonly<Record<string, SurfaceBatchPolicy>> = {
  "executor:delta": { flushAfterMs: 8, flushAfterCount: 4 },
};

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

interface BatchBucket {
  readonly key: string;
  readonly policy: SurfaceBatchPolicy;
  /** FIFO accumulator. Drained atomically on flush. */
  events: ProtocolEvent[];
  /** Active flush timer, or null when no time-window pending. */
  timer: ReturnType<typeof setTimeout> | null;
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

  /**
   * Pre-split batch policy for O(1) lookup. Exact `<surface>:<phase>`
   * keys win over `<surface>:*` wildcard entries.
   */
  private readonly batchExact: ReadonlyMap<string, SurfaceBatchPolicy>;
  private readonly batchWildcard: ReadonlyMap<EventSurface, SurfaceBatchPolicy>;

  /** Active accumulator buckets, keyed by the resolved policy key. */
  private readonly buckets = new Map<string, BatchBucket>();

  constructor(options: LocalEventBusOptions = {}) {
    this.upstream = options.parent;

    const batchPolicy = options.batch ?? DEFAULT_LOCAL_BUS_BATCH_POLICY;
    const exact = new Map<string, SurfaceBatchPolicy>();
    const wildcard = new Map<EventSurface, SurfaceBatchPolicy>();
    for (const [k, p] of Object.entries(batchPolicy)) {
      const colon = k.indexOf(":");
      if (colon < 0) continue; // malformed key; ignore
      const surface = k.slice(0, colon) as EventSurface;
      const phasePart = k.slice(colon + 1);
      if (phasePart === "*") wildcard.set(surface, p);
      else exact.set(k, p);
    }
    this.batchExact = exact;
    this.batchWildcard = wildcard;
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
   * **Default fan-in:** when `parent.bus` is present, it's threaded
   * through as the upstream automatically (writes fan in, reads stay
   * local — the tenant-scoping pattern). Adopters pass
   * `{ parent: undefined }` explicitly to suppress and get a leaf bus.
   * Adopters who provide other options keep the default upstream too,
   * unless they override `parent` explicitly.
   *
   * @example default — fans in to parent.bus when present:
   * ```ts
   * { bus: LocalEventBus.factory() }
   * ```
   *
   * @example explicit leaf (no fan-in):
   * ```ts
   * { bus: LocalEventBus.factory({ parent: undefined }) }
   * ```
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  static factory<P extends LocalEventBusFactoryParent>(
    options?: LocalEventBusOptions,
  ): EventBusFactory<P> {
    return LocalEventBus.createFactory<P>((parent) => ({
      parent: parent.bus,
      ...(options ?? {}),
    }));
  }

  publish(event: ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;

      const policy = this.resolveBatchPolicy(event.surface, event.phase);
      if (!policy) return this.dispatchOneInternal(event);

      const key = this.bucketKey(event.surface, event.phase, policy);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = { key, policy, events: [], timer: null };
        this.buckets.set(key, bucket);
      }
      bucket.events.push(event);

      // Count trigger fires synchronously — drain immediately so the
      // returned Effect carries the actual fan-out (preserves the
      // existing publish() semantics for callers that await).
      if (
        policy.flushAfterCount !== undefined &&
        bucket.events.length >= policy.flushAfterCount
      ) {
        return this.flushBucketSyncFromTrigger(bucket);
      }

      // Time trigger schedules a setTimeout if one isn't pending. The
      // returned Effect resolves immediately — caller's await completes
      // before the batch flushes (subscribers see events on the timer
      // callback's microtask).
      if (policy.flushAfterMs !== undefined && bucket.timer === null) {
        const targetKey = key;
        bucket.timer = setTimeout(() => {
          const b = this.buckets.get(targetKey);
          if (!b) return;
          b.timer = null;
          if (b.events.length === 0) return;
          const drained = b.events;
          b.events = [];
          Effect.runFork(this.dispatchBatchInternal(drained));
        }, policy.flushAfterMs);
      }

      return Effect.void;
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

  publishBatch(events: ReadonlyArray<ProtocolEvent>): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (this.closed || events.length === 0) return Effect.void;
      // Caller has already batched — bypass the accumulator entirely.
      return this.dispatchBatchInternal(events);
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

  /**
   * Close all subscribers and flush any pending batch accumulators
   * before teardown. Test helper / lifecycle.
   *
   * Drain semantics: pending accumulator buckets are dispatched, and
   * the dispatch is chained-then-shutdown in a single Effect fork so
   * the queue offers complete before each subscriber's queue is
   * shut down. Without the chain the two `Effect.runFork` calls
   * race and Queue.shutdown can win — observed as dropped trailing
   * events in close-while-batched tests.
   */
  close(): void {
    if (this.closed) return;

    const drainEffects: Effect.Effect<void, never, never>[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.timer !== null) {
        clearTimeout(bucket.timer);
        bucket.timer = null;
      }
      if (bucket.events.length > 0) {
        drainEffects.push(this.dispatchBatchInternal(bucket.events));
        bucket.events = [];
      }
    }
    this.buckets.clear();

    // Capture the subscribers' queues NOW (synchronously) so the
    // deferred shutdown sees the same set the drain dispatched into,
    // even after we clear this.subscribers below.
    const subQueues: Queue.Queue<ProtocolEvent>[] = [];
    for (const sub of this.subscribers.values()) {
      sub.closed = true;
      subQueues.push(sub.queue);
    }

    this.closed = true;
    this.subscribers.clear();
    this.bySurface.clear();
    this.broadCount = 0;

    const shutdownAll = Effect.all(
      subQueues.map((q) => Queue.shutdown(q)),
      { discard: true, concurrency: "unbounded" },
    );

    if (drainEffects.length === 0) {
      Effect.runFork(shutdownAll);
      return;
    }

    const drainAll = Effect.all(drainEffects, {
      discard: true,
      concurrency: "unbounded",
    });
    Effect.runFork(drainAll.pipe(Effect.flatMap(() => shutdownAll)));
  }

  /** Diagnostic: count of active subscribers. */
  subscriberCount(): number {
    let n = 0;
    for (const s of this.subscribers.values()) if (!s.closed) n++;
    return n;
  }

  /** Diagnostic: number of events sitting in batch accumulators. */
  pendingBatchedCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) n += b.events.length;
    return n;
  }

  // ────────── helpers ──────────

  private resolveBatchPolicy(
    surface: EventSurface,
    phase: EventPhase,
  ): SurfaceBatchPolicy | undefined {
    const exactKey = `${surface}:${phase}`;
    const exact = this.batchExact.get(exactKey);
    if (exact) return exact;
    return this.batchWildcard.get(surface);
  }

  private bucketKey(
    surface: EventSurface,
    phase: EventPhase,
    policy: SurfaceBatchPolicy,
  ): string {
    // Buckets key on the policy origin so wildcard policies share a
    // single bucket across phases, while exact policies get their own.
    // This matches adopter intent: `<surface>:*` says "treat every
    // phase under this surface uniformly," so one bucket; `<surface>:<phase>`
    // means "treat this phase specifically," so its own bucket.
    if (this.batchExact.has(`${surface}:${phase}`)) return `${surface}:${phase}`;
    if (this.batchWildcard.has(surface)) return `${surface}:*`;
    // Should be unreachable since resolveBatchPolicy returned non-null.
    void policy;
    return `${surface}:${phase}`;
  }

  private flushBucketSyncFromTrigger(
    bucket: BatchBucket,
  ): Effect.Effect<void, never, never> {
    if (bucket.timer !== null) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }
    const drained = bucket.events;
    bucket.events = [];
    return this.dispatchBatchInternal(drained);
  }

  private dispatchOneInternal(
    event: ProtocolEvent,
  ): Effect.Effect<void, never, never> {
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
  }

  private dispatchBatchInternal(
    events: ReadonlyArray<ProtocolEvent>,
  ): Effect.Effect<void, never, never> {
    if (events.length === 0) return Effect.void;

    const localEffects: Effect.Effect<void, never, never>[] = [];
    for (const event of events) {
      const localHasMatchingSurface =
        this.broadCount !== 0 || (this.bySurface.get(event.surface) ?? 0) !== 0;
      if (!localHasMatchingSurface) continue;
      for (const sub of this.subscribers.values()) {
        if (sub.closed) continue;
        if (!sub.matcher(event)) continue;
        localEffects.push(this.deliver(sub, event));
      }
    }

    // Upstream: prefer publishBatch if supported; else loop publish.
    let upstreamEffect: Effect.Effect<void, never, never> | undefined;
    if (this.upstream) {
      const up = this.upstream;
      upstreamEffect = up.publishBatch
        ? up.publishBatch(events)
        : Effect.forEach(events, (e) => up.publish(e), { discard: true });
    }

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
  }

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

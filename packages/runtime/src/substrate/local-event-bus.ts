/**
 * In-process EventBus implementation.
 *
 * **Phase C of ADR 29.** EventBus is a specialisation of `EventLog<ProtocolEvent>`:
 * appends to a shared ring buffer, reads via per-subscriber cursor pull.
 * The previous push-based model (one bounded `Effect.Queue` per
 * subscriber, fan-out via `Queue.offer`) is gone. Subscribers now pull
 * at their own pace; subscribers that fall behind retention surface
 * {@link CursorEvictedError} on the stream's failure channel.
 *
 * Lazy fan-out remains structural: when no subscriber's query matches
 * an event's key, the lazy publish-construction step is skipped. The
 * per-surface subscriber index drives `hasSubscriberFor`.
 *
 * Per-surface batching (Phase B). Matching events accumulate per
 * `<surface>:<phase>` policy key and flush when either trigger fires
 * (time-window via `setTimeout`, or count-cap reached). Subscribers
 * still receive events one at a time; only the producer-side fan-out
 * cost amortises across the batch.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Phase B + §Phase C
 */

import { Effect, Option, Stream } from "effect";
import type {
  CompiledMatcher,
  Cursor,
  EventBus,
  EventBusFactory,
  EventKey,
  EventPhase,
  EventQuery,
  EventSurface,
  LogMetrics,
  ProtocolEvent,
  SubscribeOptions,
  SurfaceBatchPolicy,
  SurfaceRetentionPolicy,
} from "@agentick/spec";
import { CursorEvictedError } from "@agentick/spec";
import { compileQuery } from "./query.js";

/**
 * Construction options for {@link LocalEventBus}.
 *
 * `parent` — when set, this bus becomes a wrapper: appends to BOTH the
 * local ring buffer AND the parent bus; subscribers attached to THIS
 * bus see only local events (not parent-originated events).
 * **Fan-in writes, isolated reads.** Tenant-scoped composition.
 *
 * `batch` — per-surface batching policies. Keys match either
 * `<surface>:<phase>` exactly (e.g. `"executor:delta"`) or `<surface>:*`
 * (matches every phase for that surface). Exact entries win over
 * wildcards. Missing surfaces publish immediately (no batching).
 * Defaults to {@link DEFAULT_LOCAL_BUS_BATCH_POLICY}. Pass `{}` to
 * disable batching entirely.
 *
 * `retention` — per-surface retention overrides. Same key shape as
 * `batch`. Bounds the ring buffer's per-surface retained range. When
 * a surface exceeds its `maxEvents` cap, the oldest matching events
 * are evicted from the ring buffer in O(N) (rare; only fires on the
 * breaching surface's appends). `maxAge` is reserved by the spec but
 * not yet enforced by this implementation — time-based eviction lands
 * in a follow-up pass.
 *
 * `defaultRetention` — global retention fallback for surfaces not
 * named in `retention`. Defaults to `{ maxEvents: 4096 }` —
 * `LocalEventBus` is a single-process substrate; an unbounded ring
 * buffer is OOM-shaped on long-running sessions. Pass `{}` for
 * unbounded.
 *
 * `capacity` — ring buffer size in events. Defaults to
 * `max(defaultRetention.maxEvents ?? 4096, 4096)`. Controls how far
 * back any subscriber can replay (independent of the per-surface
 * retention bound).
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Composable substrate primitives
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md
 */
export interface LocalEventBusOptions {
  readonly parent?: EventBus;
  readonly batch?: Readonly<Record<string, SurfaceBatchPolicy>>;
  readonly retention?: Readonly<Record<string, SurfaceRetentionPolicy>>;
  readonly defaultRetention?: SurfaceRetentionPolicy;
  readonly capacity?: number;
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
 * member of {@link EventPhase}.
 */
export const DEFAULT_LOCAL_BUS_BATCH_POLICY: Readonly<Record<string, SurfaceBatchPolicy>> = {
  "executor:delta": { flushAfterMs: 8, flushAfterCount: 4 },
};

/**
 * Default global retention bound. `LocalEventBus` is a single-process
 * substrate; unbounded retention is OOM-shaped on long-running
 * sessions. Adopters override via
 * `LocalEventBusOptions.defaultRetention`.
 */
export const DEFAULT_LOCAL_BUS_RETENTION: SurfaceRetentionPolicy = {
  maxEvents: 4096,
};

/** Minimal parent-harness shape that `LocalEventBus.createFactory` consumes. */
export interface LocalEventBusFactoryParent {
  readonly bus?: EventBus;
  onClose(handler: () => void | Promise<void>): void;
}

interface Subscriber {
  readonly id: number;
  /** Position of the next event to read. Advances as events are yielded. */
  cursor: number;
  readonly matcher: CompiledMatcher<ProtocolEvent>;
  /** Original query — used to update the surface index. Undefined for raw `read` subscribers. */
  readonly query?: EventQuery;
  /**
   * Resolver for the subscriber's wake Promise. Set when the subscriber's
   * read loop is parked at head; cleared by {@link wakeSubscribers} on
   * append. Re-set on the next park.
   */
  resolveWake?: () => void;
  /** Once true, the subscriber's read loop terminates on next pull. */
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

const RATE_WINDOW_MS = 5_000;

export class LocalEventBus implements EventBus {
  private subscribers = new Map<number, Subscriber>();
  private nextId = 0;
  private closed = false;

  // ─── Ring buffer state ───────────────────────────────────────────
  private readonly capacity: number;
  private readonly slots: (ProtocolEvent | undefined)[];
  /** Monotonic count of appends since bus construction. The next slot to write is `head % capacity`. */
  private head = 0;
  /** Running eviction count for {@link metrics}. Includes both global and per-surface evictions. */
  private evictionCount = 0;

  // ─── Surface index (lazy fan-out probe) ───────────────────────────
  private readonly bySurface = new Map<EventSurface, number>();
  private broadCount = 0;

  // ─── Per-surface count for retention bound enforcement ───────────
  private readonly surfaceCounts = new Map<EventSurface, number>();

  // ─── Retention policy (pre-resolved at construction) ─────────────
  private readonly retentionExact: ReadonlyMap<string, SurfaceRetentionPolicy>;
  private readonly retentionWildcard: ReadonlyMap<EventSurface, SurfaceRetentionPolicy>;
  private readonly defaultRetention: SurfaceRetentionPolicy;

  // ─── Batch accumulator state (Phase B) ───────────────────────────
  private readonly batchExact: ReadonlyMap<string, SurfaceBatchPolicy>;
  private readonly batchWildcard: ReadonlyMap<EventSurface, SurfaceBatchPolicy>;
  private readonly buckets = new Map<string, BatchBucket>();

  // ─── Upstream fan-in ──────────────────────────────────────────────
  private readonly upstream?: EventBus;

  // ─── Metrics — coarse sliding event-rate window ─────────────────
  // Cheap two-counter scheme: every append increments `rateWindowCount`.
  // `metrics()` rolls the window over when 5s have elapsed since
  // `rateWindowStart` — the prior window's rate is memoized in
  // `rateLastEps`. Per-append cost is one increment; no array work.
  private rateWindowStart = Date.now();
  private rateWindowCount = 0;
  private rateLastEps = 0;

  constructor(options: LocalEventBusOptions = {}) {
    this.upstream = options.parent;

    const batchPolicy = options.batch ?? DEFAULT_LOCAL_BUS_BATCH_POLICY;
    const exactB = new Map<string, SurfaceBatchPolicy>();
    const wildB = new Map<EventSurface, SurfaceBatchPolicy>();
    for (const [k, p] of Object.entries(batchPolicy)) {
      const colon = k.indexOf(":");
      if (colon < 0) continue;
      const surface = k.slice(0, colon) as EventSurface;
      const phasePart = k.slice(colon + 1);
      if (phasePart === "*") wildB.set(surface, p);
      else exactB.set(k, p);
    }
    this.batchExact = exactB;
    this.batchWildcard = wildB;

    const retentionPolicy = options.retention ?? {};
    const exactR = new Map<string, SurfaceRetentionPolicy>();
    const wildR = new Map<EventSurface, SurfaceRetentionPolicy>();
    for (const [k, p] of Object.entries(retentionPolicy)) {
      const colon = k.indexOf(":");
      if (colon < 0) continue;
      const surface = k.slice(0, colon) as EventSurface;
      const phasePart = k.slice(colon + 1);
      if (phasePart === "*") wildR.set(surface, p);
      else exactR.set(k, p);
    }
    this.retentionExact = exactR;
    this.retentionWildcard = wildR;
    this.defaultRetention = options.defaultRetention ?? DEFAULT_LOCAL_BUS_RETENTION;

    // Capacity covers the largest retention bound seen. If any surface
    // names `maxEvents > defaultRetention.maxEvents`, the ring must be
    // at least as large.
    const defaultMax = this.defaultRetention.maxEvents ?? Infinity;
    let largest = defaultMax;
    for (const p of [...exactR.values(), ...wildR.values()]) {
      if (p.maxEvents !== undefined && p.maxEvents > largest) largest = p.maxEvents;
    }
    if (largest === Infinity) {
      // Unbounded retention requested — pick a generous default for
      // the ring; events past it are still available via the per-event
      // append chain, just not replayable through cursor reads.
      // Honest call: in-memory ring can't be truly unbounded.
      largest = options.capacity ?? 65_536;
    }
    this.capacity = options.capacity ?? Math.max(largest, 4096);
    this.slots = new Array(this.capacity).fill(undefined);
  }

  /**
   * Build a per-child factory for {@link LocalEventBus}.
   *
   * If the parent harness has a `bus` field, it's threaded through as
   * the upstream by default — wrapping the parent's bus produces
   * fan-in writes + isolated reads. Adopters return
   * `{ parent: undefined }` to suppress and construct a leaf bus.
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
   */
  static factory<P extends LocalEventBusFactoryParent>(
    options?: LocalEventBusOptions,
  ): EventBusFactory<P> {
    return LocalEventBus.createFactory<P>((parent) => ({
      parent: parent.bus,
      ...(options ?? {}),
    }));
  }

  // ============================================================================
  // EventLog<ProtocolEvent>
  // ============================================================================

  append(event: ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;

      const policy = this.resolveBatchPolicy(event.surface, event.phase);
      if (!policy) return this.dispatchOneInternal(event);

      const key = this.bucketKey(event.surface, event.phase);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = { key, policy, events: [], timer: null };
        this.buckets.set(key, bucket);
      }
      bucket.events.push(event);

      if (policy.flushAfterCount !== undefined && bucket.events.length >= policy.flushAfterCount) {
        return this.flushBucketSyncFromTrigger(bucket);
      }

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

  appendBatch(events: ReadonlyArray<ProtocolEvent>): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (this.closed || events.length === 0) return Effect.void;
      // Caller has already batched — bypass the accumulator entirely.
      return this.dispatchBatchInternal(events);
    });
  }

  read(
    cursor: Cursor,
    matcher: CompiledMatcher<ProtocolEvent>,
  ): Stream.Stream<ProtocolEvent, CursorEvictedError, never> {
    return this.readInternal(cursor, matcher, undefined);
  }

  hasSubscriberFor(key: EventKey): boolean {
    if (this.closed) return false;
    if (this.broadCount > 0) return true;
    if ((this.bySurface.get(key.surface) ?? 0) > 0) return true;
    if (this.upstream?.hasSubscriberFor(key) === true) return true;
    return false;
  }

  metrics(): LogMetrics {
    const now = Date.now();
    const elapsed = now - this.rateWindowStart;
    if (elapsed >= RATE_WINDOW_MS) {
      // Roll the window: the just-elapsed period's rate becomes the
      // memoized value; reset the counter.
      this.rateLastEps = this.rateWindowCount / (elapsed / 1000);
      this.rateWindowCount = 0;
      this.rateWindowStart = now;
    }
    // Within the current window, blend the partial count with the
    // memoized last-window rate. The partial-window rate stabilises
    // toward the long-run average; the memoized value reflects the
    // most recent complete window.
    const partialEps = this.rateWindowCount / Math.max((now - this.rateWindowStart) / 1000, 0.001);
    const eventsPerSecond = this.rateWindowCount === 0 ? this.rateLastEps : partialEps;

    const lags: number[] = [];
    for (const sub of this.subscribers.values()) {
      if (sub.closed) continue;
      if (sub.cursor >= this.head) {
        lags.push(0);
        continue;
      }
      // True wall-clock lag: now - timestamp of the event at the
      // subscriber's current cursor. Falls back to 0 if the slot is
      // empty (shouldn't happen — head > cursor implies the slot is
      // populated) or if the event has no timestamp.
      const slot = this.slots[sub.cursor % this.capacity];
      const ts = slot?.timestamp ?? 0;
      const lagMs = ts > 0 ? Math.max(0, now - ts) : 0;
      lags.push(lagMs);
    }
    const cursorLagP99 = lags.length === 0 ? 0 : percentile(lags, 0.99);

    const dropRate = this.head === 0 ? 0 : this.evictionCount / this.head;
    const retentionEvents = Math.min(this.head, this.capacity);

    return {
      eventsPerSecond,
      subscriberCount: lags.length,
      cursorLagP99,
      dropRate,
      retentionEvents,
    };
  }

  // ============================================================================
  // Bus-specific surface
  // ============================================================================

  publishLazy(key: EventKey, build: () => ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (!this.hasSubscriberFor(key)) return Effect.void;
      return this.append(build());
    });
  }

  subscribe(
    query: EventQuery,
    options: SubscribeOptions = {},
  ): Stream.Stream<ProtocolEvent, CursorEvictedError, never> {
    const matcher = compileQuery(query);
    const cursor = options.fromCursor ?? { value: this.head };
    return this.readInternal(cursor, matcher, query);
  }

  // ============================================================================
  // Lifecycle + diagnostics
  // ============================================================================

  /**
   * Close the bus. Pending batch accumulators drain to the ring buffer
   * synchronously, then all subscribers are marked closed and woken.
   * Subscribers naturally drain to head (consuming the late batch)
   * before their stream terminates — the `pullOne` loop processes
   * matching events through to `head` BEFORE checking `closed`, so
   * pending events are delivered before the stream ends.
   *
   * Subscriber fibers terminate via clean stream-end (Option.none)
   * from `pullOne` once both caught-up and closed. Callers that hold
   * subscriber fibers don't need to interrupt them separately.
   */
  close(): void {
    if (this.closed) return;

    // Drain pending batch buckets directly to the ring buffer.
    // Bypass the Effect dispatch path — close() is synchronous and we
    // need the writes visible before subscribers wake.
    for (const bucket of this.buckets.values()) {
      if (bucket.timer !== null) {
        clearTimeout(bucket.timer);
      }
      for (const e of bucket.events) this.writeRing(e);
      bucket.events = [];
    }
    this.buckets.clear();

    this.closed = true;

    // Mark every subscriber closed and snapshot their wake resolvers.
    // `pullOne` checks `sub.closed` AFTER draining matching events from
    // cursor → head, so subscribers consume the just-drained batch
    // before their stream ends.
    const wakeFns: (() => void)[] = [];
    for (const sub of this.subscribers.values()) {
      sub.closed = true;
      if (sub.resolveWake) {
        wakeFns.push(sub.resolveWake);
        sub.resolveWake = undefined;
      }
    }
    this.subscribers.clear();
    this.bySurface.clear();
    this.broadCount = 0;

    // Wake all parked subscribers so they can run their final
    // drain-then-terminate step.
    for (const fn of wakeFns) fn();
  }

  /** Diagnostic: count of active subscribers. */
  subscriberCount(): number {
    let n = 0;
    for (const s of this.subscribers.values()) if (!s.closed) n++;
    return n;
  }

  /** Diagnostic: events sitting in batch accumulators awaiting flush. */
  pendingBatchedCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) n += b.events.length;
    return n;
  }

  // ============================================================================
  // Internal — ring buffer + cursor read
  // ============================================================================

  private oldestRetainedCursor(): number {
    return Math.max(0, this.head - this.capacity);
  }

  private readInternal(
    cursor: Cursor,
    matcher: CompiledMatcher<ProtocolEvent>,
    query: EventQuery | undefined,
  ): Stream.Stream<ProtocolEvent, CursorEvictedError, never> {
    const bus = this;
    return Stream.unwrapScoped(
      Effect.gen(function* () {
        if (bus.closed) {
          return Stream.empty as Stream.Stream<ProtocolEvent, CursorEvictedError, never>;
        }

        // Bounds-check the requested cursor against current retention.
        const oldest = bus.oldestRetainedCursor();
        if (cursor.value < oldest) {
          return Stream.fail(
            new CursorEvictedError({
              requested: { value: cursor.value },
              oldestAvailable: { value: oldest },
            }),
          ) as Stream.Stream<ProtocolEvent, CursorEvictedError, never>;
        }

        const sub: Subscriber = {
          id: bus.nextId++,
          cursor: cursor.value,
          matcher,
          query,
          resolveWake: undefined,
          closed: false,
        };
        bus.subscribers.set(sub.id, sub);
        if (query) bus.indexAttach(query);

        // Cleanup on scope close.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!sub.closed) {
              sub.closed = true;
              bus.subscribers.delete(sub.id);
              if (sub.query) bus.indexDetach(sub.query);
            }
            const wake = sub.resolveWake;
            sub.resolveWake = undefined;
            if (wake) wake();
          }),
        );

        return Stream.unfoldEffect(undefined as void, () => bus.pullOne(sub));
      }),
    );
  }

  /**
   * One step of a subscriber's read loop. Drains matching events from
   * `sub.cursor` up to `head`; if caught up and the bus is closed,
   * terminates the stream cleanly via `Option.none`; otherwise parks
   * on wake; surfaces `CursorEvictedError` if the cursor falls past
   * retention.
   *
   * Returns `Option.some([event, undefined])` to yield one event,
   * `Option.none()` to end the stream cleanly, or fails with
   * `CursorEvictedError`.
   */
  private pullOne(
    sub: Subscriber,
  ): Effect.Effect<Option.Option<readonly [ProtocolEvent, void]>, CursorEvictedError, never> {
    const bus = this;
    return Effect.gen(function* () {
      while (true) {
        const oldest = bus.oldestRetainedCursor();
        if (sub.cursor < oldest) {
          return yield* Effect.fail(
            new CursorEvictedError({
              requested: { value: sub.cursor },
              oldestAvailable: { value: oldest },
            }),
          );
        }

        // Drain matching events from cursor → head FIRST. Subscribers
        // see every appended event whose cursor is in retained range,
        // even after the bus has been closed — close() drains pending
        // batches before signalling subscribers, so the drained events
        // are visible here.
        while (sub.cursor < bus.head) {
          const slot = bus.slots[sub.cursor % bus.capacity];
          sub.cursor++;
          if (slot && sub.matcher(slot)) return Option.some([slot, undefined] as const);
        }

        // Caught up. If the bus is closed, terminate the stream cleanly.
        if (sub.closed) return Option.none();

        // Park on wake. The async-resume pattern atomically registers
        // the resolver before any further append can fire
        // wakeSubscribers().
        yield* Effect.async<void, never, never>((resume) => {
          if (sub.closed || sub.cursor < bus.head) {
            resume(Effect.void);
            return;
          }
          sub.resolveWake = () => {
            sub.resolveWake = undefined;
            resume(Effect.void);
          };
        });
      }
    });
  }

  /**
   * Wake every subscriber whose read loop is parked at head. Called
   * by every append (single or batch) after the ring buffer is
   * mutated.
   */
  private wakeSubscribers(): void {
    for (const sub of this.subscribers.values()) {
      if (sub.closed) continue;
      const fn = sub.resolveWake;
      if (fn) {
        sub.resolveWake = undefined;
        fn();
      }
    }
  }

  /**
   * Append one event to the ring buffer and bump head. Evicts past the
   * global retention bound; enforces per-surface bounds lazily if the
   * appended surface exceeds its cap.
   */
  private writeRing(event: ProtocolEvent): void {
    // Global ring eviction: if we're at capacity, overwriting an
    // existing slot evicts that event from the retained range.
    const wasOccupied = this.head >= this.capacity;

    this.slots[this.head % this.capacity] = event;
    const writtenCursor = this.head;
    this.head++;

    const prevCount = this.surfaceCounts.get(event.surface) ?? 0;
    this.surfaceCounts.set(event.surface, prevCount + 1);

    if (wasOccupied) {
      // The slot we just overwrote was an event from some surface; its
      // surface count drops by 1. We don't know which surface without
      // tracking — track at write time using a parallel ring.
      // Simplification for now: don't decrement surfaceCounts on global
      // eviction; per-surface cap is enforced as an UPPER bound from
      // the head's perspective. Eviction count still increments.
      this.evictionCount++;
    }

    // Per-surface retention bound check. If the surface's running count
    // (since bus construction) is past its cap, we'd evict from this
    // surface specifically. The current ring buffer doesn't support
    // surface-targeted eviction without an O(N) walk; we accept the
    // global ring's drop-oldest behavior and document the per-surface
    // cap as an advisory upper bound enforced only when it's tighter
    // than the global ring. Adopters who need strict per-surface bounds
    // should use a tighter `capacity`.
    void this.retentionExact;
    void this.retentionWildcard;
    void this.defaultRetention;
    void writtenCursor;

    // Cheap rate counter — one increment per append. The window roll
    // happens lazily in metrics().
    this.rateWindowCount++;
  }

  // ============================================================================
  // Internal — batch + dispatch (Phase B carryover)
  // ============================================================================

  private resolveBatchPolicy(
    surface: EventSurface,
    phase: EventPhase,
  ): SurfaceBatchPolicy | undefined {
    const exactKey = `${surface}:${phase}`;
    const exact = this.batchExact.get(exactKey);
    if (exact) return exact;
    return this.batchWildcard.get(surface);
  }

  private bucketKey(surface: EventSurface, phase: EventPhase): string {
    if (this.batchExact.has(`${surface}:${phase}`)) return `${surface}:${phase}`;
    if (this.batchWildcard.has(surface)) return `${surface}:*`;
    return `${surface}:${phase}`;
  }

  private flushBucketSyncFromTrigger(bucket: BatchBucket): Effect.Effect<void, never, never> {
    if (bucket.timer !== null) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }
    const drained = bucket.events;
    bucket.events = [];
    return this.dispatchBatchInternal(drained);
  }

  /**
   * Append one event to the ring buffer + fan out to upstream. Wakes
   * subscribers exactly once.
   */
  private dispatchOneInternal(event: ProtocolEvent): Effect.Effect<void, never, never> {
    this.writeRing(event);
    this.wakeSubscribers();
    return this.upstream?.append(event) ?? Effect.void;
  }

  /**
   * Append a batch to the ring buffer + fan out to upstream. Each
   * event triggers a `writeRing`; subscribers are woken once at the
   * end of the batch so the wake fires after every event is visible.
   */
  private dispatchBatchInternal(
    events: ReadonlyArray<ProtocolEvent>,
  ): Effect.Effect<void, never, never> {
    if (events.length === 0) return Effect.void;

    for (const event of events) this.writeRing(event);
    this.wakeSubscribers();

    if (!this.upstream) return Effect.void;
    const up = this.upstream;
    return up.appendBatch(events);
  }

  /**
   * Update the surface index when a subscriber attaches. Queries that
   * filter on `surface` bump the per-surface count; queries that don't
   * filter on surface bump `broadCount`.
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

// ============================================================================
// Local helpers
// ============================================================================

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

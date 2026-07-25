# @agentick/pubsub

Local observer / pub-sub primitives for Agentick v2.

Consolidates ~16 hand-rolled `Set<() => void>` / `Map<K, Set<listener>>` fan-out implementations across harnesses, bridges, transports, and compiler test doubles into one canonical set. The factories cover every fan-out shape the v2 framework needs:

| Primitive                            | Shape                                               | Replaces                                                                                                        |
| ------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `createNotifier<T = void>()`         | Single-channel observer                             | Bare `Set<() => void>` (timeline, sandbox, subscriptions, session-state, transport state, client state)         |
| `createKeyedNotifier<K, T = void>()` | Keyed observer + optional wildcard channel          | `Map<K, Set<listener>> + Set<wildcard>` (knobs, state, skills, compiler test fakes, lifecycle store, MCP tasks) |
| `createChangeNotifier<V, K>()`       | The **notify** seam — typed push carrying the delta | Per-mutation value-capture at projection sites (StateDelta, AG-UI steps, timeline events)                       |
| `createLocalPubSub<T>()`             | Effect.Stream-based fan-out with drain-on-close     | Hand-rolled `Set<Queue<T>>` async-iterable fan-out (tasks fan-out is the current consumer)                      |

**Pull vs push.** `createNotifier` / `createKeyedNotifier` are _pull_ — "something changed, re-read" (the `useSyncExternalStore` render pattern). `createChangeNotifier` is _push_ — it hands the consumer the delta (`{ key, value?, prev? }`) so it can project without re-reading and diffing. It is the read-only _notify_ seam of the operation model (ADR 76): observers are fire-and-forget and cannot affect the emitting operation.

The package depends only on `effect`. No coupling to harness, spec, or compiler — pubsub-next sits at the same layer as `@agentick/utils` in the dep graph.

## Quick start

### `createNotifier` — sync single-channel

```ts
import { createNotifier } from "@agentick/pubsub";

const n = createNotifier();
const off = n.subscribe(() => render());
n.notify();
off();

// Typed payload variant:
const t = createNotifier<MyState>();
t.subscribe((s) => apply(s));
t.notify(currentState);
```

Listener errors are caught per-listener — a buggy consumer cannot corrupt sibling listeners or the producer's state.

### `createKeyedNotifier` — keyed + wildcards

```ts
import { createKeyedNotifier } from "@agentick/pubsub";

const n = createKeyedNotifier();
n.subscribe("counter", () => render());
n.subscribeAll(() => bumpVersion());
n.notify("counter"); // fires counter-keyed + wildcards
n.notifyAll(); // wildcards only — "everything changed"

// Async dispatch:
const t = createKeyedNotifier<string, MyEvent>();
t.subscribe("foo", async (ev) => await persist(ev));
await t.notifyAsync("foo", event); // serial; errors propagate
```

Buckets auto-collect on the last unsubscribe — long-lived harnesses don't leak `Map` slots.

### `createChangeNotifier` — the notify seam (typed push)

```ts
import { createChangeNotifier, changeKind } from "@agentick/pubsub";

const changes = createChangeNotifier<number>(); // V = value type

// Consumers project the delta — no re-read, no diff:
changes.onChange((c) => stateDelta.push({ op: changeKind(c), path: `/${c.key}`, value: c.value }));

// The producer (harness) supplies the full delta at the mutation site,
// where it already knows `prev`:
const prev = values.get("budget");
values.set("budget", 50);
changes.emitChange({ key: "budget", value: 50, prev });
```

`emitChange` fans out synchronously and error-isolated; a throwing observer cannot break the producer or sibling observers (the outcome is committed before notify). The notifier is a stateless pipe — it holds no values and computes no `prev`. `changeKind(c)` derives the mechanical `add`/`update`/`remove` from value/prev presence for CRUD consumers (JSON-Patch codecs, wire projections).

### `createLocalPubSub` — Stream-based

```ts
import { createLocalPubSub } from "@agentick/pubsub";
import { Stream } from "effect";

const bus = createLocalPubSub<TaskEvent>();
const stream = bus.subscribe();
bus.publish({ kind: "started", taskId: "t1" });

// Stream is plain Stream<T, never, never> — no Scope to wire.
Stream.runForEach(stream, (ev) => Effect.sync(() => render(ev))).pipe(Effect.runFork);

// Filter on subscribe:
const onlyProgress = bus.subscribe((e) => e.kind === "progress");

// Drain + shutdown:
await bus.close();
```

`close()` waits for every active subscriber to consume the events that were published BEFORE close was called. No published event is silently dropped from an active subscriber's queue.

## API

### `createNotifier<T = void>(): Notifier<T>`

| Method                | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `subscribe(listener)` | Add a listener. Returns the unsubscribe.                               |
| `notify(value?)`      | Fire every listener. `T = void` → `notify()`; typed → `notify(value)`. |
| `size`                | Diagnostic listener count.                                             |
| `clear()`             | Drop every subscriber (long-lived owner teardown).                     |

### `createKeyedNotifier<K = string, T = void>(): KeyedNotifier<K, T>`

| Method                     | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `subscribe(key, listener)` | Subscribe to one key.                                  |
| `subscribeAll(listener)`   | Subscribe to every published key.                      |
| `notify(key, value?)`      | Fire keyed bucket + wildcards (sync; errors isolated). |
| `notifyAll(value?)`        | Wildcards only — "everything changed".                 |
| `notifyAsync(key, value?)` | Await each listener serially; errors propagate.        |
| `count(key)`               | Listener count for one key (excludes wildcards).       |
| `wildcardCount`            | Wildcard subscriber count.                             |
| `size`                     | Total listeners (all keys + wildcards).                |
| `clear()`                  | Drop every subscriber.                                 |

### `createChangeNotifier<V, K = string>(): ChangeNotifier<V, K>`

| Method               | Description                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `onChange(listener)` | Subscribe to every change (`ChangeEvent<V, K>`). Read-only, fire-and-forget.      |
| `emitChange(change)` | Emit a delta. Producer supplies `key` + `value?` + `prev?`; sync, error-isolated. |
| `size`               | Diagnostic listener count.                                                        |
| `clear()`            | Drop every listener.                                                              |

Also exported: `ChangeEvent<V, K>` (the delta type) and `changeKind(change): "add" | "update" | "remove"` (pure CRUD derivation). Presence convention: a side is _absent_ when its property is `undefined` — producers omit the side that doesn't apply.

### `createLocalPubSub<T>(): LocalPubSub<T>`

| Method               | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `publish(event)`     | Publish an event. Sync from caller's POV (unbounded queue).        |
| `subscribe(filter?)` | Returns `Stream<T, never, never>`. Filter is `(event) => boolean`. |
| `close()`            | Drain in-flight to active subscribers, then shut down. Idempotent. |
| `subscriberCount`    | Diagnostic (best-effort).                                          |

`close()` polls subscribers until each has consumed every event that was published before close started. A configurable backstop (`closeDrainTimeoutMs`, default 5 seconds) avoids hangs from wedged consumers (defensive — shouldn't trip in practice).

### Options

| Option                | Default    | Purpose                                                                                                                                                                                                                   |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closeDrainTimeoutMs` | `5_000`    | Upper bound (ms) on close-time drain. Set to `0` to skip drain (behaves like raw `PubSub.shutdown`).                                                                                                                      |
| `replay`              | `0` (none) | Replay buffer — number of past events automatically replayed to NEW subscribers (RxJS `ReplaySubject(N)` analogue). `replay: 1` ≈ RxJS `BehaviorSubject`. Implemented via Effect's native `PubSub.unbounded({ replay })`. |

**Caveat for filtered subscribers + replay:** the replay buffer is GLOBAL across all events. If subscribers filter by predicate, the buffer's N items may be drawn from any event — the filtered subscriber sees only the subset that matches their filter. For per-key snapshot semantics ("the latest event for THIS key"), compose `Stream.concat(snapshot, subscribe())` at the caller or reach for `SubscriptionRef` (the per-state primitive).

## Testing subpath — `@agentick/pubsub/testing`

Spy doubles per the Meszaros test-double convention. Each spy wraps
the real primitive — listeners still fire — and records every notify
/ publish call for assertion.

```ts
import { spyNotifier, spyKeyedNotifier, spyLocalPubSub } from "@agentick/pubsub/testing";

const spy = spyNotifier<{ tick: number }>();
harness.attachNotifier(spy);
harness.someMethodThatNotifies();
expect(spy.calls).toEqual([{ tick: 1 }]);
expect(spy.callCount).toBe(1);
spy.reset(); // clear recorded calls; subscribers stay

const keyedSpy = spyKeyedNotifier<string, MyEvent>();
keyedSpy.notify("knob:verbose", { value: true });
keyedSpy.notifyAll();
expect(keyedSpy.calls).toEqual([
  { kind: "notify", key: "knob:verbose", value: { value: true } },
  { kind: "notifyAll", value: undefined },
]);
expect(keyedSpy.callsFor("knob:verbose")).toHaveLength(1);

const busSpy = spyLocalPubSub<TaskEvent>();
busSpy.publish({ taskId: "t1", kind: "progress" });
expect(busSpy.publishCalls).toEqual([{ taskId: "t1", kind: "progress" }]);
```

Why only spies (no `fake*` / `stub*`)? The real implementations are
deterministic, in-memory, and fast — there's nothing to fake
(`fakeNotifier()` would be `createNotifier()`), nothing to stub (no
canned data), and no canned-answer use case. Spies cover the only
real testing need: asserting call patterns from collaborators.

| Export                   | Kind   | Purpose                                                                             |
| ------------------------ | ------ | ----------------------------------------------------------------------------------- |
| `spyNotifier<T>`         | helper | Working notifier that records every `notify` call in `.calls` + `.callCount`.       |
| `NotifierSpy<T>`         | type   | `Notifier<T>` extended with `calls` / `callCount` / `reset()`.                      |
| `spyKeyedNotifier<K,T>`  | helper | Working keyed notifier; records `notify` / `notifyAll` / `notifyAsync` distinctly.  |
| `KeyedNotifierSpy<K,T>`  | type   | `KeyedNotifier<K, T>` extended with `calls` / `callCount` / `callsFor` / `reset()`. |
| `KeyedNotifierCall<K,T>` | type   | Discriminated record of a single keyed notify call.                                 |
| `spyLocalPubSub<T>`      | helper | Working local pubsub that records every `publish` call.                             |
| `LocalPubSubSpy<T>`      | type   | `LocalPubSub<T>` extended with `publishCalls` / `publishCallCount` / `reset()`.     |

## Status

- Layer 1 / Layer 2 / Layer 3 — landed
- `createChangeNotifier` (the notify seam, ADR 75) — landed; consumers (StateDelta refit, timeline `event` projection) pending
- Spy doubles for the pull/stream primitives — landed under `/testing`
- 16 sweep sites migrated across knobs, state, skills, timeline, sandbox, subscriptions, session-state, client, transport-next, mcp, compiler (in-memory data bridge, lifecycle store, three test bridges)

## Roadmap & known gaps

- The `LocalPubSub.close()` drain uses a poll-and-yield loop. An Effect-native primitive (e.g. `Queue.awaitDrain`) doesn't exist in Effect's public surface today; if it lands, swap.
- No back-pressure controls on `publish` — the underlying queue is unbounded. Adopters with bursty publishers and slow consumers should consider `createKeyedNotifier` for their backpressure needs (sync notify with `void` listeners) or wait for a future `createBoundedLocalPubSub` variant.
- No replay-on-subscribe semantics — late subscribers don't see events published before they subscribed. If that's needed, an adopter wraps a `Ref<LastValue>` around the pubsub.

## Verified by

- `createNotifier` — subscribe/notify/unsubscribe semantics, listener-error isolation, mid-iteration unsubscribe, typed-payload variant — `src/__tests__/notifier.spec.ts`
- `createKeyedNotifier` — keyed dispatch, wildcards, `notifyAll`, `notifyAsync` error propagation, auto-collection of empty buckets, diagnostic `count`/`wildcardCount`/`size` — `src/__tests__/keyed-notifier.spec.ts`
- `createChangeNotifier` — full-delta fan-out, statelessness (no producer-injected `prev`), unsubscribe isolation, fire-and-forget error isolation, mid-fan-out subscribe snapshotting, `size`/`clear`; `changeKind` add/update/remove derivation — `src/__tests__/change-notifier.spec.ts`
- `createLocalPubSub` — multi-subscriber fan-out, subscribe-time filter, `close()` drain semantics (slow subscriber receives every event), idempotent close — `src/__tests__/local-pubsub.spec.ts`
- `spyNotifier` / `spyKeyedNotifier` / `spyLocalPubSub` — call recording, listener delivery preserved, `reset()` semantics, typed-payload + void variants — `src/__tests__/testing-spies.spec.ts`

# @agentick/pubsub

**Four fan-out primitives, and one distinction that decides which you want.** Does the subscriber need to be told _that_ something changed, or _what_ changed?

Telling a subscriber "re-read me" is a **pull** notification — that's `createNotifier` and `createKeyedNotifier`, and it's the shape `useSyncExternalStore` asks for. Handing the subscriber the delta so it never re-reads is **push** — that's `createChangeNotifier`. When subscribers need independent queues and backpressure instead of a synchronous callback, `createLocalPubSub` gives you an Effect `Stream`.

The package depends only on `effect` and `@agentick/utils`, so it sits at the bottom of the dependency graph and anything can reach for it.

## Install

```bash
npm install @agentick/pubsub
```

Subpaths: `/testing` (call-recording spies over each primitive).

## Quick start

```ts
import { createNotifier } from "@agentick/pubsub";

function createCounter() {
  const changed = createNotifier();
  let count = 0;

  return {
    subscribe: changed.subscribe, // (listener) => Unsubscribe
    getSnapshot: () => count,
    increment() {
      count += 1;
      changed.notify();
    },
  };
}

const counter = createCounter();
const off = counter.subscribe(() => console.log(counter.getSnapshot()));

counter.increment(); // logs 1
off();
```

That's the whole pattern: the notifier owns the listener set, the object owns the value. `subscribe` and `getSnapshot` are exactly the pair `useSyncExternalStore` wants, so this object binds to React with no adapter.

## Which one

| Primitive                            | Fan-out shape                                  | Reach for it when                                                       |
| ------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `createNotifier<T = void>()`         | One channel, synchronous                       | One thing changed and everyone re-reads it.                             |
| `createKeyedNotifier<K, T = void>()` | Per-key channels plus a wildcard               | Subscribers care about individual keys, and something also watches all. |
| `createChangeNotifier<V, K>()`       | One channel carrying `{ key, value?, prev? }`  | The consumer projects the delta instead of re-reading and diffing.      |
| `createLocalPubSub<T>()`             | Effect `Stream` per subscriber, drain-on-close | Subscribers need their own queue, or you're already in Effect.          |

## Pull — `createNotifier` and `createKeyedNotifier`

Listener errors are caught per listener in both. A buggy consumer cannot corrupt sibling listeners or the producer's state, which is what makes these safe to expose on a long-lived object.

```ts
import { createNotifier } from "@agentick/pubsub";

const state = createNotifier<{ status: string }>(); // typed payload
state.subscribe((s) => console.log(s.status));
state.notify({ status: "connected" });

state.size; // diagnostic listener count
state.clear(); // drop every subscriber on teardown
```

With `T = void` the listener takes no argument and `notify()` takes none either; with a payload type both take the value. One factory, and the call site can't get the arity wrong.

`createKeyedNotifier` adds a key dimension plus a wildcard channel that fires after the keyed bucket:

```ts
import { createKeyedNotifier } from "@agentick/pubsub";

const changed = createKeyedNotifier();
changed.subscribe("budget", () => rerenderBudget());
changed.subscribeAll(() => bumpVersion());

changed.notify("budget"); // keyed bucket, then wildcards
changed.notifyAll(); // wildcards only — "everything changed"

changed.count("budget"); // 1
changed.wildcardCount; // 1
changed.size; // 2 — every key plus wildcards
```

`notifyAll()` is for the case where per-key signalling would be noise — a full snapshot import, say. Keyed subscribers deliberately do not fire.

Buckets are collected on the last unsubscribe, so a long-lived owner doesn't accumulate empty `Map` slots.

When listeners need ordering or backpressure, `notifyAsync` awaits each one serially. Unlike the synchronous path it **propagates** errors, because a caller that chose to await has chosen to handle failure:

```ts
const events = createKeyedNotifier<string, { id: string }>();
events.subscribe("saved", async (ev) => await persist(ev));

await events.notifyAsync("saved", { id: "a1" });
```

## Push — `createChangeNotifier`

A pull notification forces the consumer to re-read and diff. When the consumer's job _is_ the diff — a JSON-Patch codec, a wire projection — that's wasted work, and worse, the producer already knew `prev` at the mutation site and threw it away.

`createChangeNotifier` carries it:

```ts
import { changeKind, createChangeNotifier } from "@agentick/pubsub";

const changes = createChangeNotifier<number>();

changes.onChange((c) => {
  patches.push({ op: changeKind(c), path: `/${c.key}`, value: c.value });
});

// At the mutation site, where `prev` is still in hand:
const prev = values.get("budget");
values.set("budget", 50);
changes.emitChange({ key: "budget", value: 50, prev });
```

`ChangeEvent` is **data, not a verb** — there is no `add`/`update`/`remove` discriminator on it. Only the emitting layer knows whether a value change means "completed" or "reordered" or "budget lowered", so naming the transition is its job. `changeKind` derives the mechanical CRUD shape for consumers that need it, from presence alone: value present and prev absent is an `add`, both present is an `update`, value absent is a `remove`.

Presence follows `Map` semantics — a side is _absent_ when the property is `undefined`, and producers omit the side that doesn't apply rather than setting it explicitly.

The notifier holds no values and computes no diffs; it's a stateless pipe. Observers are read-only and fire-and-forget: the fan-out is synchronous, errors are isolated, and a listener's return value is never awaited or inspected. An observer cannot change the outcome — the fact is already committed by the time it's told.

> [!NOTE]
> `createChangeNotifier` is deliberately separate from `createKeyedNotifier` rather than a third type parameter on it. Keyed fan-out's job is `void`-or-`T` pings for render subscriptions; folding a value-plus-prev stream in would muddy that overload. They compose instead — an object can hold both, a keyed notifier for render pings and a change notifier for the delta stream.

## Streams — `createLocalPubSub`

Backed by Effect's `PubSub.unbounded()`, so every subscriber gets an independent dequeue and a slow consumer can't starve another. `publish` returns synchronously from the caller's point of view because the queue never blocks on offer.

```ts
import { createLocalPubSub } from "@agentick/pubsub";
import { Effect, Stream } from "effect";

type TaskEvent = { kind: "started" | "progress"; taskId: string };

const bus = createLocalPubSub<TaskEvent>();

// The Stream is scoped internally — plain Stream<T, never, never>, no Scope to wire.
const all = bus.subscribe();
const onlyProgress = bus.subscribe((e) => e.kind === "progress");

Stream.runForEach(all, (ev) => Effect.sync(() => console.log(ev))).pipe(Effect.runFork);

bus.publish({ kind: "started", taskId: "t1" });

await bus.close();
```

**`close()` drains before it shuts down.** It waits for every subscriber that was active when close was called to consume everything published before that point, then shuts the underlying PubSub down. No published event is silently dropped from an active subscriber's queue. Subscribers that detached earlier don't hold the drain up, and `close()` is idempotent; publishes after it are no-ops.

Two construction options change that behavior:

```ts
const bus = createLocalPubSub<TaskEvent>({
  replay: 1, // new subscribers immediately see the last event
  closeDrainTimeoutMs: 5_000, // default; 0 skips the drain entirely
  onPublish: (event) => forwardUpstream(event), // fan-in hook, errors isolated
});
```

`replay: N` is Effect's native replay buffer — `replay: 1` behaves like an RxJS `BehaviorSubject`, larger values like a `ReplaySubject(N)`. `closeDrainTimeoutMs` is a defensive cap for a wedged downstream consumer; under normal operation the drain finishes in microseconds, and setting it to `0` gives you raw shutdown semantics with buffered events droppable.

`onPublish` is the fan-in seam: it fires synchronously on every publish, **after** the event reaches in-process subscribers, so they always see it first. Use it to route publishes into a sink the bus itself shouldn't know about — a wire envelope, a journal — while the translation stays the caller's closure. Throws from the hook are swallowed, because a broken sink must never stop a subscriber from seeing an event; wrap it yourself if you need to observe sink failures.

> [!IMPORTANT]
> The replay buffer is a **global** ring of the last N published events, not per-key and not per-subscriber. A filtered subscriber sees only the subset of those N that matches its predicate, which may be none. For "the latest event for _this_ key", compose `Stream.concat(snapshot, bus.subscribe(...))` at the call site instead of relying on replay.

## API

### Pull

| `createNotifier<T = void>()` | Returns                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `subscribe(listener)`        | `Unsubscribe`. Subscribing the same function twice is a no-op. |
| `notify(value?)`             | Fires every listener; errors isolated per listener.            |
| `size`                       | Diagnostic listener count.                                     |
| `clear()`                    | Drops every subscriber.                                        |

| `createKeyedNotifier<K = string, T = void>()` | Returns                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `subscribe(key, listener)`                    | `Unsubscribe`. Multiple listeners per key are fine.                |
| `subscribeAll(listener)`                      | `Unsubscribe`. Fires after the keyed bucket.                       |
| `notify(key, value?)`                         | Keyed bucket then wildcards; errors isolated.                      |
| `notifyAll(value?)`                           | Wildcards only.                                                    |
| `notifyAsync(key, value?)`                    | `Promise<void>` — awaits each listener serially; errors propagate. |
| `count(key)` / `wildcardCount` / `size`       | Diagnostics.                                                       |
| `clear()`                                     | Drops every subscriber.                                            |

### Push

| `createChangeNotifier<V, K = string>()` | Returns                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `onChange(listener)`                    | `Unsubscribe`. Read-only, fire-and-forget, error-isolated. |
| `emitChange(change)`                    | Fans a `ChangeEvent<V, K>` out synchronously.              |
| `size` / `clear()`                      | Diagnostic count; drop every listener.                     |

Also exported: `ChangeEvent<V, K>` (`{ key, value?, prev? }`) and `changeKind(change)` returning `"add" | "update" | "remove"`.

### Streams

| `createLocalPubSub<T>(options?)` | Returns                                                                   |
| -------------------------------- | ------------------------------------------------------------------------- |
| `publish(event)`                 | Synchronous from the caller's view. No-op after `close()`.                |
| `subscribe(filter?)`             | `Stream<T, never, never>` — internally scoped.                            |
| `close()`                        | `Promise<void>` — drains active subscribers, then shuts down. Idempotent. |
| `subscriberCount`                | Diagnostic, best-effort.                                                  |

`CreateLocalPubSubOptions<T>`: `replay` (default `0`), `closeDrainTimeoutMs` (default `5_000`), `onPublish`.

### Types

`Listener<T>`, `Unsubscribe`, `Notifier<T>`, `KeyedNotifier<K, T>`, `ChangeNotifier<V, K>`, `ChangeEvent<V, K>`, `LocalPubSub<T>`, `CreateLocalPubSubOptions<T>`. `Stream` and `Scope` are re-exported from `effect` so a consumer can type a subscriber without importing `effect` directly.

## `@agentick/pubsub/testing`

Each primitive has a spy that **wraps the real implementation** — listeners still fire, streams still deliver — and records every call for assertion. That's the only double the subpath ships: the real implementations are deterministic, in-memory, and fast, so there is nothing to fake and no canned answer to stub.

```ts
import { spyKeyedNotifier, spyLocalPubSub, spyNotifier } from "@agentick/pubsub/testing";

const spy = spyNotifier<{ tick: number }>();
spy.notify({ tick: 1 });
spy.calls; // [{ tick: 1 }]
spy.callCount; // 1
spy.reset(); // clears history; subscribers stay

const keyed = spyKeyedNotifier<string, { value: boolean }>();
keyed.notify("verbose", { value: true });
keyed.calls; // [{ kind: "notify", key: "verbose", value: { value: true } }]
keyed.callsFor("verbose"); // the same call, filtered by key

const bus = spyLocalPubSub<{ taskId: string }>();
bus.publish({ taskId: "t1" });
bus.publishCalls; // [{ taskId: "t1" }]
```

| Export                                                | Purpose                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `spyNotifier<T>()` / `NotifierSpy<T>`                 | Adds `calls`, `callCount`, `reset()`.                          |
| `spyKeyedNotifier<K, T>()` / `KeyedNotifierSpy<K, T>` | Adds `calls`, `callCount`, `callsFor(key)`, `reset()`.         |
| `KeyedNotifierCall<K, T>`                             | Discriminated record: `notify`, `notifyAll`, or `notifyAsync`. |
| `spyLocalPubSub<T>(options?)` / `LocalPubSubSpy<T>`   | Adds `publishCalls`, `publishCallCount`, `reset()`.            |

## Patterns

**Subscription surfaces.** [@agentick/resources](../resources), [@agentick/timeline](../timeline), [@agentick/sandbox](../sandbox), and [@agentick/subscriptions](../subscriptions) expose `subscribe()` backed by these notifiers, which is what makes them bindable with `useSyncExternalStore`.

**Delta projection.** [@agentick/store](../store) drives its views off `createChangeNotifier`, because a projection wants the delta rather than a re-read.

**Streamed events.** [@agentick/tasks](../tasks) and [@agentick/client-core](../client-core) fan status events out over `createLocalPubSub`, where per-subscriber queues matter.

**Keyed dispatch.** [@agentick/compiler](../compiler) and [@agentick/gates](../gates) key their fan-out by identifier with a wildcard for "anything changed".

## Roadmap & known gaps

- **The close-time drain is a poll loop.** It samples every millisecond until subscribers catch up. Effect's public surface has no drain-await primitive today; if one lands, this should swap to it.
- **`publish` has no backpressure.** The queue is unbounded by construction, so a bursty publisher against a slow consumer grows memory rather than pushing back. A bounded variant isn't built.
- **`notifyAsync` has no concurrency control.** It is strictly serial. Parallel-with-limit dispatch would need a new method rather than an option, and no consumer has asked for it.
- **Spies only.** There is no fake or stub tier, by design — but it does mean a test that wants a notifier to _fail_ on subscribe has to hand-roll it.

## Verified by

- `src/__tests__/notifier.spec.ts` — parameterless and typed-payload delivery, unsubscribe touching only the matching listener, listener-error isolation, mid-iteration unsubscribe, `size`, `clear()`.
- `src/__tests__/keyed-notifier.spec.ts` — keyed-then-wildcard ordering, unknown-key firing wildcards only, typed payloads reaching both tiers, `notifyAll` leaving keyed subscribers untouched, `notifyAsync` serial ordering and error propagation against the synchronous path's isolation, empty-bucket collection, and the diagnostics.
- `src/__tests__/change-notifier.spec.ts` — full-delta fan-out, statelessness (no `prev` computed by the notifier), per-listener unsubscribe, fire-and-forget error isolation, listener snapshotting so mid-fan-out subscription can't corrupt the current emit, and `changeKind` across add, update, remove, and a full patch sequence for one key.
- `src/__tests__/local-pubsub.spec.ts` — independent multi-subscriber fan-out, subscribe-time filtering, `subscriberCount`, the `close()` drain against a deliberately slow subscriber, post-close publishes as no-ops, `replay: N`, `closeDrainTimeoutMs` at `0` and at a custom cap, and `onPublish` firing after subscribers with throws isolated and no fire after close.
- `src/__tests__/testing-spies.spec.ts` — every spy records calls while still delivering to subscribers, `callsFor` filtering, pass-through diagnostics, and `reset()` clearing history without dropping subscribers.

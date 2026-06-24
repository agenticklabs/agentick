# @agentick/utils-next

Framework-agnostic bedrock utilities for Agentick v2.

`@agentick/utils-next` is the **lowest** layer of the v2 dependency graph:
pure functions over plain JavaScript values, no reconciler, no harness,
no protocol coupling. Anything in this package can be lifted into any
runtime — Node, Deno, the browser, the edge — without dragging a single
agentick concept along.

Three things live here today:

- **Type predicates and structural equality** —
  `isString` / `isNumber` / `isBoolean` / `isNull` / `isUndefined` /
  `isDefined` / `isFunction` / `isArray` / `isDate` / `isRegExp` /
  `isMap` / `isSet` / `isObject` / `isPlainObject` / `isEqual`.
  Replaces the five-different-ways-to-write-this-check problem at call
  sites with one canonical name per concept.
- **`mergeLayered`** — the Pattern A cascade primitive from
  [ADR 34](../../docs/proposals/v2/blueprint/34-scoped-capability-cascade.md).
  Deep-merges a sequence of partial-config layers (gateway → app →
  session → per-call) into a typed merged config with cascade
  semantics. Ships with four symbol-wrapped field strategies:
  `append`, `prepend`, `replace`, `omit`.
- **Local pub/sub primitives** — three layered observer abstractions
  (`Notifier<T>`, `KeyedNotifier<K, T>`, `LocalPubSub<T>`) that replace
  the hand-rolled `Set<() => void>` fan-out at every harness, bridge,
  transport, and reconciler test double. Layer 1 + 2 are sync `Set`-of-
  callbacks with listener-error isolation; Layer 3 is built on Effect's
  `PubSub.unbounded()` and returns a fully-scoped `Stream.Stream`.

## Status

🚧 In active development as part of v2 (`feat/v2`).

The package is intentionally narrow. We add a utility here only when
two or more v2 packages already need it AND it has zero coupling to
agentick concepts. New domain-flavored helpers (timeline scans, content
extractors, registry queries) belong in their owning harness package,
not here.

## Quick start

```ts
import {
  isPlainObject,
  isEqual,
  mergeLayered,
  append,
  createNotifier,
  createKeyedNotifier,
  createLocalPubSub,
} from "@agentick/utils-next";

isPlainObject({ a: 1 }); // true
isPlainObject(new Date()); // false  (class instance, not POJO)
isEqual({ a: 1 }, { a: 1 }); // true   (structural)

const config = mergeLayered<{ maxTicks: number; tools: string[] }>(
  { maxTicks: 8, tools: ["fs"] }, // framework defaults
  { tools: append(["shell"]) }, // app layer extends
  { maxTicks: 12 }, // session override
);
// → { maxTicks: 12, tools: ["fs", "shell"] }

// Single-channel observer (replaces `Set<() => void>` + manual fan-out).
const n = createNotifier();
const off = n.subscribe(() => console.log("changed"));
n.notify();
off();

// Typed payload variant — transport state, etc.
const stateBus = createNotifier<"idle" | "ready">();
stateBus.subscribe((s) => console.log("state →", s));
stateBus.notify("ready");

// Keyed observer with wildcards — knobs / state / skills harnesses.
const keyed = createKeyedNotifier();
keyed.subscribe("counter", () => render());
keyed.subscribeAll(() => bumpVersion());
keyed.notify("counter");
keyed.notifyAll(); // wildcard-only signal ("everything changed")

// Stream-based fan-out — MCP task notifications, future #162 tasks bus.
const bus = createLocalPubSub<TaskEvent>();
bus.publish({ kind: "started", taskId: "t1" });
const stream = bus.subscribe((e) => e.taskId === "t1");
```

See [`merge-layered.ts`](./src/merge-layered.ts) for the cascade
semantics and strategy docs, and
[ADR 34](../../docs/proposals/v2/blueprint/34-scoped-capability-cascade.md)
for the architectural justification (Pattern A vs Pattern A′ vs
Pattern B).

## API

| Export             | Kind      | Purpose                                                   |
| ------------------ | --------- | --------------------------------------------------------- |
| `isString`         | predicate | `typeof v === "string"`                                   |
| `isNumber`         | predicate | `typeof v === "number"`                                   |
| `isBoolean`        | predicate | `typeof v === "boolean"`                                  |
| `isNull`           | predicate | `v === null`                                              |
| `isUndefined`      | predicate | `v === undefined`                                         |
| `isDefined<T>`     | predicate | not `null` and not `undefined`                            |
| `isFunction`       | predicate | `typeof v === "function"`                                 |
| `isArray`          | predicate | `Array.isArray(v)`                                        |
| `isDate`           | predicate | `v instanceof Date`                                       |
| `isRegExp`         | predicate | `v instanceof RegExp`                                     |
| `isMap`            | predicate | `v instanceof Map`                                        |
| `isSet`            | predicate | `v instanceof Set`                                        |
| `isObject`         | predicate | "everyday" object check (NOT array, NOT null)             |
| `isPlainObject`    | predicate | POJO only (prototype is `Object.prototype` or `null`)     |
| `isEqual(a, b)`    | function  | deep structural equality (JSON-shape + `Date` + `RegExp`) |
| `mergeLayered<T>`  | function  | variadic cascade deep-merge, left → right                 |
| `foldLayer<T>`     | function  | single-layer fold (advanced composition)                  |
| `append<T>(arr)`   | strategy  | array append to parent slot                               |
| `prepend<T>(arr)`  | strategy  | array prepend                                             |
| `replace<T>(v)`    | strategy  | replace parent slot verbatim (opt out of deep merge)      |
| `omit()`           | strategy  | delete the slot from the merged result                    |
| `isMergeStrategy`  | guard     | true if a value carries a strategy marker                 |
| `Layer<T>`         | type      | one partial-config layer in a cascade                     |
| `MergeStrategy<T>` | type      | symbol-wrapped field strategy                             |
| `createNotifier<T>`         | factory   | Layer 1 — single-channel observer; `T = void` ⇒ parameterless `notify()` |
| `Notifier<T>`               | interface | `subscribe / notify / size / clear` (returns `Unsubscribe`)             |
| `createKeyedNotifier<K, T>` | factory   | Layer 2 — keyed observer + wildcard channel + `notifyAsync` for serial dispatch |
| `KeyedNotifier<K, T>`       | interface | `subscribe(key) / subscribeAll / notify / notifyAll / notifyAsync / count / clear` |
| `createLocalPubSub<T>`      | factory   | Layer 3 — Effect.PubSub-backed Stream fan-out with `Scope` wrapped internally |
| `LocalPubSub<T>`            | interface | `publish / subscribe(filter?) / close / subscriberCount`                      |
| `Listener<T>`               | type      | computed listener signature; void → `() => void`, else `(v: T) => void`   |
| `Unsubscribe`               | type      | `() => void` — cancellation token returned by every subscribe             |

## Testing subpath — `@agentick/utils-next/testing`

Test-only helpers. Importable from any package's `__tests__/` without
polluting the production import graph.

| Export                 | Kind   | Purpose                                                                                                                |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `drainRejection<T>(p)` | helper | Eagerly attach a no-op catch handler so a Promise's rejection is observed, returning the value or the rejection reason |

```ts
import { drainRejection } from "@agentick/utils-next/testing";

// Replaces hand-rolled `.catch((e) => e)` / `.catch(() => undefined)`
// at test sites where a Promise will reject but the test body awaits
// something else first. Attaching at construction is what makes the
// drain "pre-": vitest never sees the rejection as unhandled.
const drained = drainRejection(handle.result);
await session.tasks.cancel(handle.taskId);
expect(await drained).toMatchObject({ status: "cancelled" });
```

**Not for production code.** Fire-and-forget sites in long-lived
harnesses / transports that intentionally swallow rejections have
different semantics — the name signals test-only intent at the call
site.

## What does NOT belong here

- Anything that imports from `@agentick/spec-next`, a harness, or a
  protocol — it's domain code, not a bedrock utility.
- Anything tied to React, JSX, the reconciler, or any runtime event
  loop.
- `Map`/`Set` deep equality (rare in our codebase, and `effect/Equal`
  handles it for callers who need it).
- Cyclic-reference safe deep merge — `mergeLayered` is config-flavored,
  cycles aren't a v2 config concern.

## Verified by

- `mergeLayered` cascade semantics — `src/__tests__/merge-layered.spec.ts`
- Predicates incl. `isPlainObject` prototype-chain check, `isEqual` for
  primitives / arrays / objects / `Date` / `RegExp` —
  `src/__tests__/predicates.spec.ts`
- `drainRejection` resolution / rejection pass-through + eager
  unhandled-rejection observability —
  `src/__tests__/drain-rejection.spec.ts`
- `Notifier` / `KeyedNotifier` / `LocalPubSub` — subscribe/notify/unsubscribe
  semantics, listener-error isolation, mid-iteration unsubscribe, async
  serial dispatch, wildcard-only `notifyAll`, filtered Stream subscribers,
  multi-subscriber fan-out, and `close()` idempotence —
  `src/__tests__/pubsub.spec.ts`

## Roadmap & known gaps

- No `effect`-flavored variants — adopters needing `Equal.symbol`
  semantics or `Schema`-aware equality reach for `effect/Equal`
  directly.
- No streaming/iterator helpers — those belong in `@agentick/runtime-next`
  alongside the event-loop primitives.
- `mergeLayered` does not currently support a custom merger callback
  per-field. Symbol-wrapped strategies cover every cascade case in v2
  today; if a new use case demands a free-form combiner, we'll add it
  with a `combine(fn)` strategy rather than a parallel API.

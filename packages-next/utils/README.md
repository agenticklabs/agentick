# @agentick/utils-next

Framework-agnostic bedrock utilities for Agentick v2.

`@agentick/utils-next` is the **lowest** layer of the v2 dependency graph:
pure functions over plain JavaScript values, no compiler, no harness,
no protocol coupling. Anything in this package can be lifted into any
runtime — Node, Deno, the browser, the edge — without dragging a single
agentick concept along.

Six things live here today:

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
- **Effect Cause helpers** — `reasonOf(unknown)` / `reasonOfCause<E>` /
  `unwrapExit<A, E>`. Consolidate seven hand-rolled "unknown error /
  Cause → reason string" sites into one canonical reducer; `unwrapExit`
  preserves typed-failure identity so downstream `_tag` discrimination
  keeps working.
- **`drainRejection<T>(p)`** (testing subpath) — eagerly attaches a
  no-op catch handler to a Promise so its rejection is observed (no
  vitest "unhandled rejection" warning) and returns a Promise that
  resolves with the rejection reason or the value. Standardizes the
  ~20 sites that needed the pre-drain pattern.
- **Loader primitives** ([`loaders/`](./src/loaders/README.md)
  subpath) — `Loader<T>` + `mergeLoaders` / `mapLoader` /
  `sourceFromArray` / `sourceFromUrl` / `sourceFromModule` /
  `extractFrontmatter`. Filesystem-backed sources live under
  `loaders/node`. Harness packages compose these into their own
  record-typed `fromX` APIs (skills loaders, prompts loaders, future
  resources loaders) — the primitive layer is deliberately _not_
  a unified `from*` surface because the sound source set depends on
  whether the record type carries unserializable code.

The in-process observer primitives (`Notifier`, `KeyedNotifier`,
`LocalPubSub`) live in
[`@agentick/pubsub-next`](../pubsub) — they belong with the
harness-internal fan-out concern, not in the bedrock-utility package.

## Status

🚧 In active development as part of v2 (`feat/v2`).

The package is intentionally narrow. We add a utility here only when
two or more v2 packages already need it AND it has zero coupling to
agentick concepts. New domain-flavored helpers (timeline scans, content
extractors, registry queries) belong in their owning harness package,
not here.

## Quick start

```ts
import { isPlainObject, isEqual, mergeLayered, append } from "@agentick/utils-next";

isPlainObject({ a: 1 }); // true
isPlainObject(new Date()); // false  (class instance, not POJO)
isEqual({ a: 1 }, { a: 1 }); // true   (structural)

const config = mergeLayered<{ maxTicks: number; tools: string[] }>(
  { maxTicks: 8, tools: ["fs"] }, // framework defaults
  { tools: append(["shell"]) }, // app layer extends
  { maxTicks: 12 }, // session override
);
// → { maxTicks: 12, tools: ["fs", "shell"] }
```

See [`merge-layered.ts`](./src/merge-layered.ts) for the cascade
semantics and strategy docs, and
[ADR 34](../../docs/proposals/v2/blueprint/34-scoped-capability-cascade.md)
for the architectural justification (Pattern A vs Pattern A′ vs
Pattern B).

## API

| Export                    | Kind      | Purpose                                                     |
| ------------------------- | --------- | ----------------------------------------------------------- |
| `isString`                | predicate | `typeof v === "string"`                                     |
| `isNumber`                | predicate | `typeof v === "number"`                                     |
| `isBoolean`               | predicate | `typeof v === "boolean"`                                    |
| `isNull`                  | predicate | `v === null`                                                |
| `isUndefined`             | predicate | `v === undefined`                                           |
| `isDefined<T>`            | predicate | not `null` and not `undefined`                              |
| `isFunction`              | predicate | `typeof v === "function"`                                   |
| `isArray`                 | predicate | `Array.isArray(v)`                                          |
| `isDate`                  | predicate | `v instanceof Date`                                         |
| `isRegExp`                | predicate | `v instanceof RegExp`                                       |
| `isMap`                   | predicate | `v instanceof Map`                                          |
| `isSet`                   | predicate | `v instanceof Set`                                          |
| `isObject`                | predicate | "everyday" object check (NOT array, NOT null)               |
| `isPlainObject`           | predicate | POJO only (prototype is `Object.prototype` or `null`)       |
| `isEqual(a, b)`           | function  | deep structural equality (JSON-shape + `Date` + `RegExp`)   |
| `mergeLayered<T>`         | function  | variadic cascade deep-merge, left → right                   |
| `foldLayer<T>`            | function  | single-layer fold (advanced composition)                    |
| `append<T>(arr)`          | strategy  | array append to parent slot                                 |
| `prepend<T>(arr)`         | strategy  | array prepend                                               |
| `replace<T>(v)`           | strategy  | replace parent slot verbatim (opt out of deep merge)        |
| `omit()`                  | strategy  | delete the slot from the merged result                      |
| `isMergeStrategy`         | guard     | true if a value carries a strategy marker                   |
| `Layer<T>`                | type      | one partial-config layer in a cascade                       |
| `MergeStrategy<T>`        | type      | symbol-wrapped field strategy                               |
| `reasonOf(cause)`         | function  | unknown value → single-line reason string                   |
| `reasonOfCause<E>(cause)` | function  | Effect.Cause → single-line reason string                    |
| `unwrapExit<A, E>(exit)`  | function  | Exit → value or throw (preserves typed failure identity)    |
| `applyJsonPatch<T>`       | function  | apply RFC 6902 ops (add/replace/remove/test), copy-on-write |
| `JsonPatchOp`             | type      | one RFC 6902 operation                                      |
| `JsonPatchError`          | class     | thrown when a patch cannot be applied                       |

**`/loaders` subpath:** see [src/loaders/README.md](./src/loaders/README.md) for the loader primitive surface.

## Loaders subpath — `@agentick/utils-next/loaders` + `/loaders/node`

See [`src/loaders/README.md`](./src/loaders/README.md) for the full
shape. Quick reference:

| Subpath         | Exports                                                                                                                | Use when                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/loaders`      | `Loader<T>`, `mergeLoaders`, `mapLoader`, `sourceFromArray`, `sourceFromUrl`, `sourceFromModule`, `extractFrontmatter` | platform-agnostic primitives; safe in browser / edge runtime |
| `/loaders/node` | `sourceFromFile`, `readFrontmatterFile`, `sourceFromDirectory`, `FileRecord`                                           | Node `fs`-backed sources; the path that needs `node:fs`      |

Harness packages (`@agentick/skills-next`, `@agentick/prompts-next`)
build their public `fromArray / fromDirectory / fromModule / ...`
APIs on these primitives — the constraint on which sources are _sound_
for a record type belongs to the harness, not to the primitive layer.

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
- Anything tied to React, JSX, the compiler, or any runtime event
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
- `reasonOf` / `reasonOfCause` / `unwrapExit` — table-driven coverage of
  string / Error / `{_tag}` / JSON / die / interrupted / composite cause
  shapes, and the typed-failure-identity preservation — `src/__tests__/cause.spec.ts`
- `applyJsonPatch` — RFC 6902 add/replace/remove/test on objects + arrays,
  `~0`/`~1` pointer escaping, whole-document target, op sequencing, `test`
  mismatch throws, and copy-on-write immutability + structural sharing of
  untouched subtrees — `src/__tests__/json-patch.spec.ts` (18 tests)

The in-process observer primitives (`Notifier` / `KeyedNotifier` /
`LocalPubSub`) moved to
[`@agentick/pubsub-next`](../pubsub) — see that package's "Verified by"
section for its test coverage.

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

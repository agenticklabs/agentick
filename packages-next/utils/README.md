# @agentick/utils-next

Framework-agnostic bedrock utilities for Agentick v2.

`@agentick/utils-next` is the **lowest** layer of the v2 dependency graph:
pure functions over plain JavaScript values, no reconciler, no harness,
no protocol coupling. Anything in this package can be lifted into any
runtime — Node, Deno, the browser, the edge — without dragging a single
agentick concept along.

Two things live here today:

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

isPlainObject({ a: 1 });          // true
isPlainObject(new Date());        // false  (class instance, not POJO)
isEqual({ a: 1 }, { a: 1 });      // true   (structural)

const config = mergeLayered<{ maxTicks: number; tools: string[] }>(
  { maxTicks: 8, tools: ["fs"] },        // framework defaults
  { tools: append(["shell"]) },          // app layer extends
  { maxTicks: 12 },                      // session override
);
// → { maxTicks: 12, tools: ["fs", "shell"] }
```

See [`merge-layered.ts`](./src/merge-layered.ts) for the cascade
semantics and strategy docs, and
[ADR 34](../../docs/proposals/v2/blueprint/34-scoped-capability-cascade.md)
for the architectural justification (Pattern A vs Pattern A′ vs
Pattern B).

## API

| Export             | Kind     | Purpose                                                     |
| ------------------ | -------- | ----------------------------------------------------------- |
| `isString`         | predicate | `typeof v === "string"`                                     |
| `isNumber`         | predicate | `typeof v === "number"`                                     |
| `isBoolean`        | predicate | `typeof v === "boolean"`                                    |
| `isNull`           | predicate | `v === null`                                                |
| `isUndefined`      | predicate | `v === undefined`                                           |
| `isDefined<T>`     | predicate | not `null` and not `undefined`                              |
| `isFunction`       | predicate | `typeof v === "function"`                                   |
| `isArray`          | predicate | `Array.isArray(v)`                                          |
| `isDate`           | predicate | `v instanceof Date`                                         |
| `isRegExp`         | predicate | `v instanceof RegExp`                                       |
| `isMap`            | predicate | `v instanceof Map`                                          |
| `isSet`            | predicate | `v instanceof Set`                                          |
| `isObject`         | predicate | "everyday" object check (NOT array, NOT null)               |
| `isPlainObject`    | predicate | POJO only (prototype is `Object.prototype` or `null`)       |
| `isEqual(a, b)`    | function  | deep structural equality (JSON-shape + `Date` + `RegExp`)   |
| `mergeLayered<T>`  | function  | variadic cascade deep-merge, left → right                   |
| `foldLayer<T>`     | function  | single-layer fold (advanced composition)                    |
| `append<T>(arr)`   | strategy  | array append to parent slot                                 |
| `prepend<T>(arr)`  | strategy  | array prepend                                               |
| `replace<T>(v)`    | strategy  | replace parent slot verbatim (opt out of deep merge)        |
| `omit()`           | strategy  | delete the slot from the merged result                      |
| `isMergeStrategy`  | guard     | true if a value carries a strategy marker                   |
| `Layer<T>`         | type      | one partial-config layer in a cascade                       |
| `MergeStrategy<T>` | type      | symbol-wrapped field strategy                               |

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

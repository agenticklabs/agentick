# @agentick/utils

The bottom of the dependency graph. Pure functions over plain JavaScript values — no compiler, no harness, no protocol types, not even a dependency on `@agentick/spec`. Every export lifts into any runtime (Node, Deno, the browser, the edge) without dragging an agentick concept along.

## Check here before you write a utility

That is the package's job, and it is the rule that matters more than any single export.

> [!IMPORTANT]
> Before you type `function` for anything general-purpose, grep this package — and `@agentick/utils/testing` if it's a test helper. A hand-rolled `setTimeout` poll, a manual retry, a deep-equality walk, an optional-spread chain, a thunk discriminator: all of them already exist here under a canonical name. Inline reinvention is not a shortcut. It duplicates semantics, drifts from the version everyone else uses, and leaves the next reader guessing which one is correct.

| Hand-rolled                                                          | Already here                           |
| -------------------------------------------------------------------- | -------------------------------------- |
| `await new Promise((r) => setTimeout(r, 50))`, then assert           | `waitFor(() => cond)` (`/testing`)     |
| assert-nothing-arrived after a single yield                          | `waitForStable(snapshot)` (`/testing`) |
| a recursive deep-equal walk                                          | `isEqual(a, b)`                        |
| `...(x !== undefined ? { x } : {})` chains                           | `omitUndefined({ x })`                 |
| per-field config resolvers across gateway → app → session            | `mergeLayered(...layers)`              |
| `typeof v === "function" ? v() : v`                                  | `resolveSync(v)`                       |
| `err instanceof Error ? err.message : String(err)`                   | `reasonOf(err)`                        |
| `Date.now().toString(36) + Math.random().toString(36)`               | `generateId()`                         |
| a semaphore loop to cap in-flight work                               | `mapConcurrent(items, n, fn)`          |
| `all.slice(offset, offset + size)` + a hand-rolled cursor string     | `paginate(all, cursor, pageSize?)`     |
| an `AbortController` wired to listen to two other signals            | `mergeAbortSignals(a, b)`              |
| `v instanceof Promise`                                               | `isThenable(v)`                        |
| `.catch(() => undefined)` to silence an expected rejection in a test | `drainRejection(p)` (`/testing`)       |

The before/after that made `omitUndefined` exist — the same shape shows up at every `exactOptionalPropertyTypes` boundary:

```ts
import { omitUndefined } from "@agentick/utils";

interface Target {
  readonly host: string;
  readonly port?: number;
  readonly proxy?: string;
}
declare const input: { host: string; port?: number; proxy?: string };

// Before — three spreads per optional field, and it grows with the type.
const before: Target = {
  host: input.host,
  ...(input.port !== undefined ? { port: input.port } : {}),
  ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
};

// After. Required fields stay outside the call — the result type marks every
// key it produces optional, which is exactly what makes it fit the target.
const after: Target = {
  host: input.host,
  ...omitUndefined({ port: input.port, proxy: input.proxy }),
};
```

`undefined` values drop; `null`, `0`, `""`, and `false` are preserved. It is shallow on purpose — the question it answers is "is this key present at the boundary", not "scrub `undefined` recursively", and a nested `{ x: undefined }` may be a sentinel the consumer cares about.

## Install

```bash
npm install @agentick/utils
```

Subpaths: `/testing` (test-only helpers), `/loaders` (platform-agnostic record loaders), `/loaders/node` (filesystem sources), `/path/node` (symlink-safe path confinement). The `/node` subpaths are separate so the main entry stays usable in a browser or edge runtime.

## Quick start

```ts
import { append, isEqual, isPlainObject, mergeLayered } from "@agentick/utils";

isPlainObject({ a: 1 }); // true
isPlainObject(new Date()); // false — a class instance, not a POJO
isEqual({ a: 1 }, { a: 1 }); // true — structural, key order irrelevant

interface RunConfig {
  readonly maxTicks: number;
  readonly tools: readonly string[];
}

const config = mergeLayered<RunConfig>(
  { maxTicks: 8, tools: ["read_file"] }, // framework defaults
  { tools: append(["shell"]) }, // app layer extends rather than replaces
  process.env.DEBUG ? { maxTicks: 2 } : undefined, // a conditional layer may be undefined
);
// → { maxTicks: 2, tools: ["read_file", "shell"] }
```

## Cascading configuration

`mergeLayered` folds partial-config layers left to right — least specific to most specific. It is the primitive behind every gateway → app → session → per-call cascade in the framework, and the shape a convenience wrapper reaches for when it has to combine framework defaults, env config, a project file, and a call site into one blob.

The rules, all of them:

| Input                                          | Result                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| leaf collision                                 | the later layer wins                                  |
| `undefined` value, or an omitted key           | falls through to a more general layer                 |
| `undefined` layer argument                     | skipped wholesale — conditional layers inline cleanly |
| two plain objects                              | recursive deep merge                                  |
| arrays, primitives, class instances, functions | replace — most specific wins, never merged            |

Four symbol-wrapped strategies opt a single field out of those defaults, so no per-field merger callback is ever needed:

```ts
import { append, mergeLayered, omit, prepend, replace } from "@agentick/utils";

interface Config {
  readonly extensions: readonly string[];
  readonly headers: { readonly [k: string]: string };
  readonly debug?: boolean;
}

mergeLayered<Config>(
  { extensions: ["a"], headers: { "x-trace": "on" }, debug: true },
  {
    extensions: append(["b"]), // → ["a", "b"];  prepend() puts it first
    headers: replace({ authorization: "…" }), // opt OUT of deep merge — x-trace is dropped
    debug: omit(), // delete the slot a parent layer set
  },
);
```

`foldLayer(acc, layer)` is the single-layer step, exported for composing your own fold. `isMergeStrategy(v)` recognizes a wrapped field.

## Predicates and structural equality

One canonical name per concept, so the five-different-ways-to-write-this-check problem stops at the call site. The two that carry real semantics:

```ts
import { isEqual, isObject, isPlainObject, isThenable } from "@agentick/utils";

isObject(new Date()); // true  — "do I have a key/value bag"
isPlainObject(new Date()); // false — POJO only (prototype is Object.prototype or null)

isEqual([1, { a: new Date(0) }], [1, { a: new Date(0) }]); // true
isEqual(Number.NaN, Number.NaN); // true  — Object.is semantics
isEqual(-0, 0); // false — also Object.is

isThenable({ then: () => {} }); // true — duck-typed, so cross-realm and
//         suspend-via-throw promises match where `instanceof Promise` fails
```

`isEqual` covers JSON shapes plus `Date` and `RegExp`, and it compares **any two functions as equal** — presence-equality, matching `JSON.stringify` semantics, because the callers are comparing config and data. If you need reference identity on a function-valued field, use `===` on that field. `Map`/`Set` deep equality and cyclic references are deliberately absent (see [What does not belong here](#what-does-not-belong-here)).

## Deferred values

`Resolvable<T>` is the "literal or no-arg thunk" shape that adopter-supplied config keeps wanting — read an env var, generate an id, compute a prefix — without forcing every containing factory to become async.

```ts
import { resolveSync, type Resolvable } from "@agentick/utils";

interface BrokerConfig {
  readonly nodeId: Resolvable<string>;
  readonly keyPrefix?: Resolvable<string>;
}

function buildBroker(opts: BrokerConfig) {
  const nodeId = resolveSync(opts.nodeId); // string, either way
  const prefix = opts.keyPrefix ? resolveSync(opts.keyPrefix) : "";
  return { nodeId, prefix };
}

buildBroker({ nodeId: "node-A" }); // literal
buildBroker({ nodeId: () => process.env.NODE_ID ?? "node-A" }); // thunk
```

`ResolvableAsync<T>` / `resolveAsync` exist for the genuinely I/O-bound case only — reaching for them makes every consumer `await`, which cascades.

## Concurrency and cancellation

```ts
import { mapConcurrent, mergeAbortSignals } from "@agentick/utils";

declare const paths: readonly string[];
declare function fetchOne(path: string, signal?: AbortSignal): Promise<string>;
declare const appSignal: AbortSignal | undefined;
declare const callSignal: AbortSignal | undefined;

// One signal that fires the instant EITHER source aborts, carrying the first
// abort's `reason`. Undefined inputs are ignored, so optional signals need no
// pre-filtering; a lone live signal comes back as-is with no wrapper.
const signal = mergeAbortSignals(appSignal, callSignal);

// At most 4 in flight; results stay in INPUT order regardless of completion
// order. The first rejection rejects the whole call.
const bodies = await mapConcurrent(paths, 4, (path) => fetchOne(path, signal));
```

`mapConcurrent` has no cancellation primitive of its own — thread the signal through your own `fn`, as above. `concurrency <= 0` clamps to 1; `Infinity` is `Promise.all`.

## Errors, causes, and Effect interop

Four functions that collapse "unknown thrown thing" into something a log line, a terminal event, or a `catch` block can use — with one deliberate asymmetry: the string reducers stringify, `unwrapExit` does not.

```ts
import { Cause, Exit } from "effect";
import { causeValue, reasonOf, reasonOfCause, unwrapExit } from "@agentick/utils";

reasonOf("boom"); // "boom"
reasonOf(new Error("boom")); // "boom"
reasonOf({ _tag: "WriteFailed" }); // "WriteFailed"   — the Effect tagged-error shape
reasonOf({ code: 42 }); // '{"code":42}'   — JSON, then String() as last resort

reasonOfCause(Cause.fail({ _tag: "WriteFailed" })); // "WriteFailed"
causeValue(Cause.fail({ _tag: "WriteFailed" })); // the VALUE, unstringified

// `unwrapExit` rethrows a typed failure AS-IS, so `_tag` discrimination keeps
// working across the boundary. Defects and interrupts become a plain Error
// carrying `Cause.pretty`.
try {
  unwrapExit(Exit.fail({ _tag: "WriteFailed" as const, key: "log/1" }));
} catch (err) {
  if ((err as { _tag?: string })._tag === "WriteFailed") {
    // the original object, not a string
  }
}
```

`liftToEffect` is the other direction — adopter-shaped functions into Effect-typed call sites:

```ts
import { Effect } from "effect";
import { liftToEffect } from "@agentick/utils";

class FetchFailed {
  readonly _tag = "FetchFailed";
  constructor(readonly cause: unknown) {}
}

const load = liftToEffect(
  async (id: string) => (await fetch(`/api/users/${id}`)).json() as Promise<unknown>,
  (err) => new FetchFailed(err),
);

const program = Effect.gen(function* () {
  return yield* load("42"); // Effect.Effect<unknown, FetchFailed>
});
```

The lift is idempotent — hand it a function that already returns an `Effect` and it passes through unwrapped, so it can be applied unconditionally. It is lazy: nothing runs until the Effect does. It does **not** capture context; a lifted function that needs ambient values takes them as parameters.

## JSON Patch

`applyJsonPatch` is RFC 6902 (`add` / `replace` / `remove` / `test`) with copy-on-write semantics — the input document is never mutated, and untouched subtrees are shared by reference, which is what makes it safe to hand the result straight to a `useSyncExternalStore`-style snapshot reader.

```ts
import { applyJsonPatch, type JsonPatchOp } from "@agentick/utils";

const before = { user: { name: "ada", tags: ["x"] }, other: { keep: true } };
const ops: readonly JsonPatchOp[] = [
  { op: "replace", path: "/user/name", value: "grace" },
  { op: "add", path: "/user/tags/-", value: "y" }, // "-" appends
  { op: "test", path: "/other/keep", value: true }, // throws JsonPatchError on mismatch
];

const after = applyJsonPatch(before, ops);
after.other === before.other; // true — untouched subtree, same reference
```

Ops apply in order, each seeing the previous one's result. A path of `""` targets the whole document. `~0` and `~1` escape `~` and `/` in a token.

## Scope and event filters

Structural predicates over "does this value satisfy this partial filter". Generic rather than spec-typed, which is what keeps this package a leaf: pass any `S extends object` — an event scope, a store query's scope clause, a plain record.

```ts
import { compileScopeMatcher, matchesScope } from "@agentick/utils";

interface Scope {
  readonly sessionId: string;
  readonly tenant: string;
}
declare const events: readonly { readonly scope: Scope }[];

matchesScope({ tenant: "acme" }, { sessionId: "s1", tenant: "acme" }); // true
matchesScope({}, { sessionId: "s1", tenant: "acme" }); // true — empty filter matches everything

// Same semantics, filter keys pre-extracted once. For hot paths that match one
// filter against many values (a publish loop, a store scan).
const matches = compileScopeMatcher<Scope>({ tenant: "acme" });
const mine = events.filter((e) => matches(e.scope));
```

`matchesAddressFilter` and `matchesEventFilter` are the address- and event-shaped siblings, used by broker adapters that route on `{surface}:{scopeId}` addresses and on `{ surface, name, scope }` events. Their filter shapes are declared here structurally (`AddressFilterShape`, `EventFilterShape`, `EventLike`), so a cluster adapter passes its own types straight in.

## Ids, chunking, sweeps

```ts
import { cartesian, splitMessage, generateId } from "@agentick/utils";

generateId(); // lexicographically sortable, monotonic within a millisecond

// Chat surfaces impose hard per-message caps. Prefers a semantic boundary
// (paragraph → line → sentence → word) and hard-breaks only when there is
// none before the cap. No chunk ever exceeds maxLength.
splitMessage(longAgentReply, { maxLength: 4096, continuation: " …" });

// Every combination, one record per cell — the shape an eval sweep wants.
cartesian({ model: ["gpt-5", "opus-5"], temperature: [0, 0.7] });
// → [{ model: "gpt-5", temperature: 0 }, { model: "gpt-5", temperature: 0.7 }, …]
```

`generateId()` is a Crockford-base32 encoding of `timestamp(48) + random(80)` — not the canonical ULID algorithm, deliberately, because what the framework needs is a sortable collision-resistant id that survives a JSON round-trip. Nothing may depend on the encoding.

### Replacing the generator

```ts
import { setIdGenerator } from "@agentick/utils";

setIdGenerator(uuidv7); // once, at startup, before the first id is minted
```

The contract is not "returns a unique string". It is **monotonic** — each id sorts strictly after the one before it — and **lexicographically sortable**, so plain string `<` equals generation order. The journal orders entries by id and cursored reads page by it, and neither re-checks: a generator that guarantees only uniqueness (`uuidv4`, an unpadded counter) corrupts both silently.

Check a candidate before installing it:

```ts
import { assertIdGeneratorConformance } from "@agentick/utils/testing";

it("uuidv7 is fit to install", () => {
  assertIdGeneratorConformance("uuidv7", () => uuidv7());
});
```

It imports no test framework — it throws a plain `Error` naming the claim and the offending pair, and you supply the runner. A conformance suite that hardcoded `vitest` would force every adopter onto vitest to check their own generator, and would put a test-framework import into the barrel that `waitFor` lives in.

Call `setIdGenerator` once and never again. This is a construction-time choice, not a runtime toggle — two generators in one process, or a swap against a store that already holds ids, breaks ordering across the boundary. Ids minted by different encodings do not sort against each other even when both are individually monotonic.

## Loaders — `/loaders` and `/loaders/node`

`Loader<T>` is the whole contract: `load()` resolves the full batch, with an optional `lookup(name)` fast path for callers that read one record at a time. The primitives compose; each consuming package builds its own record-typed `fromX` surface on top.

```ts
import { mapLoader, mergeLoaders, sourceFromArray } from "@agentick/utils/loaders";
import { sourceFromDirectory } from "@agentick/utils/loaders/node";

interface Doc {
  readonly name: string;
  readonly body: string;
}

const loader = mergeLoaders<Doc>(
  sourceFromArray([{ name: "inline", body: "…" }]),
  mapLoader(
    sourceFromDirectory({ path: "./docs", recursive: true, match: /\.md$/ }),
    (file) => ({ name: file.path, body: file.content }), // return null to discard
  ),
);

const docs = await loader.load(); // ordered by input, not by completion
```

| Subpath         | Exports                                                                                                                      | Use when                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `/loaders`      | `Loader<T>` · `mergeLoaders` · `mapLoader` · `sourceFromArray` · `sourceFromUrl` · `sourceFromModule` · `extractFrontmatter` | platform-agnostic; safe in a browser or edge bundle |
| `/loaders/node` | `sourceFromFile` · `readFrontmatterFile` · `sourceFromDirectory` · `FileRecord` · `FrontmatterFileRecord`                    | the path that needs `node:fs`                       |

`sourceFromUrl` is fetch-based and therefore sound only for function-free records; `sourceFromModule` dynamic-imports and preserves functions. Which sources are sound for a given record type is a decision for the package that owns the record — which is exactly why there is no unified `from*` API at this layer. See [@agentick/skills](../skills) and [@agentick/prompts](../prompts) for the composed surfaces, and [`src/loaders/README.md`](./src/loaders/README.md) for the primitive-level detail.

`extractFrontmatter` is a delimiter-block scanner, not a parser — it hands back the raw block and the body, and the caller picks its own YAML/TOML dependency.

## Path confinement — `/path/node`

String-prefix containment over a lexically resolved path is unsafe: a symlink inside the root pointing outward sails through `abs.startsWith(root + sep)` while touching whatever it targets. `realpathWithin` resolves symlinks first, then checks containment.

```ts
import { realpathWithin } from "@agentick/utils/path/node";
import { realpath } from "node:fs/promises";

const root = await realpath("/srv/workspace"); // resolve ONCE at construction
declare const userSuppliedPath: string;

const target = await realpathWithin(userSuppliedPath, root);
if (target === null) throw new Error("path escapes the workspace root");
```

`root` must already be realpath-resolved by the caller — realpath is a syscall, and on macOS it collapses `/var` → `/private/var`, so an unresolved root fails containment spuriously. A missing leaf is fine: `realpathAllowingMissing` bounds it by the deepest existing ancestor's realpath, so a create-through-a-symlink is judged correctly before the file exists. `isPathWithin` is the pure lexical half, exported for callers that have already resolved both sides.

## Test helpers — `/testing`

Importable from any package's tests without touching the production import graph.

```ts
import { drainRejection, waitFor, waitForStable } from "@agentick/utils/testing";

declare const received: unknown[];
declare const handle: { readonly result: Promise<unknown>; readonly taskId: string };

// State the expected observable and let the helper drive time forward. Adapts
// to whatever the implementation's real timing is — in-memory, loopback TCP,
// a slow CI runner — instead of yielding N microtasks and hoping.
await waitFor(() => received.length === 1, { description: "one delivery" });

// "Nothing more arrives": poll until the snapshot stops changing.
await waitForStable(() => received.length);

// Attach the catch handler at CONSTRUCTION so the rejection is observed
// before the test awaits something else — no unhandled-rejection warning.
const drained = drainRejection(handle.result);
await session.tasks.cancel(handle.taskId);
expect(await drained).toMatchObject({ status: "cancelled" });
```

> [!WARNING]
> `drainRejection` is test-only. A fire-and-forget site in a long-lived harness or transport that intentionally swallows a rejection has different semantics; the name is there to make the intent obvious at the call site.

## API

### `@agentick/utils`

| Export                                                                                      | Kind      | Purpose                                                      |
| ------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------ |
| `isString` · `isNumber` · `isBoolean` · `isNull` · `isUndefined` · `isFunction` · `isArray` | predicate | one canonical `typeof` / `Array.isArray` check per concept   |
| `isDate` · `isRegExp` · `isMap` · `isSet`                                                   | predicate | `instanceof` checks for the built-ins                        |
| `isDefined<T>`                                                                              | predicate | not `null` and not `undefined`                               |
| `isFalsey`                                                                                  | predicate | `false \| 0 \| "" \| null \| undefined`                      |
| `isObject`                                                                                  | predicate | key/value bag — not array, not null, not a function          |
| `isPlainObject`                                                                             | predicate | POJO only — prototype is `Object.prototype` or `null`        |
| `isThenable`                                                                                | predicate | duck-typed `PromiseLike`; matches cross-realm thenables      |
| `isEqual(a, b)`                                                                             | function  | deep structural equality (JSON shapes + `Date` + `RegExp`)   |
| `mergeLayered<T>(...layers)`                                                                | function  | variadic cascade deep-merge, least → most specific           |
| `foldLayer<T>(acc, layer)`                                                                  | function  | the single-layer step, for custom folds                      |
| `append<T>` · `prepend<T>` · `replace<T>` · `omit`                                          | strategy  | per-field opt-out of the default merge rules                 |
| `isMergeStrategy`                                                                           | guard     | true when a value carries a strategy marker                  |
| `Layer<T>` · `MergeStrategy<T>`                                                             | type      | one cascade layer; a symbol-wrapped field value              |
| `omitUndefined(obj)` · `OmitUndefined<T>`                                                   | function  | drop `undefined`-valued keys at a boundary (shallow)         |
| `resolveSync(v)` · `resolveAsync(v)`                                                        | function  | resolve a `Resolvable` / `ResolvableAsync` to its value      |
| `Resolvable<T>` · `ResolvableAsync<T>`                                                      | type      | literal-or-thunk config value                                |
| `mapConcurrent(items, n, fn)`                                                               | function  | bounded-concurrency map; input order preserved               |
| `mergeAbortSignals(...signals)`                                                             | function  | one signal that fires on the first source abort              |
| `reasonOf(value)`                                                                           | function  | unknown → single-line reason string                          |
| `reasonOfCause<E>(cause)`                                                                   | function  | Effect `Cause` → single-line reason string                   |
| `causeValue<E>(cause)`                                                                      | function  | Effect `Cause` → the originating value, unstringified        |
| `unwrapExit<A, E>(exit)`                                                                    | function  | `Exit` → value, or rethrow preserving typed-failure identity |
| `liftToEffect(fn, errorMap?)`                                                               | function  | sync/async/Effect function → Effect-returning; idempotent    |
| `applyJsonPatch<T>(doc, ops)`                                                               | function  | RFC 6902 apply, copy-on-write                                |
| `JsonPatchOp` · `JsonPatchError`                                                            | type      | one operation; the throw on an inapplicable patch            |
| `matchesScope<S>(filter, scope)`                                                            | function  | partial-filter match over any object shape                   |
| `compileScopeMatcher<S>(filter)`                                                            | function  | the same match, filter keys pre-extracted for hot paths      |
| `matchesAddressFilter` · `matchesEventFilter`                                               | function  | address- and event-shaped routing predicates                 |
| `AddressFilterShape` · `EventFilterShape` · `EventLike`                                     | type      | the structural filter shapes those two take                  |
| `generateId()`                                                                              | function  | lexicographically sortable, monotonic-within-ms id           |
| `splitMessage(text, options)` · `SplitOptions`                                              | function  | chunk text to a hard cap on semantic boundaries              |
| `cartesian(axes)`                                                                           | function  | full product of axis values, one record per cell             |
| `paginate(all, cursor, pageSize?)` · `Page<T>` · `DEFAULT_PAGE_SIZE`                        | function  | one page of a list + the cursor that follows it              |

### `@agentick/utils/testing`

| Export                                              | Purpose                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `waitFor(cond, options?)`                           | Poll until truthy or the deadline expires; returns the truthy value              |
| `waitForStable(snapshot)`                           | Poll until the snapshot stops changing — the "nothing more arrives" case         |
| `drainRejection(p)`                                 | Observe a rejection eagerly; resolves with the value or the reason               |
| `WaitForOptions`                                    | `timeoutMs` (1000) · `pollMs` (5) · `description`; `stableMs` (50) on the second |
| `assertIdGeneratorConformance(name, gen, options?)` | Throw unless a generator is fit for `setIdGenerator`; no test framework          |
| `IdGeneratorConformanceOptions`                     | `burst` (1000) — ids minted per ordering check                                   |

### `@agentick/utils/loaders`

| Export                             | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `Loader<T>`                        | `load()` plus an optional `lookup(name)` fast path            |
| `mergeLoaders(...loaders)`         | Concatenate batches; input order, no partial-success semantic |
| `mapLoader(loader, fn)`            | Transform each record lazily; `null` discards                 |
| `sourceFromArray(items)`           | Literal records                                               |
| `sourceFromUrl(options)`           | `fetch`-based; function-free records only                     |
| `sourceFromModule(options)`        | Dynamic import; preserves functions                           |
| `extractFrontmatter(input, opts?)` | Delimiter-block scan → `{ frontmatter, body }`; no YAML parse |

### `@agentick/utils/loaders/node`

| Export                                 | Purpose                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `sourceFromFile(options)`              | One file → a one-element batch of `FileRecord`            |
| `readFrontmatterFile(path, opts?)`     | Read + split into `FrontmatterFileRecord`                 |
| `sourceFromDirectory(options)`         | Walk a directory; `recursive` · `includeHidden` · `match` |
| `FileRecord` · `FrontmatterFileRecord` | `{ path, content }`, plus `{ frontmatter, body }`         |

### `@agentick/utils/path/node`

| Export                              | Purpose                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `realpathWithin(input, root)`       | Resolve symlinks, then confine to `root`; `null` when outside |
| `realpathAllowingMissing(absolute)` | `realpath` tolerant of a not-yet-existing leaf                |
| `isPathWithin(child, root)`         | Pure lexical containment, sibling-prefix safe                 |

## What does not belong here

- **Anything importing `@agentick/spec`, a harness, or a protocol.** That is domain code. The moment a utility knows what a session is, it belongs to the layer that owns sessions.
- **Anything tied to React, JSX, the compiler, or a runtime event loop.** Observer primitives (`Notifier`, `KeyedNotifier`, `LocalPubSub`) live in [@agentick/pubsub](../pubsub); streaming and journal helpers live in [@agentick/runtime](../runtime).
- **A utility with one consumer.** The bar is two or more packages already needing it. A single caller keeps it local until a second one shows up.
- **Domain-flavored helpers wearing a generic name** — timeline scans, content extractors, registry queries. They go in the package that owns the domain.
- **`Map`/`Set` deep equality.** Rare here, and `effect/Equal` handles it for callers who need it.
- **Cycle-safe deep merge.** `mergeLayered` is config-flavored; a cyclic config is not a case worth the complexity.

## Roadmap & known gaps

- **`Layer<T>` is shallow.** Nested objects deep-merge at runtime, but the type makes only top-level keys optional — a layer that wants to override one field of a nested object has to supply the whole nested shape or wrap it in `replace()`. Widening `Layer` to recurse is the fix; it hasn't landed.
- **No custom per-field merger.** The four symbol strategies cover every cascade in the framework today. If a case demands a free-form combiner it will arrive as a `combine(fn)` strategy, not a parallel API.
- **No `effect`-flavored variants.** Adopters wanting `Equal.symbol` semantics or `Schema`-aware equality reach for `effect/Equal` directly.
- **`waitFor` / `waitForStable` have no dedicated suite.** They are exercised constantly through the transport and cluster suites that depend on them, but their own timeout, poll-interval, and stability-window behavior isn't pinned in this package.
- **`matchesAddressFilter` / `matchesEventFilter` are untested here.** Only `matchesScope` and `compileScopeMatcher` have a suite; the address- and event-shaped matchers are covered indirectly, if at all.
- **A replacement generator is trusted once installed.** `setIdGenerator` does not run `assertIdGeneratorConformance` against what it is handed — the check is opt-in, and a generator that violates monotonicity is accepted silently. Validating at the seam would mean minting a thousand ids on a startup path to answer a question the adopter can answer once, in a test.
- **`sourceFromDirectory` does not follow symlinks** — deliberate, and asserted. There is no opt-in for callers who want traversal through a link.

## Verified by

- `src/__tests__/merge-layered.spec.ts` — the full cascade table: scalar precedence, `undefined`-falls-through vs. explicit-`undefined`, skipped layer arguments, recursive object merge, arrays and class instances and factory functions replacing rather than merging, all four strategies including chained `append` and absent-parent fallback, and an end-to-end defaults → env → adopter → call-site scenario.
- `src/__tests__/predicates.spec.ts` — every predicate, including `isPlainObject`'s prototype-chain rejection of class instances and built-ins, `isThenable` against native promises / A+ thenables / non-objects, and `isEqual` across primitives, arrays, objects, `Date`, `RegExp`, and the `Object.is` edges (`NaN` equal, `-0` not).
- `src/__tests__/omit-undefined.spec.ts` — `undefined` dropped while `0` / `""` / `false` / `null` survive, input never mutated, and a compile-time pin that the result type fits an `exactOptionalPropertyTypes` target.
- `src/__tests__/cause.spec.ts` — table-driven `reasonOf` resolution order (string → `Error.message` → `_tag` → JSON → `String`), `reasonOfCause` precedence with typed failure winning over a composite cause, and `unwrapExit` preserving typed-failure identity while collapsing defects and interrupts into `Error(Cause.pretty)`.
- `src/__tests__/effect-lift.spec.ts` — sync / async / already-`Effect` inputs, re-lifting as a no-op, `errorMap` coercion, composition under `yield*`, and that the lift does not fork — plus a child fiber inheriting `FiberRef` and cascading abort.
- `src/__tests__/json-patch.spec.ts` — object and array ops, `"-"` append, out-of-bounds and missing-key throws, `~0`/`~1` unescaping, whole-document target, op sequencing, `test` mismatch, and the copy-on-write proof that untouched subtrees keep their reference.
- `src/__tests__/map-concurrent.spec.ts` — input order preserved against out-of-order completion, the in-flight cap never exceeded, `concurrency: 1` sequential, `<= 0` clamped, first rejection propagated.
- `src/__tests__/id.spec.ts` — the 26-char shape (10-char time prefix + 16-char random suffix), the Crockford base32 alphabet, no collisions across a tight burst, same-millisecond monotonicity with the suffix advancing by exactly one across a carry, cross-millisecond lexicographic ordering, the 48-bit timestamp range, and a clock corrected BACKWARD still producing a greater id. The built-in generator is run through `assertIdGeneratorConformance`, so the default is held to the bar a replacement is — and the checker itself is checked, against a random-uuid generator, an unpadded counter, a repeater, and a clock-only generator, each rejected by the specific claim it violates.
- `src/__tests__/wait-for.spec.ts` — `waitFor` returning synchronously-true conditions without polling, polling through falsy returns, and both timeout messages; `waitForStable` honoring the quiet period, comparing snapshots by value rather than identity, settling on unserializable snapshots, and rejecting when the snapshot never stops changing.
- `src/__tests__/abort-signals.spec.ts` — no-signal `undefined`, a lone signal returned unwrapped, an already-aborted source handed back so `.aborted` reads synchronously, and reason propagation from whichever source fires first.
- `src/__tests__/resolvable.spec.ts` — literal pass-through, thunk invocation with no memoization, errors surfacing at the resolution site, narrow literal types preserved, and the async arms.
- `src/__tests__/match-scope.spec.ts` — empty filter matches everything, every present dimension must strictly equal, explicit `undefined` is not a constraint, no coercion, and `compileScopeMatcher` semantically identical to `matchesScope` across a filter sweep while reusable across many values.
- `src/__tests__/paginate.spec.ts` — the cursor contract every wire and projection surface shares: a single page carrying no cursor, a full walk seeing each item exactly once, the cursor being the next OFFSET, no empty trailing page at an exact boundary, garbage / negative / empty cursors starting over rather than throwing, `parseInt` prefix decoding, an empty page past the end, and the `DEFAULT_PAGE_SIZE` default.
- `src/__tests__/cartesian.spec.ts` — the mathematical edges (`{}` → one empty cell, an empty axis → zero cells), rightmost-axis-varies-fastest ordering, reference identity of axis values, and fresh mutation-safe cells.
- `src/__tests__/split-message.spec.ts` — no chunk over the cap, boundary priority, hard break when no boundary exists, continuation-suffix headroom, a 4096-cap payload, and the throw when the continuation is as long as the limit.
- `src/__tests__/drain-rejection.spec.ts` — value and rejection pass-through, no unhandled-rejection event when another `await` races, a session-lifecycle pattern staying warning-free, repeated awaits yielding the same resolution, and that it does not absorb other promises' rejections in the same tick.
- `src/loaders/__tests__/loaders.spec.ts` — `sourceFromArray` / `mergeLoaders` (order preserved against completion order, rejection propagated) / `mapLoader` (async mappers, `null` discards), `sourceFromUrl` status handling with `acceptStatuses`, `sourceFromModule` preserving functions across the load boundary, `extractFrontmatter` including the missing-closing-delimiter and custom-delimiter cases, and an array → map → merge composition end to end.
- `src/loaders/__tests__/node.spec.ts` — file and frontmatter reads, recursive walk with deterministic path sort, hidden-entry policy both ways, `RegExp` and predicate filters, symlinks not followed, and a helpful error when `readdir` fails.
- `src/path/__tests__/node.spec.ts` — the security seam: a legitimate in-root symlink allowed, a symlink inside the root pointing outward **rejected**, `..` traversal rejected, a missing file still judged by containment, sibling-prefix false match rejected, and the deepest-existing-ancestor bound for a missing leaf.

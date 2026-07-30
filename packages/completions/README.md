# @agentick/completions

**Finish the user's sentence, with the tenant's data.** Someone typing into a command form asks "which account?", and the honest answer is a filtered lookup against live data — narrowed by the characters typed so far, conditioned on the sibling arguments already filled (the contacts of _that_ account), executed with the caller's identity. This package is that seam: a registry of `name → resolver` bindings, one `resolve` door, and five builders for authoring the resolvers.

Two things shape the design. The registry owns **no data** — a resolver reads candidates from wherever they already live, a tenant database, a store, a static list. And a completion is deliberately **not a tool call**: it fires per keystroke, so `resolve` mints no operation and writes nothing to the journal.

## Install

```bash
npm install @agentick/completions
```

Subpaths: `/testing` (doubles, a resolver-ctx factory, and the conformance suite).

## Quick start

Name your sources, mount them, resolve one:

```ts
import {
  completeDependent,
  completeFromAsync,
  completeFromList,
  defineCompletions,
} from "@agentick/completions";

export default defineCompletions({
  sources: {
    "crm.accounts": completeFromAsync((typed) => accountsApi.search(typed)),
    "crm.contacts": completeDependent({ requires: ["account"] }, (typed, { account }) =>
      contactsApi.search(typed, account),
    ),
    "crm.stage": completeFromList(["prospect", "qualified", "won", "lost"]),
  },
});
```

```ts
import completions from "./completions/index.js";

const app = createApp(<Agent />, { model, completions });
```

```ts
await session.completions?.resolve("crm.contacts", {
  value: "ada",
  resolvedArguments: { account: "Northwind" },
  signal: controller.signal,
});
// → { values: ["Ada Lovelace", "Adam Byrne"] }
```

`session.completions` is `undefined` when nothing installed the namespace, so guard it. `resolve` throws `CompletionNotFound` for a name nobody bound and `CompletionResolveFailed` — carrying the original `cause` — when a resolver throws.

## One source per file

`defineCompletion` is the singular: one named source per file, default-exported, collected by an explicit barrel.

```ts
// completions/accounts.ts
import { completeFromAsync, defineCompletion } from "@agentick/completions";

export default defineCompletion(
  "crm.accounts",
  completeFromAsync((typed) => accountsApi.search(typed)),
);
```

```ts
// completions/index.ts
import { defineCompletions } from "@agentick/completions";
import accounts from "./accounts.js";
import contacts from "./contacts.js";

export default defineCompletions({ sources: [accounts, contacts] });
```

`sources` takes either spelling — the inline `name → resolver` map, or an array of named sources from a barrel — with one difference: a **duplicate name in the array throws at define time**, rather than silently last-writer-wins at install.

What comes back from `defineCompletion` is still a plain resolver, with the name readable off the function — so it is dual-use. List it in a barrel, or hand it straight to a prompt argument that wants exactly this one source and no registry entry:

```ts
{ name: "account", complete: accounts }                  // the function itself
{ name: "account", complete: accounts.completionName }    // or its registry name
```

Naming wraps rather than mutates, so one underlying resolver can be named twice, and a `completeDependent` resolver keeps its `requires` metadata across the naming.

## The builders

| Builder                               | Semantics                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `completeFromList(values)`            | static list, prefix-filtered case-sensitively                                 |
| `completeFromEnum(zodEnum)`           | the `.options` of a Zod enum (read structurally), prefix-filtered             |
| `completePrefixMatch(loader)`         | lazy full-set loader (sync or async); the builder filters                     |
| `completeDependent({ requires }, fn)` | declared sibling dependencies; unmet → `{ values: [] }` without invoking `fn` |
| `completeFromAsync(fn)`               | escape hatch — full `CompletionResult` control                                |

Empty input matches everything, so the first keystroke is not a special case.

`completeDependent`'s `requires` is **metadata, not just control flow**. It is readable off the returned resolver, which is what lets a composer grey out a slot instead of firing a doomed request per keystroke:

```ts
const contacts = completeDependent({ requires: ["account"] }, fn);

isDependentResolver(contacts) && contacts.requires; // ["account"]
```

The metadata is non-enumerable, so it never shows up in a spread or a JSON projection of a resolver bag.

**No value cap anywhere in here.** MCP caps a `completion/complete` response at 100 values; that is a constraint of MCP's wire and it is applied at MCP's projection, so a builder returns everything it found. A programmatic caller gets the whole answer and another wire trims to its own limit. See [@agentick/mcp](../mcp).

## What a resolver receives

The second argument is a framework-minted ctx: the operation trunk (the owning session's `sessionId`, identity, and the `log` / `trace` / `metrics` / `run` facets) plus two facets that exist for this seam specifically.

```ts
completeFromAsync(async (typed, ctx) => {
  const res = await fetch(`/api/contacts?q=${typed}&account=${ctx.resolvedArguments.account}`, {
    signal: ctx.signal, // latest-wins: the composer aborts the previous keystroke
  });
  return (await res.json()).map((c) => c.name);
});
```

`resolvedArguments` is the sibling values already filled — `{}` when the caller supplies none. `signal` is the caller's cancellation, `undefined` when they offer none. The ctx is derived, never hand-assembled, so a resolver sees the same identity and telemetry facets a resource resolver or a prompt's `render` sees.

It is deliberately **not** a tool-handler ctx. A keystroke query has no `toolCallId`, no task mode, and no transport discriminator, so a tool ctx would have to be fabricated — and fabricating one is a compile error by design.

## Over the wire

A composer runs in a browser, so the seam that matters most is the one a client
can reach. `completions/complete` is that verb, and the client method for it is
derived rather than written — declaring the wire row is the whole of the client
work:

```ts
const session = client.session(sessionId);

const r = await session.completions.complete({
  ref: { type: "prompt", name: "tm_change_order_actual_cost" },
  argument: { name: "phase", value: "fra" },
  context: { arguments: { job: "Miller Residence" } },
});
// → { values: ["Miller Residence — Framing CO #2"] }
```

`ref` is MCP's shape on purpose, so squaring up with `completion/complete` costs a
projection instead of a translation. It carries one arm today (`"prompt"`) and it
is a literal union, not a string — naming `"resource"` before that arm exists is a
compile error, not a 404.

The route composes two hops, because a prompt argument's resolver may live on
either side of the split: it asks the prompts harness first (an **inline**
resolver runs there), and resolves a returned name against this registry (a
**named** ref). One consequence is worth knowing: the inline path needs no
completions namespace at all. An app that installs [@agentick/prompts](../prompts)
with inline `complete:` resolvers and never mentions `withCompletions` still
completes over the wire.

Everything unanswerable answers `{ values: [] }` — no prompts surface, an argument
that declares no completion, a ref nobody bound, a restored session whose
resolvers did not survive. An unanswered question is not a protocol fault, and
zero candidates is the right thing for a composer to show in every one of those
cases. The single real error is an unknown PROMPT: the client named something that
does not exist.

Server-side, a tool handler reaches the same registry through its ctx:

```ts
const r = await ctx.completions?.resolve("crm.accounts", { value: "north" });
```

## A keystroke is not an event

Every other read surface in the framework is a declared command: it mints a journaled operation with request and terminal envelopes, addressable over the inbox and enumerable on the wire. `resolve` is a plain async method instead. One operation per character typed would flood the recovery and audit spine with ephemeral queries for no durability benefit — which is the same reason completion is not routed through tool dispatch.

That is a testable claim, so it is tested:

```ts
import { fakeCompletions } from "@agentick/completions/testing";
import { completeFromList } from "@agentick/completions";

const { harness, journal } = await fakeCompletions();
harness.register("crm.accounts", completeFromList(["Northwind", "Nordics"]));

for (const typed of ["N", "No", "Nor"]) {
  await harness.resolve("crm.accounts", { value: typed });
}

journal.totalAppended(); // → 0
```

`register` is likewise a plain synchronous insert. It takes a required function argument, which makes it unaddressable over any wire by construction.

The wire verb holds the same line one layer up, which took a new seam to do
honestly. Every wire dispatch mints a `wire:<method>` boundary op at the gateway,
and its request and terminal envelopes journal by default — so serving completion
over the wire would have moved the flood from here to there. A wire method can now
declare its own durability disposition (`journal: { "completions/complete":
"bus-only" }`), and the gateway folds that into its journaling policy. Live
observers still see every request; the durable spine sees none of them. A
deployment that wants them durable anyway says so in its own policy and wins — the
declaration is a default, not a lock.

What still lands per keystroke is the gateway's own contextual-authorization op.
That is a security audit record with a different owner and its own hook seam, and
turning off authorization audit is not this verb's call to make.

## Registration is an upsert

Re-registering a name replaces the resolver rather than throwing. The declarative path re-registers inline resolvers under derived names on every render pass, and a throw there would fail the second render of an unchanged tree. The `Unsubscribe` a registration returns removes the binding only while it is still the current one, so a stale handle cannot delete its replacement:

```ts
const stale = completions.register("crm.stage", first);
completions.register("crm.stage", second); // replaces
stale(); // no-op — `second` survives
completions.has("crm.stage"); // → true
```

`subscribeAll(listener)` fires on register and unregister. It is registry topology, not per-name content: what it tells a composer is that its completable slot set changed.

## Result currency

```ts
interface CompletionResult {
  readonly values: readonly string[];
  readonly total?: number; // full match count, when the source knows it
  readonly hasMore?: boolean; // `values` is a prefix of the real answer
}
```

A resolver may answer with a bare `readonly string[]` as sugar. `resolve` folds it through `normalizeCompletionResult` and always hands back the full shape, so a consumer never discriminates.

## Mounting — a definition or a live instance

Both mount forms take the same two shapes, and there is no third:

```ts
// A definition: inert until install, constructed per session, torn down with it.
createApp(<Agent />, { model, completions: defineCompletions({ sources: [accounts] }) });

// The extension form — for runtime-built sources and conditional composition.
createApp(<Agent />, { model, extensions: [withCompletions({ sources: [accounts] })] });

// A live instance: you own construction and teardown; it is not closed on session close.
createApp(<Agent />, { model, extensions: [withCompletions(myRegistry)] });
```

An inline `{ sources }` bag is a perfectly valid definition — `defineCompletions` adds a brand for tooling, not admission.

There is no interceptor cascade from the app into this namespace. That cascade exists to let an app-level `use` / `guard` / `hook` reach a namespace's operations, and this one declares none on purpose — wiring it would inherit interceptors that can never fire, which reads as coverage that does not exist.

## API

### `@agentick/completions`

| Export                                                            | Purpose                                             |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| `defineCompletion(name, resolver)`                                | Name one source — the per-file singular; dual-use   |
| `defineCompletions({ sources })`                                  | Name the definition: identity + brand               |
| `withCompletions(config?)`                                        | Session extension — definition or live instance     |
| `completionsWireExtension`                                        | The `completions/complete` wire route               |
| `sourcesMapOf(sources)`                                           | Fold a barrel / map into the registry map           |
| `CompletionsHarness`                                              | The implementation, for direct construction         |
| `completeFromList` / `completeFromEnum`                           | Static-list builders                                |
| `completePrefixMatch` / `completeFromAsync`                       | Lazy-loader and full-control builders               |
| `completeDependent({ requires }, fn)`                             | Sibling-dependent builder                           |
| `normalizeCompletionResult(raw)`                                  | Fold `string[]` → `{ values }`                      |
| `isDependentResolver(r)`                                          | Read `requires` off a resolver                      |
| `isNamedCompletionResolver(r)`                                    | Read `completionName` off a resolver                |
| `isCompletionsDefinition(v)`                                      | Does this value carry the `defineCompletions` brand |
| `CompletionsConfig` / `CompletionsDefinition` (types)             | What the slot and `withCompletions` accept          |
| `NamedCompletionResolver` / `DependentCompletionResolver` (types) | Resolvers carrying readable metadata                |

### The instance surface

```ts
interface Completions {
  readonly id: string;
  readonly ready: Promise<void>;
  register(name: string, resolver: CompletionResolver): Unsubscribe;
  has(name: string): boolean;
  list(): readonly string[]; // registered names, sorted
  subscribeAll(listener: () => void): Unsubscribe;
  resolve(name: string, input: CompletionsResolveInput): Promise<CompletionResult>;
  close(): Promise<void>;
}
```

Construction: `new CompletionsHarness(scopeId, journal, bus, inbox, options?)`. The options bag is `BaseHarnessOptions` verbatim — a registry has nothing of its own to configure — and `parentScope` is the one that matters, because it is the trunk the resolver ctx is derived from.

### `@agentick/completions/testing`

| Export                                  | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `fakeCompletions(options?)`             | A real instance on an in-memory substrate — the default choice |
| `stubCompletions({ values })`           | Canned `name → values`, prefix-filtered, no substrate          |
| `fakeCompletionCtx(options?)`           | A real derived ctx for exercising a resolver directly          |
| `runCompletionsHarnessConformance(...)` | Certify an alternate implementation                            |

```ts
import { fakeCompletionCtx } from "@agentick/completions/testing";

// No registry needed — call the resolver and assert on the answer.
await contacts("ada", fakeCompletionCtx({ resolvedArguments: { account: "Northwind" } }));
```

`fakeCompletions` hands back the `journal`, `bus`, and `inbox` alongside the instance, and gives each one a ULID-suffixed id so concurrent tests never collide on inbox addresses. `stubCompletions` still prefix-filters its canned list, so a consumer's "type and watch it narrow" assertion holds without a resolver ever running.

## Patterns

**Prompt arguments.** A prompt argument declares how it completes: either an inline resolver or a name into this registry. [@agentick/prompts](../prompts) performs the split — the function stays with the declaration, and the record carries the resolver's name plus its `requires` — so a palette can read what a slot needs before offering it. Joining the two halves is the wire route's job, above.

**MCP.** [@agentick/mcp](../mcp) serves `completion/complete` through this same seam — a prompt argument's `complete` answers an MCP client without being restated in server config, and an argument naming a source here resolves against this registry. An explicit `completions.prompts[name][arg]` handler on the server is the override, and the only path for a server projecting no prompts surface. mcp also re-exports the five builders so a server adopter authors handlers from one import path, and it adds the MCP boundary facet to the resolver ctx (`ctx.mcp`, carrying the connection's authenticated user and its credential). The 100-value ceiling lives at that package's projection, so the same resolver answers 100-with-`hasMore` over MCP and everything it found over the agentick wire.

**Two faces on the door.** `resolve` mints the resolver's ctx from this harness's owning scope; `fx.resolve` — the composable Effect twin — mints it from the CALLER's fiber. An inbound MCP completion needs the second: the resolver must see the connecting client's identity, not the session that happens to own the registry, so the MCP projection composes the twin inside its crossing. Neither face journals; the twin buys the fiber, not an envelope. The same split exists on `prompts.complete` / `prompts.fx.complete`.

**Shapes.** [@agentick/spec](../spec) owns `CompletionResult`, `CompletionValues`, `CompletionCtx`, `CompletionResolver`, `CompletionsResolveInput`, the `Completions` protocol alias, `isCompletionsInstance`, and the `CompletionsError` / `CompletionNotFound` / `CompletionResolveFailed` classes. A declaration references a resolver by name, so only a string ever crosses that boundary — a function never does.

## Roadmap & known gaps

- **Only prompt arguments complete on the agentick wire.** `ref.type` has one arm. Resource-template variables and tool arguments are additive — the ref shape was chosen so they cost a new arm and nothing else — but neither is built. (MCP's own `ref/resource` is served, from server config: a resource template carries no per-variable `complete` to fold in.)
- **No enumeration over the wire.** A client can ask for candidates but cannot ask what is completable: `list()` is in-process only, and there is no `added` / `removed` topology notification, so a composer learns a slot is completable from the prompt record's `completeRef` rather than from this registry.
- **A named ref is never validated.** A prompt argument may name a source nobody bound, and nothing says so at registration; the request answers `{ values: [] }` and a typo looks exactly like an unmounted source.
- **A late-registered wire extension's `journal` declaration is ignored.** The gateway binds its journaling policy at construction, so a wire extension registered by a gateway extension's `install()` misses the fold. Nothing declares `journal` from a gateway extension today; the marker is `TODO(wire-journal-late-registration)`.
- **A forwarded completion cannot be cancelled.** Completion on MCP-origin prompts IS forwarded — a prompt folded in from a remote server carries a resolver per argument whose body re-asks that server, with the filled siblings riding as MCP's `context.arguments`, and the origin's `total` / `hasMore` surviving so a truncated list is never reported as whole ([`@agentick/mcp`](../mcp/README.md#a-servers-prompts-in-your-palette)). What does not cross is `ctx.signal`: the client's completion verb is a declared command and its invoker takes no `AbortSignal`, so a superseded keystroke's request still round-trips (`TODO(mcp-complete-abort)`).
- **Tool-argument completion is not built.** The shape is additive, and the framework could exceed MCP here — MCP completes prompts and resource templates only — but it needs a flat-argument projection of a tool's input schema first.
- **No snapshot or restore.** A resolver is a function; it does not serialize. A restored session re-registers from its definition or its tree.
- **No React surface and no model tools.** Completion is a client affordance: a model has no use for "finish this argument for the human", and there is nothing to render.

## Verified by

- `src/__tests__/harness.spec.ts` — `resolve` writing **nothing** to the journal across three keystrokes; `defineCompletions` as identity plus a non-enumerable brand; an inline `{ sources }` bag being a valid unbranded definition and not mistaken for a live instance; `withCompletions`'s definition arm constructing, binding, and owning teardown while its instance arm registers without closing; the installing session's scope reaching the resolver ctx.
- `src/__tests__/definition.spec.ts` — `defineCompletion` naming a resolver without it ceasing to be one (the named source is directly callable), the name staying out of enumeration and `JSON.stringify`, a dependent resolver's `requires` and its gating surviving the naming, wrapping rather than mutating so one resolver can be named twice, the array arm folding into the map, and a duplicate name throwing at define time.
- `src/conformance.ts` — the exported protocol suite: register / `has` / sorted `list` / `Unsubscribe`; upsert with a stale handle; `subscribeAll` on register and unregister; both return shapes; `resolvedArguments` reaching the ctx (and `{}` when omitted); the operation trunk plus `log` / `run` facets; `AbortSignal` passthrough; `CompletionNotFound` and `CompletionResolveFailed` with its cause; **250 values in, 250 out**; `completeDependent` gating without invoking its loader; and `fx.resolve` answering what `resolve` answers, raising the same protocol error on its own channel.
- `../mcp/src/server/__tests__/projection-completions-seam.spec.ts` — the seam serving MCP: a declaration's inline resolver answering `ref/prompt` with **no `completions` config at all**, sibling values arriving as `resolvedArguments`, a named ref resolving the second hop against a wired registry (and answering empty with none wired, or with a name nobody bound), an explicit config handler outranking the declaration for the same argument while leaving a sibling argument's own intact, a hidden prompt being uncompletable, the capability following the projected surface, and — the fiber claim — the resolver reading the caller's `mcp.user` credential alongside the redacted trunk identity. Plus one resolver capped at 100 with `hasMore` over MCP and returning all 150 through the prompts door.
- `src/__tests__/wire.spec.ts` — the route's two-hop join driven directly: a `resolved` outcome passing through with the ref's name and nested `context.arguments` intact, a `ref` outcome triggering the registry hop with the sibling values flattened onto `resolvedArguments`, empty answers for no prompts surface / an unavailable argument / no registry mounted / an unbound name, a throwing resolver surfacing as the failure it is, `PromptNotFound` propagating, an unresolved session throwing, and the `bus-only` declaration itself.
- `src/__tests__/wire-proxy.type.spec.ts` — the derived client method: `completions` enumerating as a session-scoped namespace, `sessionId` bound out of the caller's params, `ref.type` typed as a one-member literal union rather than `string`, the `CompletionResult` return, and a typo'd method not existing.
- `../transport-in-process/src/__tests__/completions-complete-e2e.spec.ts` — the round trip through the real gateway and transport: the inline-sidecar path narrowing as the user types, the named-registry path gated on an unfilled sibling and then answering, empty answers for an argument with nothing to ask and for one that does not exist, an unknown prompt surfacing as an error, and **no wire, prompts, or completions envelope in the journal across four keystrokes**.
- `../gateway/src/__tests__/wire-journaling.spec.ts` — the durability declaration: an undeclared method journaling two envelopes per dispatch, a `bus-only` one journaling none, `completions/complete` silent while `knobs/set` stays durable, and an adopter's explicit policy outranking the declaration.
- `src/__tests__/builders.spec.ts` — each builder's semantics, `normalizeCompletionResult` folding both shapes, `requires` non-enumerability, `isDependentResolver` discrimination, the full ctx (trunk, facets, siblings) reaching a resolver, and the no-cap claim at 150 and 250 values.
- The top-level slot plumbing — a namespace-config key forwarded to its extension without the app importing this package — is covered generically in [@agentick/runtime](../runtime).
- The relocated wire cap is covered in [@agentick/mcp](../mcp): a builder returns all 150 values while the MCP response is capped at 100 with `hasMore: true`, a source-reported `total` survives the clamp, and the builders resolve through that package's barrel against its own ctx type.

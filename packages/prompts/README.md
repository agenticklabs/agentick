# @agentick/prompts

A prompt is a named, parameterized message template a human reaches for — a slash command, a saved query, an admin-curated workflow starter. This package gives a session a library of them: register by name with typed arguments, invoke by name with values, get back role-bearing messages either appended to the conversation or handed to you.

Prompts are **user-directed**. A skill is something the model discovers and reads; a prompt is something a person triggers. That distinction is why prompts ship no model-facing tools and skills do.

## Install

```bash
npm install @agentick/prompts
```

Subpaths: `/hydrators` (the portable sources), `/client` (browser-side handle), `/testing` (conformance suites).

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { hydrateFrom, withPrompts } from "@agentick/prompts";

const app = await createApp(<Agent />, {
  model,
  extensions: [
    withPrompts({
      hydrate: hydrateFrom([
        {
          declaration: {
            name: "summarize_doc",
            description: "Summarize a document by id.",
            arguments: [{ name: "docId", required: true }],
            render: (args) => `Summarize the document at ${String(args.docId)}.`,
          },
        },
      ]),
    }),
  ],
});
```

Then, from anywhere with the session in hand:

```ts
const result = await session.prompts.invoke({ name: "summarize_doc", args: { docId: "42" } });
result.messages; // [{ kind: "message", role: "system", content: [{ type: "text", text: "Summarize the document at 42." }] }]
```

`invoke` also appends those messages to the session timeline — the same path explicit user input takes — so the next `send` sees them as conversation. Reads (`get` / `has` / `list`) are synchronous; mutations are async and produce audit envelopes on the session bus.

## Content shapes

A declaration carries either a static `template` or a dynamic `render(args, ctx?)`. Two shapes are handled with no configuration; anything else flows through a renderer you register.

| Content                   | Handled by                                  | Output                         |
| ------------------------- | ------------------------------------------- | ------------------------------ |
| `string`                  | built in                                    | one `system`-role message      |
| `readonly MessageEntry[]` | built in                                    | passthrough — used as-is       |
| `ReactNode`               | [@agentick/prompts-react](../prompts-react) | compiled to `MessageEntry[]`   |
| Anything else             | a `PromptRenderer` you register             | whatever your renderer returns |

```tsx
import { withReactPrompts } from "@agentick/prompts-react";

withReactPrompts({
  hydrate: hydrateFrom([
    {
      declaration: {
        name: "weekly_status",
        description: "Weekly status template",
        arguments: [{ name: "week", required: true }],
        render: (args) => (
          <>
            <message role="system">You are a status report assistant.</message>
            <message role="user">Generate the report for week {String(args.week)}.</message>
          </>
        ),
      },
    },
  ]),
});
```

`render` receives the invoking operation's context as an optional second argument, so a dynamic prompt can render per-caller content:

```ts
render: (args, ctx) => `Hello ${ctx?.principal ?? "there"}.`;
```

It's optional in the signature — declarations stay pure and trivially testable — and always threaded by the framework.

### A render can ask

The arguments a person supplied are frequently not the arguments the prompt needs: `/quoting_report` with no period, `/summarize` pointed at an ambiguous name. `ctx.elicit` is the way out — the same `Elicit` surface a tool handler reads as `ctx.elicit`, so there is one vocabulary for asking:

```ts
render: async (args, ctx) => {
  const period =
    (args.period as string | undefined) ??
    (await ctx?.elicit?.text("Which period?", { pattern: "^\\d{4}-\\d{2}$" })) ??
    currentPeriod();
  return `Quoting report for ${period}.`;
};
```

The invoke parks until the user answers, then rendering continues with the answer in hand. Both doors carry it — `invoke` and `render` alike.

**Write the no-elicit branch.** `ctx?.elicit` is absent whenever nobody is there to answer: a unit test calling `decl.render(args)` directly, a doc generator walking the catalog, a harness constructed with no session behind it. That is a normal shape, not an error state, so the honest fallback is a default, a placeholder, or a thrown `PromptArgumentMissing` — the `??` chain above, never a hang. Whether the facet is present at all is the host's answer; `createApp` wires the session's own elicitation to it for you.

### Declaration shape

```ts
interface PromptDeclaration {
  name: string;
  description: string;
  arguments?: PromptArgument[];
  template?: unknown; // static content
  render?: (args: Record<string, unknown>, ctx?: PromptRenderCtx) => unknown; // dynamic content
  version?: string; // your revision string — see "Provenance on the timeline"
  metadata?: Record<string, unknown>;
}

interface PromptArgument {
  name: string;
  description?: string;
  schema?: StandardSchemaV1; // omitted → no shape check
  required?: boolean; // default false
  complete?: CompletionResolver | string; // candidates while the user types
}
```

Supply `template` or `render`; `render` wins if both are present, and neither raises `PromptMissingContent` at invoke time. Arguments validate against their Standard Schema before content is produced.

## Argument completion

An argument can say how to finish the user's sentence. `complete` takes a resolver inline — the common case — and the builders in [@agentick/completions](../completions) cover the shapes worth naming:

```ts
import { definePrompt } from "@agentick/prompts";
import { completeDependent, completeFromAsync, completeFromList } from "@agentick/completions";

export default definePrompt({
  name: "tm_change_order_actual_cost",
  description: "Log an actual cost against a change order.",
  arguments: [
    {
      name: "job",
      required: true,
      complete: completeFromAsync((value, ctx) => jobsApi.search(value, ctx)),
    },
    {
      name: "phase",
      required: true,
      complete: completeDependent({ requires: ["job"] }, (value, { job }, ctx) =>
        phasesApi.search(value, job, ctx),
      ),
    },
    { name: "markup_pct", complete: completeFromList(["10", "15", "20", "25", "30"]) },
  ],
  render: (args) => `Log ${args.markup_pct ?? "0"}% markup on ${args.job} / ${args.phase}.`,
});
```

A resolver is handed the partial value typed so far and a context whose `resolvedArguments` are **this prompt's sibling arguments** — which is what makes the phases of _that_ job answerable. It runs with the caller's identity, like any other operation.

The reusable form names a resolver registered once instead of re-wrapping it per prompt:

```ts
export default defineCompletions({
  sources: { "knowify.jobs": completeFromAsync((value, ctx) => jobsApi.search(value, ctx)) },
});

// …and a declaration references it by name:
{ name: "job", required: true, complete: "knowify.jobs" }
```

A string is durable and a function is not, so the two forms part ways at the store: a named ref persists verbatim, while an inline resolver moves to the same sidecar `render` lives in and the record keeps `completeRef` — `prompt:<promptName>:<argName>`, derived. A resolver from `defineCompletion(name, fn)` is both at once, and keeps the name it already has rather than being aliased under a derived one. The record also carries `completeRequires` for a dependent resolver, so a composer reading `prompts/list` can grey out the phase slot until a job is chosen instead of issuing a request that cannot succeed. `get(name)` re-joins the split and hands back what you declared. A restored snapshot keeps the refs and the dependencies but not the functions, exactly as it keeps no `render`.

`definePrompt` (singular) is worth the import here: it types `render`'s `args` from the argument list — required arguments as their value, optional ones as the value or `undefined`, and a schema's inferred output where one is declared. **No schema means the argument is a `string`**, which is MCP's shape on the wire; declare a schema when you want anything else.

Asking for the candidates is `complete`, and it answers three ways because the harness holds only one half of that split:

```ts
const outcome = await session.prompts?.complete({
  name: "tm_change_order_actual_cost",
  argument: { name: "phase", value: "fra" },
  context: { arguments: { job: "Miller Residence" } },
});
// { kind: "resolved", result: { values: [...] } }  — an inline resolver ran
// { kind: "ref", completeRef: "knowify.phases" }   — resolve that name yourself
// { kind: "unavailable" }                          — nothing to ask
```

An inline resolver runs here, with the sibling arguments on its ctx. A **named** ref comes back as a name rather than an answer: this package holds resolvers, it does not own the registry that runs them, so chasing the ref is the caller's hop. An argument with no `complete`, an argument name the prompt does not have, and a restored declaration whose sidecar did not survive all answer `unavailable` — an unknown argument is never an error, matching MCP. An unknown _prompt_ throws.

Like every other completion door, this one is a plain method rather than a command: it fires per keystroke, and one journaled operation per character typed buys nothing. A client does not call it directly — the `completions/complete` wire verb composes both hops, so `session.completions.complete(...)` from a browser resolves an inline resolver and a named source through one call. See [@agentick/completions](../completions).

## Where prompts come from

One option decides it: `hydrate`. A source is a function of the session's context returning the prompts the session opens with. The surface is **deliberately narrower** than the skills equivalent, because a prompt's `render` is a function and not every transport can carry one.

```ts
import {
  composeHydrators,
  hydrateFromModule,
  hydrateFromStaticUrl,
  withPrompts,
} from "@agentick/prompts";

withPrompts({
  hydrate: composeHydrators(
    hydrateFromModule({ specifier: "./prompts/index.js" }), // functions survive
    hydrateFromStaticUrl({ url: "https://registry.internal/prompts.json" }), // template-only
  ),
});
```

| Hydrator                                    | Source               | Carries `render`?                                                                 |
| ------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `hydrateFrom(prompts)`                      | in-memory records    | Yes — same JS module, functions intact                                            |
| `hydrateFromModule({ specifier, picker? })` | dynamic import       | Yes — the one source that carries code across a load boundary                     |
| `hydrateFromStaticUrl({ url, … })`          | JSON manifest        | **No** — a record naming `render` rejects rather than silently losing it          |
| `hydrateFromStore()`                        | the configured store | No — only the serializable slice is durable (see [Store backing](#store-backing)) |
| `composeHydrators(...hydrators)`            | several at once      | Per source; on a duplicate name the LAST one wins                                 |

`hydrateFromModule`'s default picker takes `module.default` (a single record or an array), then a named `module.prompts` export. Pass `picker` for your own convention.

There is no filesystem hydrator here: `.tsx` prompts on disk need a bundler or transform pipeline, which is a framework-binding concern rather than a primitive one.

Anything with that shape works, which is the point. A per-tenant catalog is a function reading the caller's identity:

```ts
withPrompts({ hydrate: (ctx) => catalogFor(ctx.principal) });
```

> [!IMPORTANT]
> What a hydrator returns is a **seed**, not a batch of registrations. It lands in the read surface directly: no `register` operation, no store write. Writing it back would duplicate the catalog on every resume. The `{ template, render }` content _is_ attached, though — a hydrator is in-process code, so its functions are as real as a register's.

A hydrator that throws fails session creation with `PromptsHydrateFailed`. A session that renders against half a catalog is worse than one that doesn't start; catch inside your own hydrator if a degraded start is what you want.

There is no default. Configuring a `store` on its own loads nothing — ask for it with `hydrate: hydrateFromStore()`.

### Growing the library after startup

The source stays attached, so the library isn't frozen at boot:

```ts
const { added, updated, removed } = await session.prompts.reload();

// Or just invoke something that wasn't seeded — a cache miss re-runs the
// source before `PromptNotFound` is raised.
await session.prompts.invoke({ name: "late_prompt", args: { week: "2026-06-28" } });

const decl = await session.prompts.resolve("late_prompt"); // null if the source lacks it
const must = await session.prompts.require("must_exist"); // throws PromptNotFound
```

Unlike the seed at session-open, a reload goes through the ordinary operations — journaled, guard-vetoable, written through to the store. `reload({ pruneMissing: true })` drops entries that vanished from the source; off by default so a runtime `register` isn't clobbered. A library with no source reloads to nothing touched, `pruneMissing` included: the absence of a source isn't a claim that the catalog should be empty.

A miss costs a full source read, because a source produces its whole set. For a catalog large enough to care, put it behind a `store` — the store's query is the targeted read port. Swap the source at runtime with `setHydrator(hydrate)`, or pass `undefined` to detach it; detaching doesn't un-register what the source already produced.

## Configuring the slot

`withPrompts` takes a plan or a live library — two shapes, one type:

```ts
// A plan. Constructed per session, closed at session teardown.
withPrompts({
  store: myDurableStore,
  renderers: [reactPromptRenderer, myDomainRenderer],
  hydrate: hydrateFromModule({ specifier: "./prompts/index.js" }),
});

// A live library — one long-lived instance backing every session.
withPrompts(mySharedPrompts);
```

Name the plan with `definePrompts` when you want to hand it around — a config module exports one, a test imports it and overrides a single slot:

```ts
import { definePrompts, hydrateFrom, hydrateFromModule } from "@agentick/prompts";

// prompts.ts
export default definePrompts({
  store: myDurableStore,
  hydrate: hydrateFromModule({ specifier: "./prompts/index.js" }),
  guards: { invoke: (input) => (isBlocked(input.name) ? { kind: "veto" } : undefined) },
});

// prompts.test.ts — same policy, a fixture source
import production from "./prompts.js";
const underTest = definePrompts({ ...production, hydrate: hydrateFrom(fixtures) });
```

`definePrompts` is identity plus a brand: it returns what you gave it. Nothing is constructed, no store is opened, and no hydrator runs until a session installs it.

**Lifecycle follows ownership.** Given a plan, the extension builds one library per session, seeds it, and closes it at session teardown. Given a live instance, you own the lifecycle: the extension publishes it under the session's `prompts` namespace, never seeds it, and never closes it.

### Policy on the plan

`hooks:` observes and transforms; `guards:` decides. Both name this library's own verbs, with the layer prefix dropped:

```ts
definePrompts({
  hooks: { onAfterRender: (result) => ({ ...result, messages: redact(result.messages) }) },
  guards: {
    invoke: (input) => (isBlocked(input.name) ? { kind: "veto", reason: "blocked" } : undefined),
  },
});
```

App-level policy wraps these: an app guard decides before a plan-level guard is consulted, and an app before-hook runs before a plan-level one. Governance outranks local policy.

## Store backing

A prompt splits along the serialization boundary, and the store holds only one half:

| Slice               | Fields                                         | Where it lives                                |
| ------------------- | ---------------------------------------------- | --------------------------------------------- |
| Serializable record | `name`, `description`, `arguments`, `metadata` | the store                                     |
| Runtime content     | `template`, `render`                           | a harness-local sidecar — **never** the store |

```ts
import { InMemoryPromptStore } from "@agentick/prompts";

withPrompts({ store: new InMemoryPromptStore() }); // the implicit default
```

The type system enforces the split: the store's record type has no `template` or `render` field, so a function reaching durability is a compile error rather than a discipline. `register` and `update` write the record through and re-attach the content to the sidecar; `remove` drops both; every read that hands out a declaration re-joins the two halves.

- `get` / `has` / `list` stay synchronous, served from a view kept in lockstep with the store. Both the sync read surface and the synchronous snapshot export are load-bearing, so the materialized view is required, not incidental.
- Snapshot export drops the content **by construction** — it materializes the record slice directly rather than stripping fields.
- A restored library therefore has declarations without content until you re-register it (or seed from a module source). `invoke` and `render` raise `PromptMissingContent` in the gap.

This is the one real consequence of `hydrateFromStore()`: it brings back the catalog, not the code. Compose it under a module source and last-wins puts the functions back on top:

```ts
withPrompts({
  store: myDurableStore,
  hydrate: composeHydrators(
    hydrateFromStore(), // the durable declaration set
    hydrateFromModule({ specifier: "./prompts/index.js" }), // the content, shadowing by name
  ),
});
```

A durable adapter conforms to the same port. Certify one with `runPromptStoreConformance` from `/testing`.

## Authoring a renderer

```ts
import type { PromptRenderer } from "@agentick/prompts";

const myRenderer: PromptRenderer = {
  name: "my-format",
  handles: (content) => content instanceof MyContentType,
  async render(content, args) {
    return [
      {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: transform(content, args) }],
      },
    ];
  },
};

withPrompts({ renderers: [myRenderer] });
```

First match wins on `handles(content)`. The two native shapes are tried before your renderers, so a plain string never reaches them.

## `invoke` vs `render`

- **`invoke`** renders and appends each message to the session timeline. Use it when the prompt is part of the conversation.
- **`render`** renders and returns `{ description, messages }` without touching the timeline. Use it for an MCP server's `prompts/get`, snapshot tests, doc generators, or programmatic message construction.

### The Effect face

`render` is a declared command, so it has an Effect twin. Reach for it when the caller is already inside an operation and the render must stay in _its_ fiber tree — which is what carries identity into a dynamic prompt:

```ts
Effect.gen(function* () {
  const result = yield* prompts.fx.render({ name, args });
  // The render is a CHILD of the enclosing operation, so the declaration's
  // `render(args, ctx)` sees the caller's identity.
});

await prompts.render({ name, args });
// A fresh root fiber: no ambient trunk to inherit. Correct for a top-level call.
```

## Provenance on the timeline

`invoke` stamps every entry it appends with where that entry came from, so a chat UI can show that the user ran `/quoting_report period:2026-01` instead of rendering the four hundred words the prompt produced:

```ts
await prompts.register({
  declaration: { name: "quoting_report", description: "…", version: "2026-01-14", render },
});
await session.prompts.invoke({ name: "quoting_report", args: { period: "2026-01" } });

// on every entry the invoke appended — `metadata` is an open bag, so a reader
// casts to the typed `MessageSource` seam and keys off the slot:
const source = entry.metadata?.source as MessageSource | undefined;
source?.prompt;
// → { name: "quoting_report", args: { period: "2026-01" }, opId: "op_…", version: "2026-01-14" }
```

`PromptMessageSource` (the payload type) ships from both `@agentick/prompts` and `@agentick/prompts/client`, so a browser types the stamp without pulling the harness. A message with no `prompt` slot is one nobody materialized — the user typed it.

`version` is yours — a semver, a deploy hash, a date, the row id you loaded the declaration from. Nothing computes it and nothing defaults it: set it and the stamp carries it verbatim, omit it and the stamp omits it. `opId` addresses the invoke operation in the journal, so "which prompt produced this message, with which arguments, at which revision" is answerable from the entry alone.

`render` stamps nothing, because nothing entered the timeline. A message your `render` fn already stamped keeps its own `source`: it knows what that particular message is, and the closer authority wins.

## Addressable as resources

Registering a prompt also projects it as a read-only resource at `prompt://<name>` on the session's resource registry — the same registry remote MCP servers project into. The catalog becomes browsable with no bespoke wire work. Default-on; opt out with `exposeAsResources: false`.

Content is served honestly, never a faked render:

- a **static string `template`** is served as `text/markdown` — only when no `render` function shadows it; otherwise
- a **declaration document** (`application/json`) of `{ name, description, arguments }` — the serializable metadata a browser needs to decide whether to invoke. Argument schema validators are dropped; only `{ name, description?, required? }` project.

A function is never serialized, and a render result is never passed off as "the prompt". The resolver reads the live library, and the projected set is live: prompts registered or removed after install project or unregister without polling.

```ts
import { promptUri } from "@agentick/prompts";

await session.resources.read(promptUri("weekly_status"));
```

## Over the wire

Every verb is individually grantable and deny-by-default — an undeclared verb is indistinguishable from an absent method. Wire reads project the serializable record slice; `template` and `render` never cross.

| Method                                                   | Lane  | Result                                                        |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `prompts/list`                                           | read  | `{ prompts, nextCursor? }` — one page of records, name-sorted |
| `prompts/get`                                            | read  | one declaration record, or `null`                             |
| `prompts/render`                                         | read  | `{ description, messages }`                                   |
| `prompts/invoke`                                         | write | render + append to the timeline                               |
| `prompts/register` · `prompts/update` · `prompts/remove` | write | the admin-curation lane                                       |
| `prompts/commands`                                       | read  | the declared verbs with their exposure — the discovery door   |

`prompts/commands` is served by the base, not declared here, and it is how a client asks what this session's prompt surface can do: `await client.session(id).prompts.commands()`. See [@agentick/gateway](../gateway#discovery--two-doors).

`prompts/list` is paged, MCP-shaped: pass the previous reply's `nextCursor` to continue, and its absence means you have the last page. The in-process `list()` is unchanged — a bounded snapshot, no cursor. Pagination is a wire and projection concern; a sync read is bounded by construction and has nothing to page.

### Inbox addressing

The library is addressable at `prompts:{sessionId}` for cross-harness coordination:

```ts
await inbox.send({
  addressedTo: "prompts:s_42",
  type: "prompts:invoke",
  payload: { name: "weekly_status", args: { week: "2026-06-28" } },
});
```

## Errors

```ts
type PromptsError =
  | { _tag: "PromptNotFound"; promptName: string }
  | { _tag: "PromptAlreadyExists"; promptName: string }
  | { _tag: "PromptArgumentMissing"; promptName: string; argument: string }
  | { _tag: "PromptArgumentInvalid"; promptName: string; argument: string; issues: unknown[] }
  | { _tag: "PromptMissingContent"; promptName: string } // neither template nor render
  | { _tag: "PromptRenderFailed"; promptName: string; cause: unknown }
  | { _tag: "PromptsBackendError"; cause: unknown }
  | { _tag: "PromptsHydrateFailed"; cause: unknown }; // genesis threw; session creation fails
```

## API

### `session.prompts`

| Method                                     | Async | Effect                                                          |
| ------------------------------------------ | ----- | --------------------------------------------------------------- |
| `get(name)` / `has(name)`                  | sync  | Read one declaration; existence check                           |
| `list()`                                   | sync  | Every declaration, name-sorted                                  |
| `register({ declaration })`                | async | Create. Throws `PromptAlreadyExists` on a duplicate             |
| `update({ name, declaration })`            | async | Patch fields. Throws `PromptNotFound`                           |
| `remove({ name })`                         | async | Delete. Idempotent                                              |
| `invoke({ name, args? })`                  | async | Render + append to the timeline                                 |
| `render({ name, args? })`                  | async | Render only                                                     |
| `complete({ name, argument, context? })`   | async | Candidates for one argument: `resolved` / `ref` / `unavailable` |
| `reload({ pruneMissing? })`                | async | Re-run the source; returns `{ added, updated, removed }`        |
| `resolve(name)` / `require(name)`          | async | Lookup-on-miss; `null` vs. throw                                |
| `subscribe(name, fn)` / `subscribeAll(fn)` | sync  | Per-prompt or any-mutation notifications                        |

`update` is a shallow patch, and `arguments` replaces wholesale rather than merging element-wise.

Both `invoke` and `render` return `{ description, messages, metadata? }`, where `metadata` is the DECLARATION's own bag copied verbatim. That is deliberate — a render produces messages, and anything it wants to say about _them_ belongs on a message; what a caller holding only a result cannot otherwise reach is what the author attached to the prompt. It is the source MCP's `GetPromptResult._meta` projects from (`metadata.mcp.meta`, the same key `prompts/list` reads), so an MCP Apps `ui://` linkage authored once reaches both wire slots.

### Package exports

| Export                                                                                                 | Purpose                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `withPrompts(config)`                                                                                  | The session extension — a plan or a live library     |
| `definePrompts(options)`                                                                               | Name a plan: identity + brand, inert until install   |
| `definePrompt(declaration)`                                                                            | Name one prompt: `render`'s args typed from the list |
| `promptCompletionRef(prompt, arg)`                                                                     | The derived registry name for an inline resolver     |
| `hydrateFrom` / `hydrateFromModule` / `hydrateFromStaticUrl` / `hydrateFromStore` / `composeHydrators` | The sources                                          |
| `PromptsHarness`                                                                                       | The implementation, for direct construction          |
| `InMemoryPromptStore` / `matchesPromptQuery`                                                           | Bundled store and its name-substring query predicate |
| `promptUri(name)`                                                                                      | Build the `prompt://<name>` resource uri             |
| `isMessageEntryArray` / `stringToSystemMessage`                                                        | The native content handlers, for renderer authors    |

`withPrompts` / `definePrompts` options: `store`, `hydrate`, `renderers`, `exposeAsResources`, `hooks`, `guards`.

### The client handle

```ts
import "@agentick/prompts/client";

const p = client.session(sessionId).prompts;

p.subscribe(() => renderList(p.list()));
await p.render({ name: "weekly_status", args: { week: "2026-06-28" } });
await p.refresh();
```

RPC-backed, not channel-backed: there is no delta channel for prompts, so the read side keeps a local snapshot seeded by an eager `prompts/list` and re-fetches after every mutation. `list()` and `get()` read that snapshot synchronously, which is what lets the handle drop into `useSyncExternalStore`. Only the FIRST page seeds the snapshot; walking cursors is the power-user path, issued against `prompts/list` directly.

The snapshot fills itself: the handle polls once on construction and fires `subscribe` when the answer lands, so the right shape is to bind both — render what `list()` has, re-render on change — and there is nothing to await and no boot-time `refresh()` to issue. `refresh()` is for invalidating a snapshot you already have. A first poll that fails leaves the snapshot empty rather than half-filled; the next mutation's re-fetch or an explicit `refresh()` recovers it.

## Patterns

**React content.** [@agentick/prompts-react](../prompts-react) ships the JSX renderer and `withReactPrompts`, which pre-bakes it.

**The sibling library.** [@agentick/skills](../skills) is the same shape for model-discovered content: a serializable record with no runtime augmentation to lose in transit. Prompts is that floor plus the function sidecar.

**Resources.** [@agentick/resources](../resources) owns the registry `prompt://` uris land in.

**Shapes.** [@agentick/spec](../spec) owns `PromptDeclaration`, the store port, and the error tags.

## Roadmap & known gaps

- **No durable backend ships.** SQLite and a remote registry are planned; today, bring your own store adapter.
- **Content doesn't survive the store.** `hydrateFromStore()` returns declarations without `template` / `render`. Compose it under `hydrateFromModule` to put the code back, or re-register the content yourself.
- **No filesystem source.** `.tsx` prompts need a bundler; a framework binding is the right home for one.
- **No model-facing tools.** Prompts are user-directed, so a `prompt_list` / `prompt_get` pair needs its audience story told before it ships.
- **A named ref is never validated.** An argument may name a completion source nobody bound, and registration does not check — the request answers with no candidates, so a typo looks exactly like an unmounted source.
- **An MCP `prompts/get` render asks the SESSION's user, not the MCP client.** `ctx.elicit` is threaded from the session that owns the harness, and the MCP crossing does not yet publish its own per-connection elicit — so a prompt rendered over MCP that asks reaches the wrong human. The crossing already holds the right `Elicit` and the harness already yields to a crossing-published one; see `TODO(mcp-prompt-elicit)` in `packages/mcp/src/server/harness.ts`.
- **MCP's `completion/complete` does not route through this door yet.** An MCP server's completion still resolves against its own per-server config with its own ctx ([`docs/proposals/v2/completions.md`](../../docs/proposals/v2/completions.md) §7 P3). Closing it needs an in-fiber twin of the door, so the completion parents under the MCP crossing and sees the connection's identity.
- **No transactions and no per-prompt ACL.** Each mutation is its own operation, and all session participants share one library.

## Verified by

- `src/__tests__/harness.spec.ts` — register / update / remove, invoke and render, the sync declaration read, native and custom content dispatch, argument validation, snapshot round-trip, the typed errors, and the declaration's metadata bag reaching the render result verbatim on both `render` and `invoke` while a bare declaration yields a result with no `metadata` key at all.
- `src/__tests__/definition.spec.ts` — `definePrompts` identity, the non-enumerable brand, inertness (no store touch, no hydrator run), the plan-or-instance shapes, and `store` reaching the harness through the one options shape.
- `src/__tests__/genesis.spec.ts` — the seed law (no store write, no `register` operation) with the content sidecar still populated so a seeded prompt renders, typed `PromptsHydrateFailed` including through the extension install, the `ctx.store` / `ctx.principal` / journal-reader facets, no-genesis-on-fork, and the app-wraps-plan ordering for hooks and guards.
- `src/__tests__/hydrators.spec.ts` — each named source, the module picker conventions, the template-only rejection on a URL source carrying `render`, the record-only store read, and `composeHydrators` ordering and last-wins.
- `src/__tests__/source-surface.spec.ts` — `reload` adds/updates/prunes, lookup-on-miss through `invoke` and `render`, `resolve` and `require` on hit and miss, and a source-less harness touching nothing.
- `src/__tests__/store-backing.spec.ts` — the record/sidecar split (the record written without the functions), `update` and `remove` propagation, the source feeding both halves through `reload` and `resolve`, snapshot dropping the functions, store-to-seed restoring records only, plus the store conformance suite against `InMemoryPromptStore`.
- `src/__tests__/projection.spec.ts` — the declaration document for a function-render prompt (function absent, argument schema stripped), a static string template served as `text/markdown`, register-after-install and remove-unregisters, the `exposeAsResources: false` opt-out, and degradation with no resource registry.
- `src/__tests__/completion.spec.ts` — the completion split against the real builders: an inline resolver never reaching the store (JSON round-trip included), the derived `completeRef`, `completeRequires` off a dependent resolver, a named ref copied verbatim and side-caring nothing, the re-join through `get` and `list`, `update` / `remove` / genesis keeping both halves in step, and a wire-delivered `complete` stripped at runtime.
- `src/__tests__/complete.spec.ts` — the completion door against the real builders: an inline resolver running and its bare array folding, prefix-filtering as the user types, `context.arguments` reaching a dependent resolver (gated when a sibling is unfilled, answering when it is not), the minted ctx carrying the session trunk plus the facets and the `AbortSignal`, a `defineCompletion` source resolved inline rather than handed back, a named ref returned verbatim, `unavailable` for a bare argument / an argument the prompt does not have / a restored sidecar-less declaration, `PromptNotFound` for an unknown prompt, a throwing resolver wrapped as `CompletionResolveFailed` with its cause and its derived address, **nothing appended to the journal across four keystrokes**, and the local value-fold agreeing with the canonical one.
- `src/__tests__/define-prompt.type.spec.ts` — `definePrompt`'s inference: required versus optional values, the no-schema-means-string law, a schema's inferred output, no keys for an argument-less prompt, undeclared keys unreadable, the erased result assignable where declarations go, and both forms of `complete` in one argument list.
- `src/__tests__/ctx-spine.spec.ts` — the invoking operation's context reaching `render(args, ctx)`.
- `src/__tests__/provenance.spec.ts` — the stamp on every entry `invoke` appends (name, arguments, and the invoking operation's own id, read off the render context), `version` present only when declared, `render` appending and stamping nothing, existing message metadata merged rather than replaced, a message's own `source` left alone, and a declared version surviving register → get → list → snapshot → import and a silent patch.
- `src/__tests__/render-elicit.spec.ts` — the render's `ctx.elicit`: a directly-injected `Elicit` reaching the declaration through `invoke` and through `render`, the elicited value in the appended entries, an argument the caller supplied never eliciting, the provider re-read after a miss and cached on a hit, the no-source and ctx-free calls landing on the declaration's fallback branch, and an elicit published by the enclosing crossing winning over the session's.
- `packages/app/src/__tests__/prompts-invoke-elicit.spec.tsx` — the same facet through real `createApp` wiring: a render's question raised as a real ask on `session.elicitation` with the prompt's own message, the answer landing in the timeline entries, and a fully-argued invoke asking nothing.
- `src/__tests__/timeline-late-binding.spec.ts` — the append target resolved per invoke: a directly-injected capability unchanged, a provider re-read after a miss so a timeline wired later starts working, a hit cached, and the "nothing is wired" skip warning once instead of silently.
- `packages/app/src/__tests__/prompts-invoke-timeline.spec.tsx` — the same fact through real `createApp` wiring: `invoke` landing stamped entries in the session's own timeline, repeat invokes still landing, and an adopter's `withTimeline(instance)` keeping its name claim and receiving them.
- `src/client/__tests__/prompts-handle.spec.ts` + `session-prompts.spec.ts` — the eager poll notifying subscribers when it lands (so no boot-time `refresh()` is needed) and settling empty on a failed poll that `refresh()` then recovers, each write verb followed by a re-poll, and the zero-argument subscribe contract.
- The in-process transport suite covers the `prompts/list` wire round-trip as records without functions, and `commands/list` enumerating the wire verbs.

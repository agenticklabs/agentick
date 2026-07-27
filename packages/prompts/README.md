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

### Declaration shape

```ts
interface PromptDeclaration {
  name: string;
  description: string;
  arguments?: PromptArgument[];
  template?: unknown; // static content
  render?: (args: Record<string, unknown>, ctx?: OperationCtx) => unknown; // dynamic content
  metadata?: Record<string, unknown>;
}

interface PromptArgument {
  name: string;
  description?: string;
  schema?: StandardSchemaV1; // omitted → no shape check
  required?: boolean; // default false
}
```

Supply `template` or `render`; `render` wins if both are present, and neither raises `PromptMissingContent` at invoke time. Arguments validate against their Standard Schema before content is produced.

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

| Method                                                   | Lane  | Result                            |
| -------------------------------------------------------- | ----- | --------------------------------- |
| `prompts/list`                                           | read  | declaration records, name-sorted  |
| `prompts/get`                                            | read  | one declaration record, or `null` |
| `prompts/render`                                         | read  | `{ description, messages }`       |
| `prompts/invoke`                                         | write | render + append to the timeline   |
| `prompts/register` · `prompts/update` · `prompts/remove` | write | the admin-curation lane           |

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

| Method                                     | Async | Effect                                                   |
| ------------------------------------------ | ----- | -------------------------------------------------------- |
| `get(name)` / `has(name)`                  | sync  | Read one declaration; existence check                    |
| `list()`                                   | sync  | Every declaration, name-sorted                           |
| `register({ declaration })`                | async | Create. Throws `PromptAlreadyExists` on a duplicate      |
| `update({ name, declaration })`            | async | Patch fields. Throws `PromptNotFound`                    |
| `remove({ name })`                         | async | Delete. Idempotent                                       |
| `invoke({ name, args? })`                  | async | Render + append to the timeline                          |
| `render({ name, args? })`                  | async | Render only                                              |
| `reload({ pruneMissing? })`                | async | Re-run the source; returns `{ added, updated, removed }` |
| `resolve(name)` / `require(name)`          | async | Lookup-on-miss; `null` vs. throw                         |
| `subscribe(name, fn)` / `subscribeAll(fn)` | sync  | Per-prompt or any-mutation notifications                 |

`update` is a shallow patch, and `arguments` replaces wholesale rather than merging element-wise.

### Package exports

| Export                                                                                                 | Purpose                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `withPrompts(config)`                                                                                  | The session extension — a plan or a live library     |
| `definePrompts(options)`                                                                               | Name a plan: identity + brand, inert until install   |
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

RPC-backed, not channel-backed: there is no delta channel for prompts, so the read side keeps a local snapshot seeded by an eager `prompts/list` and re-fetches after every mutation. `list()` and `get()` read that snapshot synchronously, which is what lets the handle drop into `useSyncExternalStore`.

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
- **No transactions and no per-prompt ACL.** Each mutation is its own operation, and all session participants share one library.

## Verified by

- `src/__tests__/harness.spec.ts` — register / update / remove, invoke and render, the sync declaration read, native and custom content dispatch, argument validation, snapshot round-trip, and the typed errors.
- `src/__tests__/definition.spec.ts` — `definePrompts` identity, the non-enumerable brand, inertness (no store touch, no hydrator run), the plan-or-instance shapes, and `store` reaching the harness through the one options shape.
- `src/__tests__/genesis.spec.ts` — the seed law (no store write, no `register` operation) with the content sidecar still populated so a seeded prompt renders, typed `PromptsHydrateFailed` including through the extension install, the `ctx.store` / `ctx.principal` / journal-reader facets, no-genesis-on-fork, and the app-wraps-plan ordering for hooks and guards.
- `src/__tests__/hydrators.spec.ts` — each named source, the module picker conventions, the template-only rejection on a URL source carrying `render`, the record-only store read, and `composeHydrators` ordering and last-wins.
- `src/__tests__/source-surface.spec.ts` — `reload` adds/updates/prunes, lookup-on-miss through `invoke` and `render`, `resolve` and `require` on hit and miss, and a source-less harness touching nothing.
- `src/__tests__/store-backing.spec.ts` — the record/sidecar split (the record written without the functions), `update` and `remove` propagation, the source feeding both halves through `reload` and `resolve`, snapshot dropping the functions, store-to-seed restoring records only, plus the store conformance suite against `InMemoryPromptStore`.
- `src/__tests__/projection.spec.ts` — the declaration document for a function-render prompt (function absent, argument schema stripped), a static string template served as `text/markdown`, register-after-install and remove-unregisters, the `exposeAsResources: false` opt-out, and degradation with no resource registry.
- `src/__tests__/ctx-spine.spec.ts` — the invoking operation's context reaching `render(args, ctx)`.
- `src/client/__tests__/prompts-handle.spec.ts` + `session-prompts.spec.ts` — the eager poll, each write verb followed by a re-poll, and the zero-argument subscribe contract.
- The in-process transport suite covers the `prompts/list` wire round-trip as records without functions, and `commands/list` enumerating the wire verbs.

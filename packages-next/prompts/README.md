# @agentick/prompts-next

`PromptsHarness` — durable parameterized prompt library. Adopters register prompts with names, descriptions, optional arguments, and content; agents (or admin tooling) invoke them by name with arguments to produce a sequence of role-bearing messages — either queued onto the session timeline (`invoke`) or returned for caller-managed handling (`get`).

Mirrors MCP's `prompts/*` shape per [ADR 23](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md) so an MCP server harness can project our prompts onto the wire without translation.

> Pre-1.0. Shape 1 harness per [ADR 32](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md): substrate participation, audit envelopes, swappable backend, snapshot/restore.

## Content shapes

The core handles two content shapes natively. Anything else flows through a registered `PromptRenderer`.

| Content type                               | Where rendered                                               | Output                                            |
| ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| `string`                                   | core                                                         | single `system`-role `MessageEntry`               |
| `readonly MessageEntry[]`                  | core                                                         | passthrough — used as-is                          |
| `ReactNode`                                | [`@agentick/prompts-react-next`](../prompts-react) (binding) | compiled via `renderTemplate` to `MessageEntry[]` |
| Custom (Solid / Angular / domain-specific) | adopter-registered `PromptRenderer`                          | adopter-defined                                   |

## Quick start — text-only (no framework)

```ts
import { createApp } from "@agentick/app-next";
import { withPrompts } from "@agentick/prompts-next";

const app = createApp(<Agent />, {
  model: openai("gpt-5"),
  extensions: [
    withPrompts({
      initial: [
        {
          declaration: {
            name: "summarize_doc",
            description: "Summarize a document by ID.",
            arguments: [{ name: "docId", required: true }],
            render: (args) => `Summarize the document at ${args.docId}.`,
          },
        },
      ],
    }),
  ],
});

// Inside a session:
const result = await session.prompts.invoke({ name: "summarize_doc", args: { docId: "42" } });
// result.messages: [{ kind: "message", role: "system", content: [{ type: "text", text: "Summarize the document at 42." }] }]
// AND the message is queued onto the session timeline.
```

## Quick start — React JSX

```ts
import { withReactPrompts } from "@agentick/prompts-react-next";

withReactPrompts({
  initial: [
    {
      declaration: {
        name: "weekly_status",
        description: "Weekly status template",
        arguments: [{ name: "week", required: true }],
        render: (args) => (
          <>
            <message role="system">You are a status report assistant.</message>
            <message role="user">Generate the weekly status report for week {args.week as string}.</message>
          </>
        ),
      },
    },
  ],
}),
```

## Mixing renderers + loaders in one library

Drop to the full `withPrompts` surface: supply multiple renderers and multiple loaders. Each renderer claims the content shapes it `handles`; each loader sources a slice of the library.

```ts
import { withPrompts } from "@agentick/prompts-next";
import { fromArray, fromModule } from "@agentick/prompts-next/loaders";
import { reactPromptRenderer } from "@agentick/prompts-react-next";

withPrompts({
  renderers: [reactPromptRenderer, myCustomRenderer], // React JSX + a domain renderer
  loaders: [
    fromArray(bundledTextPrompts), // literal — functions intact
    fromModule({ specifier: "./prompts/react.js" }), // dynamic import — compiled .tsx
  ],
});
```

Each prompt's `render(args)` returns the content shape its renderer handles. The harness dispatches at invoke time via `renderer.handles(content)`. On-disk directory loaders (a `fromDirectory` over `.tsx`) need a bundler / transform pipeline and are a framework-binding concern — see the [Loaders](#loaders) note below.

## The `withPrompts` slot — three accepted shapes

Per [ADR 42](../../docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md) `withPrompts` accepts a trichotomic slot — array, instance, or config object. All three collapse to the same internal `WithPromptsOptions` shape.

```ts
import { withPrompts } from "@agentick/prompts-next";

// Form A — array shorthand (sugar for { initial })
withPrompts([{ declaration: { name: "x", description: "x", template: "..." } }]);

// Form B — instance shorthand. Adopter brings a long-lived
// `Prompts` source that backs EVERY session. The extension does
// NOT construct or close it.
withPrompts(mySharedPromptsHarness);

// Form C — config object
withPrompts({
  initial: [/* PromptsRegisterInput[] */],
  loaders: [fromArray([...]), fromModule({ specifier: "./prompts.js" })],
  renderers: [reactPromptRenderer],

  // OR — adopter-supplied instance (mutually exclusive with
  // initial / loaders / renderers; the adopter's instance brings
  // its own renderer set)
  use: mySharedPromptsHarness,
});
```

**Lifecycle ownership.** Forms A / C-with-`initial`/`loaders` → extension constructs a per-session harness and closes it on session teardown. Forms B / C-with-`use:` → adopter owns the lifecycle; the extension publishes the same instance under the session's `prompts` namespace but never closes it.

## Store backing — the definition-library archetype's _augmented instance_

The harness is **store-derived and store-persisted** ([data-layer plan §6-C](../../docs/proposals/v2/data-layer-plan.md)). Prompts is the archetype's first **augmented instance**: it is [`@agentick/skills-next`](../skills)'s pure floor **PLUS a non-serializable runtime augmentation**. A `PromptDeclaration` splits along the serialization boundary:

| Slice                       | Fields                                       | Where it lives                                                     |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| **Serializable record**     | `name`, `description`, `arguments`, `metadata` | the `PromptStore` (= `CollectionStore<PromptDeclarationRecord, PromptStoreQuery>`) — this is exactly `PromptsSnapshotEntry` |
| **Runtime augmentation**    | `template`, `render`                         | a parallel harness-local **sidecar** `Map<name, { template, render }>` — NEVER the store |

```ts
import { InMemoryPromptStore } from "@agentick/prompts-next";
// The PromptStore / PromptStoreQuery ports live in @agentick/spec-next.

withPrompts({ store: new InMemoryPromptStore() }); // the bundled default (implicit)
```

The split **composes** rather than being hand-rolled: an eager `View<PromptDeclarationRecord>` (the same sync-cache-over-async-store primitive `skills` and `knobs` use, driven through the `Store` `query`/`mutate` seam) holds the record slice, and the harness-owned sidecar holds the fns. The `View` is agnostic to the sidecar (cleared on import, untouched on hydrate). The two are re-joined into a full `PromptDeclaration` by a single private `declarationOf(name)` combine at every read that hands out a declaration.

- **`register` / `update`** write the record through the view (`store.mutate`) **and** re-attach `{ template, render }` to the sidecar. **`remove`** drops both.
- **`render`/`template` can NEVER reach the store** — the `PromptDeclarationRecord` type makes that a _compile-time_ guarantee, not a discipline. (Contrast tasks' hand-rolled `LiveTask` cache, where the record and the live handles are read together at every site AND the snapshot includes the record slice, so splitting would only distort. Prompts is the opposite: `exportSnapshot` and the store want records _without_ the fns, so the split earns its keep.)
- **Loaders stay _sources_ that FEED the store + sidecar** — not dissolved into them. `reload()` runs each loader's `load()` and registers the results; `resolve(name)` (lookup-on-miss) asks each loader's `lookup()` then registers the hit. `fromModule`/`fromArray` carry `render` fns (→ sidecar); `fromStaticUrl` is template-only.
- **`getDeclaration` / `has` / `list` are synchronous**, served from the eager projection (write-through on mutation, `hydrate()` on resume). The projection is required, not incidental — the sync `exportSnapshot()` (`SnapshotCapable`, captured synchronously by the reconciler) and the sync read surface are both load-bearing sync callers, so a synchronous materialized view is mandatory.
- **`exportSnapshot` / `importSnapshot` coexist** with the store today (a Phase-4 manifest sweep makes the store the sole snapshot authority later). `exportSnapshot` materializes the projection records directly — the augmentation is dropped **by construction**, not by per-field stripping. A durable adapter (Postgres, a filesystem source) conforms to the same `PromptStore` port.

## API — `PromptsHandle` on `session.prompts`

| Method                          | Async? | Effect                                                   |
| ------------------------------- | ------ | -------------------------------------------------------- |
| `getDeclaration(name)`          | sync   | Read a declaration                                       |
| `has(name)`                     | sync   | Existence check                                          |
| `list()`                        | sync   | All declarations (sorted by name)                        |
| `register({ declaration })`     | async  | Create. Throws `PromptAlreadyExists` on duplicate        |
| `update({ name, declaration })` | async  | Partial update. Throws `PromptNotFound` if missing       |
| `remove({ name })`              | async  | Delete. Idempotent                                       |
| `invoke({ name, args? })`       | async  | Render + queue to timeline; returns `PromptsGetResult`   |
| `get({ name, args? })`          | async  | Render only; returns `PromptsGetResult` without queueing |
| `subscribe(name, listener)`     | sync   | Listen for a specific prompt's mutations                 |
| `subscribeAll(listener)`        | sync   | Listen for any mutation                                  |

### `invoke` vs `get`

- **`invoke`** — renders + queues each message onto `bridges.timeline.queue` (same path explicit user input takes). On the next `session.send`, queued messages drain into the durable timeline before the first tick. Use when the prompt is part of the conversation.
- **`get`** — renders without queueing. Returns `{ description, messages }`. Use for MCP server `prompts/get`, snapshot tests, doc generators, programmatic message construction.

### Typed errors

```ts
type PromptsError =
  | { _tag: "PromptNotFound"; name }
  | { _tag: "PromptAlreadyExists"; name }
  | { _tag: "PromptArgumentMissing"; name; argument }
  | { _tag: "PromptArgumentInvalid"; name; argument; issues }
  | { _tag: "PromptMissingContent"; name }
  | { _tag: "PromptRenderFailed"; name; cause }
  | { _tag: "PromptsBackendError"; cause };
```

## `PromptDeclaration` shape

```ts
interface PromptDeclaration {
  name: string;
  description: string;
  arguments?: PromptArgument[];
  template?: unknown; // static; framework-typed at adapter layer
  render?: (args: Record<string, unknown>) => unknown; // dynamic
  metadata?: Record<string, unknown>;
}

interface PromptArgument {
  name: string;
  description?: string;
  schema?: StandardSchemaV1; // optional — when omitted, no shape check
  required?: boolean; // default false
}
```

Adopter supplies EITHER `template` (static; args unused) OR `render` (dynamic; receives validated args). `render` wins if both are present. Neither → `PromptMissingContent` at invoke time.

## Authoring `PromptRenderer`

```ts
import type { PromptRenderer } from "@agentick/prompts-next";
import type { MessageEntry } from "@agentick/spec-next";

const myRenderer: PromptRenderer = {
  name: "my-format",
  handles: (content) => content instanceof MyContentType,
  async render(content, args) {
    // ...transform content + args into MessageEntry[]
    return [{ kind: "message", role: "user", content: [{ type: "text", text: "..." }] }];
  },
};
```

Register in `withPrompts({ renderers: [myRenderer] })`. First-match-wins.

## Inbox addressing

The harness is inbox-addressable at `prompts:{scopeId}`. Routing keys: `prompts:register`, `prompts:update`, `prompts:remove`, `prompts:invoke`. Adopters needing cross-harness coordination:

```ts
await inbox.send({
  addressedTo: "prompts:s_42",
  type: "prompts:invoke",
  payload: { name: "weekly_status", args: { week: "2026-06-28" } },
});
```

## Snapshot / restore

`exportSnapshot()` returns `Record<string, PromptsSnapshotEntry>` carrying `name + description + arguments + metadata` — exactly the store's `PromptDeclarationRecord` slice, materialized straight from the projection. **The `template` and `render` fields are NOT serializable** (they live in the sidecar, never the store) — adopters reload content via `withPrompts({ initial })` or direct `register` calls when restoring. `importSnapshot` writes the records back through the projection and **clears the sidecar**; `hydrate()` (the future Phase-4 resume seam) pulls records from a durable store into the projection, likewise leaving the sidecar empty.

```ts
const snapshot = harness.exportSnapshot();
// later:
const fresh = new PromptsHarness(...);
fresh.importSnapshot(snapshot);
// fresh.list() returns the declarations sans content; invoke/get throws
// PromptMissingContent until adopter re-registers content
```

## Loaders

`withPrompts({ loaders })` accepts a `PromptLoader[]` for sourcing the initial library. The public surface is **deliberately narrower** than skills loaders: a prompt's `render(args)` is a function, and functions don't survive serialization.

```ts
import { withPrompts } from "@agentick/prompts-next";
import { fromArray, fromModule, fromStaticUrl } from "@agentick/prompts-next/loaders";

withPrompts({
  loaders: [
    fromArray(bundled),                                         // literal — functions OK
    fromModule({ specifier: "./my-prompts.js" }),               // dynamic import — functions OK
    fromStaticUrl({ url: "https://registry/prompts.json" }),    // template-only — throws if URL serves a `render` field
  ],
}),
```

| Factory                              | Source         | Carries `render`?                                                                                                |
| ------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `fromArray(prompts)`                 | in-memory      | yes — same JS module, functions intact                                                                           |
| `fromModule({ specifier, picker? })` | dynamic import | yes — picker defaults to `module.default` (single or array) then named `module.prompts`                          |
| `fromStaticUrl({ url, ... })`        | JSON manifest  | **no** — load fails if any returned prompt names a `render` field; adopters use `fromModule` for dynamic prompts |

No `fromFile` / `fromDirectory` here — JSX `.tsx` files on disk need a bundler / transform pipeline. Framework bindings can supply their own filesystem factories (e.g., a future `@agentick/prompts-react-next/loaders/node`).

### Dynamic — post-startup `reload()` + lookup-on-miss

Loaders are retained on the harness, so the library can grow after session boot:

```ts
// Re-pull from all loaders:
const { added, updated, removed } = await session.prompts.reload();

// Or just invoke a prompt that wasn't loaded yet — the harness asks
// each loader on cache miss before throwing PromptNotFound:
await session.prompts.invoke({ name: "late_prompt", args: { ... } });
// First call walks loaders, registers, then invokes. Subsequent calls
// hit cache.

// Explicit one-name resolve (no invoke):
const decl = await session.prompts.resolve("late_prompt");

// Throw-on-miss variant for must-exist contracts:
const decl = await session.prompts.require("must_exist");
// → throws { _tag: "PromptNotFound", name: "must_exist" } if no source has it.
```

`reload({ pruneMissing: true })` removes entries that have disappeared from sources — off by default so a runtime `harness.register(...)` isn't clobbered. The lookup-on-miss path is transparent in `invoke()` / `get()`; call `resolve()` directly when you want the declaration without rendering. Loaders may implement an optional `lookup(name)` for fast-path resolution; the built-in `fromX` factories do.

## Status & roadmap

**Shipped:**

- `PromptsHarness` reference impl (in-memory, journal-backed)
- `withPrompts` session-extension factory (accepts `loaders`)
- `PromptLoader[]` — `fromArray` / `fromModule` / `fromStaticUrl` on the `/loaders` subpath
- `PromptRenderer` interface + native handlers (`string`, `MessageEntry[]`)
- Argument validation via Standard-Schema
- Module augmentation: `session.prompts` typed via `PromptsHandle`
- Store backing — `PromptStore` port (spec-next), bundled `InMemoryPromptStore` (record slice only), `store` slot on `withPrompts`; record/sidecar split via `View` + augmentation `Map`
- Conformance suite — `runPromptStoreConformance` (store)

**Planned:**

- SQLite / remote backend impls
- `MCP server harness` integration (#171) — projects our prompts onto MCP `prompts/list` + `prompts/get`

**Known gaps:**

- No transaction support across multi-prompt mutations
- No per-prompt ACL (all session participants share one library)
- `update` is partial-shallow; nested metadata merge is intentional but `arguments` array replace-not-merge (full-replace semantics for the array as a whole)

## Verified by

- `src/__tests__/harness.spec.ts` — full surface coverage (register/update/remove, invoke + get, native + custom content dispatch, argument validation, snapshot round-trip, typed errors)
- `src/__tests__/store-backing.spec.ts` — the record/sidecar split: record written to the store WITHOUT the fns, `update`/`remove` propagation, loaders (`reload` / `resolve`) feed store + sidecar, `invoke`/`get` combine the two halves, `exportSnapshot` drops fns, `hydrate()` restores records-only, plus `runPromptStoreConformance` against `InMemoryPromptStore`

## See also

- [Spec — `PromptsHarnessProtocol`](../spec/src/protocol/prompts-harness.ts)
- [`@agentick/prompts-react-next`](../prompts-react) — React content renderer
- [ADR 23 — MCP as harness](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md)
- [ADR 32 — Extension shape spectrum](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md)
- [`@agentick/skills-next`](../skills) — sibling shape: durable library, same Shape 1 pattern

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

## Mixing frameworks in one library

Drop to the full `withPrompts` surface; supply multiple renderers + multiple loaders:

```ts
withPrompts({
  renderers: [reactPromptRenderer, angularPromptRenderer],
  loaders: [
    fromDirectory("./prompts/text/"), // markdown — framework-agnostic
    fromReactDirectory("./prompts/react/"), // compiled .tsx
    fromAngularDirectory("./prompts/angular/"), // future
  ],
});
```

Each prompt's `render(args)` returns the content shape its renderer handles. The harness dispatches at invoke time via `renderer.handles(content)`.

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
import type { PromptRenderer, MessageEntry } from "@agentick/prompts-next";

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

`exportSnapshot()` returns `Record<string, PromptsSnapshotEntry>` carrying `name + description + arguments + metadata`. **The `template` and `render` fields are NOT serializable** — adopters reload content via `withPrompts({ initial })` or direct `register` calls when restoring.

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

**Planned:**

- SQLite / remote backend impls
- `MCP server harness` integration (#171) — projects our prompts onto MCP `prompts/list` + `prompts/get`

**Known gaps:**

- No transaction support across multi-prompt mutations
- No per-prompt ACL (all session participants share one library)
- `update` is partial-shallow; nested metadata merge is intentional but `arguments` array replace-not-merge (full-replace semantics for the array as a whole)

## Verified by

- `src/__tests__/harness.spec.ts` — full surface coverage (register/update/remove, invoke + get, native + custom content dispatch, argument validation, snapshot round-trip, typed errors)

## See also

- [Spec — `PromptsHarnessProtocol`](../spec/src/protocol/prompts-harness.ts)
- [`@agentick/prompts-react-next`](../prompts-react) — React content renderer
- [ADR 23 — MCP as harness](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md)
- [ADR 32 — Extension shape spectrum](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md)
- [`@agentick/skills-next`](../skills) — sibling shape: durable library, same Shape 1 pattern

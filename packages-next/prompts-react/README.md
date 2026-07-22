# @agentick/prompts-react-next

React binding for [`@agentick/prompts-next`](../prompts). Lets adopters author prompts as React JSX (`<message>`, `<section>`, `<H1>`, `<List>`, `useData`, …) and have them render to `MessageEntry[]` at invoke time.

> Pre-1.0. Pair this with `@agentick/prompts-next` (core) and `@agentick/compiler-react-next` (provides `compileTemplate`).

## Quick start

```tsx
import { createApp } from "@agentick/app-next";
import { withReactPrompts } from "@agentick/prompts-react-next";

const app = createApp(<Agent />, {
  model: openai("gpt-5"),
  extensions: [
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
                <message role="user">
                  Generate the weekly status report for week {String(args.week)}.
                </message>
              </>
            ),
          },
        },
      ],
    }),
  ],
});

// At runtime:
await session.prompts.invoke({
  name: "weekly_status",
  args: { week: "2026-06-28" },
});
// → both messages enter the timeline ahead of the next send.
```

## How JSX projects to `MessageEntry[]`

The renderer calls `compileTemplate(node)` and walks the resulting IR's context entries:

| Authored JSX                              | Projected entry                                              |
| ----------------------------------------- | ------------------------------------------------------------ |
| `<message role="...">...</message>`       | passthrough `MessageEntry` (role preserved)                  |
| `<section title="..."><p>…</p></section>` | absorbed into the running system-message buffer              |
| Loose text / headings / lists             | absorbed into the running system-message buffer              |
| Section's `title` prop                    | leading `# title` text block in that buffered system message |

Explicit `<message>` JSX **flushes** the buffered system message, so authoring order is preserved on the wire. Two consecutive sections concatenate into a single system message whose content blocks are the parts.

### Why "loose stuff goes to system"

The compiler IR has only two top-level kinds: `MessageEntry` (role-bearing) and `SectionEntry` (structured context). For a prompt, the natural projection is:

- An explicit `<message>` says "this is a turn." Honor it.
- Anything else is grounding context the model should see ambient, which maps cleanly to a `system` message.

This is the v1-equivalent of how regular Agentick agents handle non-message content — folded into the system prompt.

## API

```ts
import {
  reactPromptRenderer, // singleton PromptRenderer
  createReactPromptRenderer, // factory — opts: { compile, handles }
  withReactPrompts, // SessionExtension factory (sugar over withPrompts)
} from "@agentick/prompts-react-next";
```

`withReactPrompts(opts)` is exactly `withPrompts({ ...opts, renderers: [reactPromptRenderer, ...(opts.extraRenderers ?? [])] })`. Use the core `withPrompts` directly if you need to combine multiple framework renderers:

```ts
import { withPrompts } from "@agentick/prompts-next";
import { reactPromptRenderer } from "@agentick/prompts-react-next";
// import { angularPromptRenderer } from "@agentick/prompts-angular-next"; // hypothetical

withPrompts({
  renderers: [reactPromptRenderer /*, angularPromptRenderer*/],
  initial: [...],
});
```

`createReactPromptRenderer({ compile, handles })`:

- `compile?: CompileTemplateOptions` — registry / `defaultFormatter` / `maxIterations` passed through to `compileTemplate`.
- `handles?: (content) => boolean` — narrow the predicate when sharing a registry with non-React renderers that also accept objects. Defaults to "anything React would accept as a child".

## Authoring patterns

**Static prompt (text only):**

```ts
{ name: "greet", description: "Greet", template: "Hello there." }
```

The core handles the string — no React needed.

**Dynamic JSX prompt:**

```tsx
{
  name: "summarize",
  description: "Summarize a document",
  arguments: [{ name: "docId", required: true }],
  render: (args) => <message role="user">Summarize doc {String(args.docId)}.</message>,
}
```

**Section + message (grounding + turn):**

```tsx
{
  name: "qa",
  description: "Answer a question with grounding",
  arguments: [{ name: "q", required: true }],
  render: (args) => (
    <>
      <section id="sys" title="System">You are a careful answerer.</section>
      <message role="user">{String(args.q)}</message>
    </>
  ),
}
```

**`useData` + suspends:**

The renderer awaits `useData` suspends to completion (it's `compileTemplate` under the hood), so async data lookups are first-class. Same iteration cap (default 10) applies.

## Verified by

- `src/__tests__/renderer.spec.tsx` — JSX → MessageEntry[] projection (section/message/title/handles predicate), direct `render()` API + end-to-end `PromptsHarness` integration.

## Status & roadmap

**Shipped:**

- `reactPromptRenderer` + `createReactPromptRenderer`
- `withReactPrompts` convenience extension
- JSX → MessageEntry[] projection (passthrough + system-message buffering)

**Planned:**

- **React-specific loaders** (#247) — `fromReactModule` / `fromReactDirectory` for filesystem-backed prompt libraries
- Adapter for v2 semantic components (`<H1>`/`<List>`/...) → richer content blocks beyond plain text

**Known gaps:**

- Loose content always projects to `system` role. If an adopter wants a different default role (e.g., loose text → user), they currently need to wrap each block in `<message>` explicitly.
- Section ordering is preserved but the `id` field on sections is dropped during projection (it has no analogue in the wire `MessageEntry`).

## See also

- [`@agentick/prompts-next`](../prompts) — core PromptsHarness + `withPrompts`
- [`@agentick/compiler-react-next`](../compiler-react) — provides `compileTemplate` and the JSX runtime
- [ADR 32 — Extension shape spectrum](../../docs/proposals/v2/blueprint/32-extension-shape-spectrum.md)
- [ADR 23 — MCP as harness](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md)

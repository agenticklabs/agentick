# @agentick/prompts-react

The React surface over [@agentick/prompts](../prompts). Author a durable,
parameterized prompt as JSX — `<System>`, `<User>`, `<Section>`, `useData` — and
it renders to `MessageEntry[]` at invoke time.

The core already handles a `string` template and a literal `MessageEntry[]`.
This package contributes the renderer that handles a `ReactNode`, so a prompt
body can be a component instead of a template string.

## Install

```bash
npm install @agentick/prompts-react
```

Peers: `react` ^19, plus [@agentick/prompts](../prompts) and
[@agentick/compiler-react](../compiler-react) (which owns `compileTemplate` and
the JSX components).

## Quick start

`withReactPrompts()` is `withPrompts` with the React renderer pre-baked. Hand it
your prompt library; invoke a prompt by name.

```tsx
import { createApp } from "@agentick/app/react";
import { Section, System, User } from "@agentick/compiler-react";
import { hydrateFrom } from "@agentick/prompts";
import { withReactPrompts } from "@agentick/prompts-react";

const app = await createApp(<Agent />, {
  model,
  extensions: [
    withReactPrompts({
      hydrate: hydrateFrom([
        {
          declaration: {
            name: "weekly_status",
            description: "Draft the weekly status report",
            arguments: [
              { name: "week", required: true },
              { name: "team", required: false },
            ],
            // The prompt body is a component. `args` are already validated.
            render: (args) => (
              <>
                <System>You write terse, factual status reports.</System>
                <Section id="format" title="Format">
                  Three sections, in order: Shipped, In flight, Blocked.
                </Section>
                <User>
                  Draft the report for week {String(args.week)}
                  {args.team ? ` (team: ${String(args.team)})` : ""}.
                </User>
              </>
            ),
          },
        },
      ]),
    }),
  ],
});

const session = await app.createSession({});
// `session.prompts` appears because the extension is installed — install-to-appear,
// so it is optional on the type.
await session.prompts?.invoke({ name: "weekly_status", args: { week: "2026-06-28" } });
// → the rendered messages land on the timeline, ahead of the next send.
await session.send({ messages: [] });
```

`invoke` renders **and** queues onto the timeline. `render` does the same
compile and hands the messages back without queueing — the read-only door for a
UI preview or a wire projection.

```ts
declare const prompts: import("@agentick/prompts").PromptsHandle;

const { messages } = await prompts.render({
  name: "weekly_status",
  args: { week: "2026-06-28" },
});
console.log(messages.map((m) => m.role)); // ["system", "user"]
```

## Composing renderers

`withReactPrompts` is a convenience, not the mechanism. When the library spans
frameworks, or when the renderer order needs to be explicit, use the core
extension and pass renderers yourself:

```ts
import { withPrompts } from "@agentick/prompts";
import { reactPromptRenderer } from "@agentick/prompts-react";

const extension = withPrompts({
  renderers: [reactPromptRenderer /*, someOtherFrameworkRenderer */],
});
```

Dispatch is first-match-wins on each renderer's `handles(content)` predicate.
The React predicate is deliberately wide — it accepts anything React would take
as a child (element, fragment, array, string, number) — so put narrower
renderers first, or narrow this one:

```ts
import { createReactPromptRenderer } from "@agentick/prompts-react";

const renderer = createReactPromptRenderer({
  // Only claim real elements; leave plain objects to a sibling renderer.
  handles: (content) => typeof content === "object" && content !== null && "$$typeof" in content,
  // Anything `compileTemplate` accepts: a custom intrinsic registry, a default
  // formatter, an iteration cap.
  compile: { maxIterations: 20 },
});
```

`withReactPrompts` also takes `extraRenderers` when you want the React renderer
first and your own after it.

## How JSX projects to `MessageEntry[]`

The renderer compiles the node with `compileTemplate`, then walks the IR's
context entries. There are only two entry kinds, so the projection is two rules.

| Authored JSX                        | Projected                                     |
| ----------------------------------- | --------------------------------------------- |
| `<System>` / `<User>` / `<Message>` | Passthrough `MessageEntry`, role preserved    |
| `<Section>` and loose text          | Buffered into a running `system`-role message |
| A section's `title` prop            | A leading `# title` text block in that buffer |

An explicit message **flushes** the buffer, so authoring order survives.
Consecutive sections concatenate into one system message whose content blocks
are the parts.

The rule behind it: an explicit `<message>` says "this is a turn" — honor it.
Anything else is ambient grounding, which maps to `system`. That is the same
projection ordinary agents get for non-message content.

## Async data in a prompt body

The renderer is `compileTemplate` underneath, which renders until stable — so
`useData` suspends resolve before the messages come out.

```tsx
import { useData } from "@agentick/compiler-react";
import { User } from "@agentick/compiler-react";

declare function fetchTickets(sprint: string): Promise<{ id: string; title: string }[]>;

function SprintReview({ sprint }: { sprint: string }) {
  const tickets = useData(`tickets:${sprint}`, () => fetchTickets(sprint));
  return (
    <User>
      Review these {tickets.length} tickets: {tickets.map((t) => t.id).join(", ")}
    </User>
  );
}

const declaration = {
  name: "sprint_review",
  description: "Review a sprint's tickets",
  arguments: [{ name: "sprint", required: true }],
  render: (args: Record<string, unknown>) => <SprintReview sprint={String(args.sprint)} />,
};
```

> [!IMPORTANT]
> `compileTemplate` mounts a **minimal** bridge set — the data bridge for
> `useData`, stubs for loop and session. Knob, state, and timeline bridges are
> absent, so `useKnob` / `useTimeline` and a `createTool` `<Tool>` do not work
> inside a prompt body. Those belong in the agent tree, which the full compiler
> renders.

## Reaching a model

Two hops, and neither is bespoke. A declaration's `render(args, ctx)` produces
the node; the renderer projects it to `MessageEntry[]`; `invoke` appends those
onto the timeline; the next send re-renders the timeline into context. Nothing
about the JSX crosses a boundary — only the messages it produced.

`ctx` is the invoking operation's context, so a prompt can render per-principal
content:

```tsx
import { User } from "@agentick/compiler-react";
import type { OperationCtx, PromptDeclaration } from "@agentick/spec";

// `ctx.user` is an empty seed — augment it with whatever your boundary stamps.
declare module "@agentick/spec" {
  interface RuntimeContextUser {
    readonly userId?: string;
  }
}

const myOpenItems: PromptDeclaration = {
  name: "my_open_items",
  description: "List the caller's open items",
  render: (_args: Readonly<Record<string, unknown>>, ctx?: OperationCtx) => (
    <User>List open items for {ctx?.user?.userId ?? "the current user"}.</User>
  ),
};
```

> [!NOTE]
> `ctx` reaches the declaration's `render`, not the component tree — the
> renderer's own signature is `(content, args)`. Read what you need off `ctx`
> at the top and pass it down as props.

## Reaching an MCP client

An MCP server projects a prompt catalog over `prompts/list` and `prompts/get`.
The render happens server-side, so a JSX body works over the wire — a function
is never serialized, and only the resulting messages travel.

That requires the server to project a source that **has** the React renderer,
which means building the source yourself and handing over the live instance:

```ts
import { PromptsHarness } from "@agentick/prompts";
import { reactPromptRenderer } from "@agentick/prompts-react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

declare const declaration: import("@agentick/spec").PromptDeclaration;

// Build the source yourself so it carries the React renderer …
const prompts = new PromptsHarness(
  "mcp:prompts",
  new MemoryJournal({ capacity: 1024 }),
  new LocalEventBus(),
  new LocalInbox(),
  { renderers: [reactPromptRenderer] },
);
await prompts.ready;
await prompts.register({ declaration });

// … then hand the live instance to the MCP server's prompts slot:
//   { name: "status-prompts", transports: [stdioTransport()], prompts }
```

> [!WARNING]
> A form that lets the MCP server build the source itself gives you a source with
> **no renderers**, and a JSX-bodied prompt registered that way fails to render.
> Build the source, wire `reactPromptRenderer`, and pass the live instance.

`withPrompts` also projects each prompt as a read-only `prompt://<name>`
resource by default. Content is served honestly: a string `template` becomes
`text/markdown`, while a `render` function becomes a
`{ name, description, arguments }` declaration document — a JSX body is never
faked into a rendered result on that surface. Pass
`exposeAsResources: false` to keep prompts off it.

## API

| Export                                | Purpose                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `reactPromptRenderer`                 | The default-configured `PromptRenderer`. Enough for most adopters.    |
| `createReactPromptRenderer(options?)` | Same renderer, configured: `compile`, `handles`                       |
| `withReactPrompts(options?)`          | `SessionExtension` — `withPrompts` with the React renderer pre-baked  |
| `ReactPromptRendererOptions` (type)   | `compile?: CompileTemplateOptions` · `handles?: (content) => boolean` |
| `WithReactPromptsOptions` (type)      | `WithPromptsOptions` minus `renderers`, plus `extraRenderers`         |

`withReactPrompts` forwards every other `withPrompts` option: `store` ·
`hydrate` · `exposeAsResources` · `hooks` · `guards`.

There are no components or hooks in this package. The JSX vocabulary is
[@agentick/compiler-react](../compiler-react)'s; this package only teaches
Prompts how to compile it.

## Patterns

**The catalog and its verbs.** [@agentick/prompts](../prompts) owns
`session.prompts` — `register` / `update` / `remove` / `list` / `get` /
`resolve` / `require` / `invoke` / `render` / `reload` — plus the sources and the
`prompt://` projection. Everything here is content-shape plumbing beneath it.

**The JSX vocabulary.** [@agentick/compiler-react](../compiler-react) owns
`compileTemplate`, the message and content-block components, and `useData`.

**Mixed libraries.** Keep the string prompts as strings. The core handles them
with no renderer, and `{ name, description, template: "…" }` stays the cheapest
form for anything static.

## Roadmap & known gaps

- **`createApp({ prompts })` isn't wired yet.** The slot is declared and typed,
  and `definePrompts(...)` gives you the `store` / `hydrate` / `hooks` / `guards`
  bag today; installing still goes through `extensions: []`.
- **No filesystem source for React prompts.** The core ships `hydrateFrom` /
  `hydrateFromModule` / `hydrateFromStaticUrl`; a React-specific directory source
  over `.tsx` prompt files is not built, because it needs a bundler or transform
  pipeline.
- **Structure inside a section flattens to text.** A `<Section>`'s children
  become the buffered system message's content blocks, and the block-level
  wrappers (`<H2>`, `<Paragraph>`) currently render intrinsics no contributor
  claims, so their children pass through as bare text with the structure lost.
  Author the shape you want in the string, or emit explicit content blocks.
- **Loose content always projects to `system`.** There is no way to change that
  default role; wrap in an explicit `<User>` / `<Message>` if you want another.
- **A section's `id` is dropped.** `MessageEntry` has no analogue, so section
  identity does not survive projection — only the `title` does, as a heading.
- **The component tree can't reach `ctx`.** The renderer receives
  `(content, args)`; the invoking `OperationCtx` stops at the declaration's
  `render`. There is no hook for it inside the body.
- **Compile diagnostics are dropped.** `compileTemplate` returns warnings
  (an iteration cap hit, an await timeout) and the renderer discards them; a
  render failure surfaces as `PromptRenderFailed` with no diagnostic detail.
- **`useData` isn't pinned here.** The render-until-stable behavior is
  [@agentick/compiler-react](../compiler-react)'s and tested there; this
  package's suite doesn't exercise a suspending prompt body.

## Verified by

- `src/__tests__/renderer.spec.tsx` — the projection rules: a loose section
  becoming one `system` entry, a section `title` emitting a leading
  `# title` block, an explicit `<message>` passing through with its role, an
  explicit message flushing the section buffer so order survives, and two
  sections concatenating into a single system message; the `handles` predicate
  accepting elements, arrays, and strings while rejecting `null` / `undefined`,
  and a narrowed predicate from `createReactPromptRenderer` being respected;
  plus two end-to-end renders through a real prompt catalog wired with
  `reactPromptRenderer` — a single-message JSX template interpolating its
  argument, and a mixed section-plus-message template projecting to
  `[system, user]`.

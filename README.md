# agentick

**The component framework for AI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-reconciler-blue?style=for-the-badge&logo=react&logoColor=white)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

A React reconciler whose render target is a **language model.** You build the
context window with JSX — the same components, hooks, and composition you already
know — and the framework compiles it into what the model sees.

The tree re-renders **before every model call.** So context isn't a string you
append to across turns; it's derived from current facts each tick. Everything else
follows from that one decision:

> **Only what you render reaches the model.**

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { System } from "@agentick/compiler-react";
import { anthropic } from "@agentick/model-anthropic";

function Agent() {
  return <System>You are a terse, precise assistant.</System>;
}

const app = await createApp(<Agent />, { model: anthropic("claude-sonnet-4-5") });
const session = await app.createSession();

const handle = await session.send({
  messages: [{ role: "user", content: "What's 47 * 23?" }],
});
const { response, ticks, usage } = await handle.result;
console.log(response, `(${ticks} ticks, ${usage.totalTokens} tokens)`);
```

The conversation is already there. `session.send` appended the user message to the
durable log, and the log folded into context on its own — you write `<Timeline/>`
only when you want to **change** how it folds.

## Configuring a layer — the slot is the front door

A capability like the conversation is per-session, but its _configuration_ belongs
at the app. So each layer contributes a **top-level slot** on `createApp`:

```tsx
import { createApp } from "@agentick/app/react";
import { defineTimeline, hydrateTail } from "@agentick/timeline";
import { fsTimelineStore } from "@agentick/timeline-fs";
import { anthropic } from "@agentick/model-anthropic";

const app = await createApp(<Agent />, {
  model: anthropic("claude-sonnet-4-5"),
  timeline: defineTimeline({
    store: fsTimelineStore({ dir: "./.agentick/transcripts" }),
    hydrate: hydrateTail(200), // open every session on its last 200 entries
    compact: async (entries) => entries.slice(-40),
  }),
});
```

That's durable, resumable conversations in one slot. `defineTimeline` is identity
plus a brand — it returns the object you gave it, so a definition is a value you
export from a config module, import in a test, and override one slot on. Nothing
is constructed until a session installs it.

Every slot takes the same two forms and no third: a **definition**
(`defineTimeline({ store })`, or the identical inline bag `timeline: { store }`) or
a **live instance** when you own the lifecycle.

```ts
// Definitions carry their own interceptors, named by bare verb.
defineTimeline({
  store,
  hooks: { onBeforeAppend: (input) => log.debug({ appending: input.entries.length }) },
  guards: {
    append: (input) =>
      input.entries.length > 500 ? { kind: "veto", reason: "batch too large" } : undefined,
  },
});
```

For a layer assembled at runtime — conditional composition, a loop, a third party —
`extensions: []` is the escape form. It takes the same definitions:

```tsx
import { withTimeline } from "@agentick/timeline";

const app = await createApp(<Agent />, {
  model,
  extensions: [...(process.env.TRANSCRIPTS ? [withTimeline({ store })] : [])],
});
```

## A real agent

Here is the composition the framework exists for: a coding agent that reads its
own operating instructions off disk, works in a sandbox, exposes state the model
can flip, and shapes its own history against a token budget.

**The tree** — what the model sees, re-derived every tick:

```tsx
import { Section, System, useOnToolEnd } from "@agentick/compiler-react";
import { Knobs, useKnob } from "@agentick/knobs/react";
import { Bash, EditFile, ReadFile, Sandbox, WriteFile } from "@agentick/sandbox/react";
import { localProvider } from "@agentick/sandbox-local";
import { Timeline } from "@agentick/timeline/react";
import { useState } from "react";

export function CodingAgent() {
  // Model-visible AND model-settable: the model flips this with a tool call,
  // the tree re-renders, and its own instructions change.
  const [plan] = useKnob("plan_first", true, {
    description: "When true, write a plan before editing any file.",
  });

  // An observation fed straight back into context.
  const [lastFailure, setLastFailure] = useState<string | null>(null);
  useOnToolEnd((e) => setLastFailure(e.outcome === "failed" ? e.name : null));

  return (
    <Sandbox provider={localProvider()} workspace="./workspace">
      <System>
        You are a coding agent. Read a skill before attempting a task it covers.
        {plan ? " Write a plan before you edit anything." : ""}
      </System>

      {lastFailure && (
        <Section title="Recover" priority={100}>
          {`${lastFailure} failed on the last tick. Try a different approach.`}
        </Section>
      )}

      <Bash.Tool />
      <ReadFile.Tool />
      <WriteFile.Tool />
      <EditFile.Tool />

      {/* The model can read and set every knob through one tool. */}
      <Knobs />

      {/* Override the default fold: keep the budget, evict whole entries. */}
      <Timeline maxTokens={120_000} strategy="sliding-window" preserveRoles={["system", "user"]} />
    </Sandbox>
  );
}
```

**The wiring** — the slot for the conversation, extensions for the rest:

```tsx
import { createApp } from "@agentick/app/react";
import { anthropic } from "@agentick/model-anthropic";
import { withSandbox } from "@agentick/sandbox";
import { withSkills } from "@agentick/skills";
import { fromDirectory } from "@agentick/skills/loaders/node";
import { defineTimeline, hydrateTail } from "@agentick/timeline";
import { fsTimelineStore } from "@agentick/timeline-fs";

const app = await createApp(<CodingAgent />, {
  model: anthropic("claude-sonnet-4-5"),

  timeline: defineTimeline({
    store: fsTimelineStore({ dir: "./.agentick/transcripts" }),
    hydrate: hydrateTail(200),
  }),

  extensions: [
    // Markdown files with frontmatter become model-discoverable skills:
    // `skill_list` and `skill_read` land automatically, so the model pulls
    // instructions in on demand instead of carrying them every tick.
    withSkills({ loaders: [fromDirectory({ path: "./skills" })] }),
    withSandbox(),
  ],

  sessions: { maxActive: 500, idleTimeout: 30 * 60_000 },
});

const session = await app.createSession({ sessionId: "repo-1", title: "Fix the flaky test" });
```

Five layers composing, and notice what isn't there: no prompt template, no
history-management flag, no agent config file. Skills are files on disk with
frontmatter. `<Sandbox>` mounts a sandbox for the session under an id (default
`"primary"`) and tears it down on unmount — the bundled tools resolve it at
dispatch, and `useSandbox()` hands the live handle to tools you write yourself.
`maxActive` and `idleTimeout` page idle sessions out of memory while their durable
records survive — reopening the id rehydrates the conversation.

Deep dives: [@agentick/timeline](packages/timeline) ·
[@agentick/skills](packages/skills) · [@agentick/sandbox](packages/sandbox) ·
[@agentick/knobs](packages/knobs) · [@agentick/app](packages/app)

### Progressive disclosure, in one paragraph

The two layers above solve the same problem from opposite ends. A **skill** is
context the model pulls in when it decides it needs it — a list of names and
descriptions costs a few tokens, and the body arrives only on `skill_read`. A
**knob** is state the model can flip to change its own prompt: a collapsed docs
section, a verbosity level, a mode. Both keep the tokens the model isn't using out
of the window, which is the whole game once a conversation gets long.

## Serving it

An app is in-process. Put a [gateway](packages/gateway) in front and the same tree
serves clients over a wire — the gateway owns transports, auth, and the cluster;
apps and sessions beneath it inherit its extensions.

```tsx
import { reactCompiler } from "@agentick/compiler-react";
import { createGateway } from "@agentick/gateway";
import { httpServerTransport } from "@agentick/transport-http";
import { anthropic } from "@agentick/model-anthropic";

const gateway = await createGateway({
  transports: [httpServerTransport({ port: 8787 })],
});

await gateway.createApp(<CodingAgent />, {
  appId: "coder",
  options: {
    compiler: reactCompiler(),
    model: anthropic("claude-sonnet-4-5"),
    timeline: { store },
  },
});

await gateway.listen();
```

> [!NOTE]
> Two differences from top-level `createApp` on this path: the app's own options
> nest under `options:` (the gateway owns `appId` and identity, the app owns the
> rest), and there is no `/react` subpath to default the compiler for you — pass
> `reactCompiler()` explicitly.

The client talks to it over the same protocol, and the conversation arrives as a
**fold over the event stream** — no read RPC, no second copy of the truth:

```ts
import { createClient } from "@agentick/client";
import { http } from "@agentick/transport-http";
import "@agentick/timeline/client"; // registers `session.timeline` on the client

const client = await createClient({ transport: http({ url: "http://localhost:8787" }) });

const timeline = client.session("repo-1").timeline;
timeline.subscribe(() => render(timeline.list()));

await timeline.loadOlder(50); // cursored scroll-back over the durable log
```

Bind your UI straight to `list()` and `subscribe()`, or feed your own store from
the same handle — the framework owns no client cache, so nothing fights an adopter
whose message model isn't ours.

Deep dives: [@agentick/gateway](packages/gateway) ·
[@agentick/client](packages/client) ·
[@agentick/transport-http](packages/transport-http)

## Sessions, executions, ticks

A **session** is a long-lived conversation. Each `send()` is one **execution**.
Each model API call inside it is a **tick** — multi-tick executions happen
automatically with tool use.

```
Session
├── Execution 1  "hello"          → tick 1 → response
├── Execution 2  "use calculator" → tick 1 (tool_use) → tick 2 (answer)
└── …
```

The handle `send()` returns is both an async iterable of stream events and a
`.result` promise:

```ts
// await the final result…
const { response, ticks, usage, stopReason } = await handle.result;

// …or stream as it happens
for await (const event of handle) {
  if (event.type === "content-delta") process.stdout.write(event.delta);
}
```

**Steering is native.** A `send()` while an execution is running _joins_ it: the
messages append, the in-flight handle comes back, and the loop runs another tick
so the model addresses the correction.

```ts
const handle = await session.send({ messages: [{ role: "user", content: "refactor auth" }] });
// ... the agent is mid-run ...
const same = await session.send({ messages: [{ role: "user", content: "wait — dry run" }] });
console.log(same === handle); // true — the running execution absorbed it
```

There is no pending-message queue to reason about, because input appends the
moment it arrives and every tick re-renders the whole log.

Deep dive: [@agentick/session](packages/session)

## Structured results

Ask for a shape; get a typed, validated value back:

```ts
import { z } from "zod";

const { data } = await (
  await session.send({
    messages: [{ role: "user", content: "Summarize this ticket." }],
    output: z.object({
      title: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      tags: z.array(z.string()),
    }),
  })
).result;
```

When the turn has tools, agentick does **not** force every token through a JSON
schema. It injects a **terminal tool** whose input schema _is_ your output schema;
the model calls it to deliver the final answer, and that call ends the execution —
**"done" and "shaped" are the same event.** Validation is provider-enforced
tool-argument constraint, the model keeps its full voice on intermediate ticks, and
prose and data ride the same final turn (`response` + `data`, `stopReason:
"output_delivered"`).

The ladder is explicit rather than hopeful: the natural path, then one forced
wrap-up tick, then a typed error in the residual sliver. A nonconforming answer
**rejects** — you never receive a malformed object.

`<Output schema={…} />` in the tree says "every execution of this agent produces
this shape"; the send-level `output` overrides it per execution.

## Interceptors — participating in the run

A component doesn't only describe context; it can take part in the operation. The
same commands are reachable three ways, distinguished by how much they know:

| Seam           | Sees                                | Scope                | Registered                                      |
| -------------- | ----------------------------------- | -------------------- | ----------------------------------------------- |
| **Guard**      | one named verb's input → a verdict  | admission, outermost | `createApp({ guards })`, `useGuardToolDispatch` |
| **Hook**       | one named verb's typed input/output | transform            | `createApp({ hooks })`, `defineX({ hooks })`    |
| **Middleware** | every operation, opaquely           | wrap                 | `app.use(mw)`                                   |

```tsx
import { useGuardToolDispatch } from "@agentick/compiler-react";

function DangerLock({ unlocked }: { unlocked: boolean }) {
  useGuardToolDispatch((call) =>
    call.name.startsWith("delete_") && !unlocked ? "veto" : "proceed",
  );
  return null;
}
```

A guard returns `"proceed" | "veto" | "defer" | { replace }` — so a component can
block a tool call, hold it for a human, or swap it, from its current render state.

**The cascade is total and ordered:** app guards → definition guards → app
`before` hooks → definition `before` hooks, with `after` hooks unwinding in
reverse. Governance outranks local policy; hooks compose rather than override; and
the cascade is a construction fold, so interceptors registered before a session is
created reach it and ones registered after don't.

## The layers

Each package is a deep dive. The ones you touch building an agent:

| Package                                             | What it gives you                                               |
| --------------------------------------------------- | --------------------------------------------------------------- |
| [@agentick/app](packages/app)                       | `createApp` — the runtime root; `/react` wires the JSX compiler |
| [@agentick/compiler-react](packages/compiler-react) | the JSX surface: components, hooks, `createTool`                |
| [@agentick/timeline](packages/timeline)             | the conversation, its store port, and compaction                |
| [@agentick/session](packages/session)               | `send`, steering, spawn / fork, snapshot                        |
| [@agentick/tool](packages/tool)                     | `createTool`, transforms, dispatch                              |
| [@agentick/knobs](packages/knobs)                   | `useKnob` / `<Knobs>` — model-settable state                    |
| [@agentick/state](packages/state)                   | `useSessionState` — state the model never sees                  |
| [@agentick/skills](packages/skills)                 | progressive disclosure over files or a registry                 |
| [@agentick/gates](packages/gates)                   | named exit conditions on the loop                               |
| [@agentick/sandbox](packages/sandbox)               | sandboxed execution, tree-scoped                                |
| [@agentick/mcp](packages/mcp)                       | connect to — or expose — Model Context Protocol servers         |
| [@agentick/gateway](packages/gateway)               | multi-app server: transports, auth, cluster                     |
| [@agentick/client](packages/client)                 | the client that talks to a gateway                              |

Model adapters: [@agentick/model-anthropic](packages/model-anthropic) ·
[@agentick/model-openai](packages/model-openai) ·
[@agentick/model-google](packages/model-google) ·
[@agentick/model-ai-sdk](packages/model-ai-sdk) (wraps any Vercel AI SDK
provider). Durable stores: [@agentick/timeline-fs](packages/timeline-fs) ·
[@agentick/timeline-postgres](packages/timeline-postgres).

Foundations — [@agentick/spec](packages/spec) (every type that crosses a
boundary), [@agentick/runtime](packages/runtime) (the substrate and the operation
pipeline), [@agentick/utils](packages/utils) — sit underneath. You reach for them
writing a harness, not writing an agent.

## Running it today

The packages are **not on npm yet**, and there is no single-install metapackage —
one that bundles the built-in layers is on the way. Until then, run from this
repo:

```bash
git clone https://github.com/agenticklabs/agentick && cd agentick
pnpm install

cp example/v2-real/.env.example example/v2-real/.env   # add your API key
pnpm --filter example-v2-real dev
```

[`example/v2-real`](example/v2-real) is the runnable reference agent.
[`example/v2-coding-agent`](example/v2-coding-agent) is the larger one, with tools
holding their own state.

Composing packages yourself, your `tsconfig.json` needs React JSX:

```json
{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react" } }
```

## Status

Pre-release and moving fast. The API is deliberately unstable: there are no
deprecations and no compatibility shims, because getting the shape right before
adopters depend on it is worth more than a smooth upgrade from a shape we regret.
Expect breaking changes on any release until the packages publish.

Known gaps worth knowing before you build:

- **No metapackage.** Every layer is a separate specifier today.
- **Layer slots are landing incrementally.** The conversation has its top-level
  `timeline` slot; skills, sandbox, prompts, and tasks still install through
  `extensions: []`.
- **Configuration is app-wide.** `createSession` takes no per-session layer
  override yet.
- **The recommended first durable store isn't shipped.** Filesystem and Postgres
  are; SQLite is not.
- **The bundled sandbox tools resolve one sandbox.** They take the `"primary"`
  registration, or the sole one if there is exactly one. Mount two sandboxes and
  write your own tools against `useSandbox()`.

## License

MIT

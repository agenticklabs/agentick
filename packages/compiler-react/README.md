# @agentick/compiler-react

**Your agent is a component tree, re-rendered before every model call.** Not a prompt string you append to across turns — a tree that re-executes each tick and produces a fresh intermediate representation from current facts.

That's the bet, and everything here follows from it. If context is _derived_ rather than accumulated, then anything that can change context has to be readable during render — so the remaining token budget, the model about to be called, the outcome of the last tool call, and the error that just fired are all hooks, not callbacks wired up outside the tree. And because the tree is re-entered every tick, a component can also _participate_ in the run: veto a tool call, reshape a model request, stop the loop.

This package is the JSX front end — the components you write, the hooks they read, and `CompilerHarness`, which turns the committed tree into IR. It depends on no capability package: [@agentick/knobs](../knobs), [@agentick/timeline](../timeline), [@agentick/state](../state) each add a `/react` subpath that depends on _this_ package, never the reverse.

## Install

```bash
npm install @agentick/compiler-react
```

Subpaths: `/testing` (render-flush helpers).

## Quick start

```tsx
import { createApp } from "@agentick/app/react"; // defaults the compiler for you
import { Section, System, useOnToolEnd } from "@agentick/compiler-react";
import { openai } from "@agentick/model-openai";

function Agent() {
  useOnToolEnd((e) => {
    if (e.outcome === "failed") console.warn(`${e.name} failed in ${e.durationMs}ms`);
  });

  return (
    <>
      <System>You are a terse, precise assistant.</System>
      <Section title="Task">
        <p>Answer the question in one paragraph.</p>
      </Section>
    </>
  );
}

const app = await createApp(<Agent />, { model: openai("gpt-4o") });
```

`@agentick/app/react` wires `reactCompiler()` in for you. Reach for the explicit form when you're composing `createApp` yourself — with no arguments it stands up its own local substrate, and inside an app it inherits the app's journal and bus:

```tsx
import { createApp } from "@agentick/app";
import { reactCompiler } from "@agentick/compiler-react";
import { openai } from "@agentick/model-openai";

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  compiler: reactCompiler(),
});
```

## Writing context

### Messages and sections

A model call is system instructions plus ordered messages, and that is exactly what `RenderedTree.context.entries` is: a flat list of messages in tree order. `<Message>` (and its `<System>` / `<User>` / `<Assistant>` sugar) makes one.

`<Section>` is **content**, not an entry. Two rules decide where it goes:

> **The container decides its role. Its position decides its order.**

Put a section inside a message and it becomes part of that message:

```tsx
import { Section, System, User } from "@agentick/compiler-react";

function Prompt({ question }: { question: string }) {
  return (
    <>
      <System>
        You are a research assistant.
        <Section title="House style">
          <p>Cite every claim. Say "unknown" rather than guessing.</p>
        </Section>
      </System>
      <User>{question}</User>
    </>
  );
}
```

`<System>` is not a special case here — it is simply the message whose content becomes the provider's system parameter. The same section inside `<User>` becomes part of that user turn instead, with the same structure. A tree with no `<System>` sends no system instructions at all; there is no implicit system prompt.

Write a section on its own, between messages, and it becomes a message of its own at that position — role `grounding`, meaning context that is neither an instruction nor something the human typed:

```tsx
<>
  <System>You are a support agent.</System>
  <Timeline />
  <Section title="Current page">Billing → Invoices, invoice #4417 open.</Section>
</>
```

That section is the **last** message the model receives, because that is where you wrote it. Move it above `<Timeline />` and it arrives before the conversation instead. `<Grounding>` is the explicit spelling of the same thing (`<Grounding title="Current page">…</Grounding>`), and it is what a bare `<Section>` compiles to.

Providers differ in what they can carry: OpenAI receives a grounding message on its `developer` channel; Anthropic and Google have no non-user role, so it arrives as `user` — with the section's own structure (`# Current page`) intact, which is what keeps it from reading as an impersonated human turn.

`role` is the escape hatch on that default. A free-standing section is `grounding` because that is what context-about-the-world is, but a section that IS a turn says so — `<Section role="user">` compiles to a plain user message whose content is still the section structure. On a section **inside** a message the prop is a compile warning rather than a silent no-op: the container already decided the role, so wrap the section in `<Message role="…">` instead.

`<Section>` also takes `cache` (a prompt-cache breakpoint that stays a real boundary inside its message) and `id` (stable across recompiles, and what request-provenance names when a provider rejects the request).

There is deliberately no prop for the XML tag. Markdown renders the title's words as a heading and XML renders the same words as a tag, so one section has one name in both dialects; a separate tag prop would let them diverge. When you need an exact tag, use `<custom>`:

```tsx
<custom tag="retrieved-context">
  <custom tag="about">System-produced. May be irrelevant.</custom>
  <custom tag="result" attrs={{ rank: "1", title: doc.title }}>
    {snippet}
  </custom>
</custom>
```

**Every dialect emits that tag, markdown included** — no `<XML>` wrapper required. `custom` is the escape hatch for "these exact bytes under this exact tag", and a dialect that dropped it would make the hatch unreachable. Markdown is a superset of HTML (CommonMark specifies raw HTML blocks), so the tag is valid there; the formatter already emits `<kbd>` and `<var>` on the same grounds.

Attribute values are escaped in both dialects — a quote would end the attribute. Content is escaped in XML and left verbatim in markdown, where escaping `<` would break every other construct.

Which dialect a section reads in is decided by the formatter in scope, at the same moment everything else is formatted:

```tsx
<XML>
  <Section title="Current User">Ryan</Section>
</XML>
// <message role="grounding">
// <current_user>
// Ryan
// </current_user>
// </message>
```

Under `<Markdown>` the same section is `# Current User\nRyan`; under `<PlainText>` it is `Current User\nRyan`. A section nested inside a message reads in that **message's** dialect — the container decides the dialect the same way it decides the role.

`<System>`, `<User>`, and `<Assistant>` are sugar for `<Message role="…">`. `<Message>` takes a full persisted record — spread one straight in:

```tsx
import { Message } from "@agentick/compiler-react";
import type { SessionMessage } from "@agentick/spec";

const Replay = ({ history }: { history: readonly SessionMessage[] }) => (
  <>
    {history.map((m) => (
      <Message key={m.id} {...m} />
    ))}
  </>
);
```

### Plain HTML is the markup surface

Write ordinary HTML inside a message or section and the formatter renders it. There is no markdown-string escape hatch to reach for — headings, lists, links, emphasis, tables, and blockquotes are all elements:

```tsx
import { Section } from "@agentick/compiler-react";

const Brief = () => (
  <Section title="Brief">
    <h1>Q3 review</h1>
    <p>
      Read the <a href="https://example.test/spec">spec</a> before you start.
    </p>
    <ul>
      <li>Revenue is up</li>
      <li>Churn is flat</li>
    </ul>
    <blockquote>Ship the boring version.</blockquote>
  </Section>
);
```

Under the default markdown formatter that produces `# Q3 review`, `[the spec](…)`, `- Revenue is up`, and `> Ship the boring version.`. Contiguous text and markup coalesce into a **single** text block carrying the assembled tree as a sidecar, so the formatter — not the compiler — decides how it serializes.

Supported out of the box: `h1`–`h6`, `p`, `ul` / `ol` / `li`, `table` / `thead` / `tbody` / `tr` / `td` / `th`, `a`, `img`, `blockquote`, `pre`, `br`, `hr`, `strong` / `b`, `em` / `i`, `mark`, `u`, `s` / `del`, `sub`, `sup`, `small`, `kbd`, `var`, `q`, `cite`, and the block/inline containers `div`, `span`, `article`, `aside`, `main`, `header`, `footer`, `nav`, `figure`, `figcaption`, `address`.

> [!NOTE]
> The markup surface is lowercase HTML. The exported `<Paragraph>`, `<H1>`, `<H2>`, and `<H3>` wrappers are thin sugar over `<p>` / `<h1>`–`<h3>` — byte-identical output, pinned by tests.

### Choosing the formatter per subtree

The same tree can serialize differently in different places. `<FormatScope>` sets the formatter for its subtree; `<Markdown>`, `<XML>`, and `<PlainText>` are the named shorthands.

```tsx
import { Markdown, Section, XML } from "@agentick/compiler-react";

const Mixed = () => (
  <>
    <Markdown>
      <Section title="Instructions">
        <p>
          Answer <strong>concisely</strong>.
        </p>
      </Section>
    </Markdown>
    <XML>
      <Section title="Data">
        <p>
          Answer <strong>concisely</strong>.
        </p>
      </Section>
    </XML>
  </>
);
```

The `<strong>` renders as `**concisely**` in the first scope and `<strong>concisely</strong>` in the second. Each entry records the formatter that claimed it on `entry.renderedWith`, so nothing downstream has to guess.

**The nearest declared scope decides; the default is the container's.** A scope around a section INSIDE a message makes that section an ISLAND — lowered in the dialect it named and spliced into the message verbatim, with the outer formatter never running over its bytes:

```tsx
<System>
  Follow the rules.
  <XML>
    <Section title="Current User">Ryan &amp; Bob</Section>
  </XML>
</System>
// → "Follow the rules.<current_user>\nRyan &amp; Bob\n</current_user>"
```

That is the hand-written-prompt shape: markdown prose with literal tagged blocks in it. Escaping the island in the container's transport would emit `&lt;current_user&gt;` instead — a rendering OF an island rather than an island. The mirror holds too: a `<Markdown>` island inside an `<XML>` message keeps its `#` and its raw `&`, and well-formedness across a declared boundary is the author's call. Declare nothing and the container's dialect renders everything, which is what it has always done.

### Content blocks

Non-text content — images, code, JSON, documents, media, reasoning — enters as typed blocks. These are lowercase host intrinsics:

```tsx
import { Section } from "@agentick/compiler-react";

const WithBlocks = () => (
  <Section title="Evidence">
    <json data={{ latency_ms: 412, error_rate: 0.02 }} />
    <document source={{ type: "url", url: "https://example.test/report.pdf" }} title="Q3 report" />
  </Section>
);
```

> [!NOTE]
> `<code>`, `<image>`, `<audio>`, `<video>`, and `<text>` are handled by the compiler but are **not** declared in the JSX namespace — TypeScript keeps React's built-in HTML/SVG typings for those tag names and declaration merging can't override them. Reach them through `React.createElement("code", { language: "typescript" }, source)`. `<json>`, `<document>`, `<csv>`, `<xml-block>`, `<reasoning>`, `<custom>`, and `<content>` have no such collision and are fully typed.

## Reading live facts during render

These hooks are synchronous reads of the render envelope — facts about _this_ render, available while the tree is producing IR.

| Hook                 | Returns                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `useContextInfo()`   | `{ contextWindow?, usedTokens, utilization? }`                        |
| `useActiveModel()`   | `ActiveModel \| undefined` — `{ provider?, modelId?, capabilities? }` |
| `useRenderContext()` | the full envelope (`{}` outside a run)                                |
| `useSession()`       | `{ id, status, currentTick?, executionId? }` — read-only              |

Render less as the window fills:

```tsx
import { Section, useContextInfo } from "@agentick/compiler-react";

function History({ entries }: { entries: readonly string[] }) {
  const { utilization = 0 } = useContextInfo();
  const kept = entries.slice(-(utilization > 0.8 ? 5 : 50));

  return (
    <Section title="Conversation">
      {kept.map((text, i) => (
        <Section key={i}>{text}</Section>
      ))}
    </Section>
  );
}
```

`utilization` merges two channels by tense on purpose: the window size rides the synchronous envelope and is live for this render, while `usedTokens` is a past fact arriving from the previous tick's end. One tick behind is the correct answer to "how much did we spend," not a lag to work around.

Render _for the model you're about to call_:

```tsx
import { Section, useActiveModel } from "@agentick/compiler-react";

function ToolGuidance() {
  const model = useActiveModel();
  if (!model?.capabilities?.supportsTools) return null;

  return (
    <Section title="Tool use">
      {model.provider === "anthropic"
        ? "Think inside <thinking> tags before calling a tool."
        : "Reason briefly, then call a tool."}
    </Section>
  );
}
```

### Blocking on async data

`useData` throws the in-flight promise; the compile loop awaits it and re-renders. The component only ever sees a resolved value or a thrown error — there is no loading branch to write.

```tsx
import { Section, useData } from "@agentick/compiler-react";

declare function fetchForecast(city: string): Promise<{ summary: string }>;

function Weather({ city }: { city: string }) {
  const forecast = useData(`weather:${city}`, () => fetchForecast(city));
  return <Section title={`Weather in ${city}`}>{forecast.summary}</Section>;
}
```

Results are cached by key, so a resolved value comes back synchronously on the next render, and a rejected fetcher surfaces as a render error rather than a loading state you have to branch on. `awaitTimeoutMs` bounds how long the loop waits and reports a diagnostic when it trips.

> [!WARNING]
> This is not React `<Suspense>`. A `<Suspense>` boundary in an agent tree warns once at mount, because its fallback would render straight into the IR as real model context and nothing downstream can tell it apart from something you meant to say.

## Observing the run

Lifecycle hooks register a callback for a matching event and unregister on unmount. They are fire-and-forget: they never sit in the operation's path.

| Hook                                  | Fires on                           | Catches up on late mount |
| ------------------------------------- | ---------------------------------- | ------------------------ |
| `useOnTickStart(cb)`                  | tick start                         | **yes**                  |
| `useOnTickEnd(cb)`                    | tick end                           | no                       |
| `useOnExecutionStart(cb)`             | execution start                    | **yes**                  |
| `useOnExecutionEnd(cb)`               | execution end                      | no                       |
| `useOnToolStart(cb)`                  | tool dispatch start                | no                       |
| `useOnToolEnd(cb)`                    | tool dispatch end                  | no                       |
| `useOnModelGenerateStart(cb)`         | model call start (both tick paths) | no                       |
| `useOnModelGenerateEnd(cb)`           | model call end (both tick paths)   | no                       |
| `useOnError(cb)`                      | any phase error                    | no                       |
| `useOnLifecycleCustom(kind, cb)`      | a namespaced custom event          | no                       |
| `useOnMount(cb)` / `useOnUnmount(cb)` | React commit boundaries            | n/a                      |

The two catch-up hooks fire immediately for a component that mounts mid-tick, so a late-mounting component still knows which execution it's in.

Feed observations straight back into context — the model reads what the last tick did:

```tsx
import { useState } from "react";
import { Section, useOnError } from "@agentick/compiler-react";

function ErrorCorrection() {
  const [lastError, setLastError] = useState<string | null>(null);
  useOnError((e) => setLastError(`${e.phase}: ${e.error.message}`));
  if (!lastError) return null;

  return (
    <Section title="Recover">
      The previous attempt failed with: {lastError}. Try a different approach.
    </Section>
  );
}
```

Ordinary `useState` survives across ticks within a mount. For state that survives hibernate and resume, reach for `useSessionState` from [@agentick/state](../state).

And stop the loop from an observation:

```tsx
import { useLoopControl, useOnToolEnd } from "@agentick/compiler-react";

function StopOnSubmit() {
  const loop = useLoopControl();
  useOnToolEnd((e) => {
    if (e.name === "submit_answer" && e.outcome === "succeeded") {
      loop.stopAfterTick("answer submitted");
    }
  });
  return null;
}
```

## Participating in the run

The other half. Where the observers above only watch, these register real interceptors on the framework's commands, so a component can **veto, defer, or replace** an operation, or **reshape** its input — from its current render state.

| Hook                                    | Kind        | Intercepts                                    |
| --------------------------------------- | ----------- | --------------------------------------------- |
| `useGuardToolDispatch(decide)`          | `guard`     | `tool:dispatch`                               |
| `useTransformToolDispatch(fn)`          | `transform` | `tool:dispatch`                               |
| `useTransformModelInput(fn)`            | `transform` | `model:generate` + `model:generate_stream`    |
| `useCommandInterceptor(name, kind, fn)` | either      | any command (registry-typed; `string` escape) |

`useCommandInterceptor` is the primitive and the named hooks are typed aliases over it. Its generic is derived from the command registry, so a package that adds a command makes it tree-interceptable with full types and no new React code. A guard returns `"proceed" | "veto" | "defer" | { replace }`, or the full verdict object when it wants to attach a reason.

```tsx
import { useState } from "react";
import { useGuardToolDispatch } from "@agentick/compiler-react";

function DangerLock() {
  const [unlocked] = useState(false);
  useGuardToolDispatch((call) =>
    call.name.startsWith("delete_") && !unlocked ? "veto" : "proceed",
  );
  return null;
}
```

> [!WARNING]
> **Guards and transforms run inside the operation's critical path.** They are awaited before (guard) or around (transform) the operation body — not the fire-and-forget posture of the `useOn*` family. Decide promptly from captured render state, or defer cleanly; they cannot hang the operation. Route a human in with `"defer"` (the caller retries later) or by awaiting a bounded elicitation. Pure side effects — spinners, logging — are not this. Use the observers, which watch the same commands without sitting in the path.

`<ToolGate>` is the confirm-dialog shape of that, packaged:

```tsx
import { ToolGate, useBridges } from "@agentick/compiler-react";

function ConfirmDestructive() {
  const { elicitation } = useBridges();

  return (
    <ToolGate
      tool={(call) => call.name.startsWith("delete_")}
      confirm={async (call) => {
        const res = await elicitation.elicit({
          mode: "url",
          message: `Allow ${call.name}?`,
          url: "https://app.example/confirm",
          elicitationId: `gate-${call.toolCallId}`,
        });
        return res.outcome === "accepted";
      }}
    />
  );
}
```

`tool` narrows what the gate applies to — a name, a list of names, or a predicate. Omit it and the gate covers every dispatch. See [@agentick/elicitation](../elicitation) for the ask itself.

## Tools in the tree

`createTool` here extends the compiler-agnostic factory in [@agentick/tool](../tool) with a render-time `use()` slot. Handlers run at dispatch, long after render, so `use()` is the bridge: it runs during render (where hooks are legal), and the handler reads whatever the most recent render captured.

```tsx
import { z } from "zod";
import { createTool } from "@agentick/compiler-react";

declare function useSandbox(): { exec(cmd: string): Promise<{ stdout: string }> };

const { Tool: Shell } = createTool({
  name: "shell",
  description: "Run a command in the sandbox",
  inputSchema: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }), // render-time; hooks are fine here
  handler: async ({ command }, { use }) => {
    const { stdout } = await use.sandbox.exec(command);
    return [{ type: "text", text: stdout }];
  },
});

const Agent = () => <Shell />;
```

The returned `Tool` component registers the handler on mount, unregisters on unmount, and renders the declaration into the IR. Registration is keyed by a stable `handlerRef`, so re-renders never re-register.

> [!NOTE]
> Reserve `use()` for genuinely tree-positional values — something an ancestor provider put in React context. Session-scoped capabilities reach the handler through `ctx` instead, resolved fresh at dispatch: `ctx.elicit`, `ctx.tasks`, `ctx.resource`, `ctx.log`, `ctx.progress`. See [@agentick/tool-executor](../tool-executor).

For tools the provider executes itself — web search, grounding — `<ProviderTool>` declares them without routing through the tool executor:

```tsx
import { ProviderTool } from "@agentick/compiler-react";

const Search = () => <ProviderTool provider="openai" type="web_search_preview" />;
```

## Declaring the answer shape

`<Output>` declares the structured shape every execution of this agent produces. The loop delivers it through a synthetic terminal tool whose input schema _is_ your schema, or as a response-format directive on a bare send.

```tsx
import { z } from "zod";
import { Output, System } from "@agentick/compiler-react";

const Extractor = () => (
  <>
    <System>Extract the invoice fields.</System>
    <Output
      schema={z.object({ total: z.number(), currency: z.string() })}
      name="submit_invoice"
      description="Call this once you have every field."
    />
  </>
);
```

`schema` accepts any Standard Schema validator. `strategy` is `"auto"` (the default), `"tool"`, or `"responseFormat"`. A send-level output overrides the declaration — the tree form says "always this shape," the send form says "this execution's shape."

## Surfacing: defaults and overrides

The IR is assembled from two kinds of contribution. **Content** — `<Section>` and `<Message>` written directly — appends to the entry stream in tree order. **Projections** — one per surfacing-capable capability — fold in something the tree didn't write out longhand.

Projections ship **on and lazy**. Three run by default: `timeline` (the conversation), `tools` (the registered declarations), and `mcpServerInfo` (connected servers). Write nothing and an agent that renders only a `<System>` and a couple of tools still gets its conversation folded in and its tools advertised.

`<Project>` overrides one:

```tsx
import { Message, Project, Section } from "@agentick/compiler-react";
import type { SessionMessage } from "@agentick/spec";

const RecentOnly = ({ history }: { history: readonly SessionMessage[] }) => (
  <Project projectionKey="timeline">
    {history.slice(-10).map((m) => (
      <Message key={m.id} {...m} />
    ))}
  </Project>
);

const Agent = ({ history }: { history: readonly SessionMessage[] }) => (
  <>
    <Section title="Task">
      <p>Summarize the conversation.</p>
    </Section>
    <RecentOnly history={history} />
  </>
);
```

Suppression keys on **presence, not count** — an override that projects zero entries still suppresses the default, so nothing is ever folded twice. `<Timeline>` from [@agentick/timeline](../timeline) is exactly this with filtering and a token budget on top.

Every contribution is provenance-tagged on `RenderedTree.provenance`, index-aligned with the entries, marked `default:<key>` or `authored:<key>`. Defaults are real contributions the compiler ran, never entries injected behind the tree's back — which is what makes "what did the model see, and who put it there?" answerable.

## One-shot templates

`compileTemplate` and `renderTemplate` run the same compile-until-stable loop and the same walker with none of the session scaffolding — no journal, no ticks, no lifecycle. Reach for them when you have a tree and want the IR or a string.

```tsx
import { compileTemplate, renderTemplate, Section } from "@agentick/compiler-react";
import { xmlFormatter } from "@agentick/formatters";

const Template = () => (
  <Section title="Greeting">
    <p>
      Hello, <strong>world</strong>.
    </p>
  </Section>
);

const { tree } = await compileTemplate(<Template />); // RenderedTree IR
const { output } = await renderTemplate(<Template />); // markdown by default
const { output: xml } = await renderTemplate(<Template />, { formatter: xmlFormatter });
```

Both run the formatter pass, so `compileTemplate`'s IR is wire-shape — semantic HTML rendered, sections lowered — the same contract `renderTree` returns. That matters because what `compileTemplate` hands back goes straight to a wire: `@agentick/prompts-react` returns those entries verbatim and MCP `prompts/get` ships them. `renderTemplate`'s `formatter` option is in force during that pass, not applied afterwards, so a section under `{ formatter: xmlFormatter }` reads as a tag rather than as a markdown heading wrapped in xml.

That covers prompt authoring, MCP prompt and resource bodies, JSX-authored skill content, rich tool descriptions, snapshot tests, and docs generators. `useData` behaves identically — the loop awaits pending fetches and re-renders. `maxIterations` (default 10) caps the loop and `awaitTimeoutMs` (unbounded by default) caps each wait; both surface in `diagnostics` when they trip.

What templates deliberately don't provide: capability bridges (knobs, state, timeline, tools, MCP, sandbox), session lifecycle, journal, and loop control. Hooks that need a missing bridge throw at render. A `<Tool>` won't register its handler, though its declaration still lands on `tree.declarations.tools` — handler resolution is the executor's problem at dispatch, not the renderer's.

Anything that needs the live session — tool dispatch, hibernate and resume, channels, a registered `<Tool>` — wants `createApp` instead.

## API

### Components

| Component                                          | Purpose                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Section>`                                        | Titled content — `id`, `title`, `role`, `cache`, `metadata`. Lands in its containing message; alone, becomes a message at its position (`grounding` unless `role` says otherwise) |
| `<Message role>`                                   | Role-bearing entry; spread a persisted record                                                                                                                                     |
| `<System>` `<User>` `<Assistant>`                  | Sugar for `<Message role="…">`                                                                                                                                                    |
| `<Grounding title?>`                               | A `grounding` message wrapping a `<Section>` — what a bare section compiles to                                                                                                    |
| `<FormatScope>` `<Markdown>` `<XML>` `<PlainText>` | Per-subtree formatter framing                                                                                                                                                     |
| `<Project projectionKey>`                          | Override a capability's projection; suppresses that key's default                                                                                                                 |
| `<Output schema name? description? strategy?>`     | Declare the shape every execution of this agent produces                                                                                                                          |
| `<ProviderTool provider type name? config?>`       | Declare a provider-executed tool; bypasses the tool executor                                                                                                                      |
| `<ToolGate tool? confirm>`                         | Gate the model's tool calls behind a confirm flow                                                                                                                                 |

### Hooks

| Hook                                       | Returns / signature                                                   |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `useData<T>(key, fetcher, opts?)`          | `T` — blocking async resolve                                          |
| `useSession()`                             | `{ id, status, currentTick?, executionId? }`                          |
| `useLoopControl()`                         | `{ continueAfterTick(reason?), stopAfterTick(reason?) }`              |
| `useContextInfo()`                         | `{ contextWindow?, usedTokens, utilization? }`                        |
| `useActiveModel()`                         | `ActiveModel \| undefined`                                            |
| `useRenderContext()`                       | the full render envelope                                              |
| `useBridges()`                             | the live bridge record (`timeline`, `elicitation`, …)                 |
| `useToolBridge()` / `useModelBridge()`     | registration bridges, `undefined` when absent                         |
| `useModelRegistration(modelRef, resolved)` | `ReactElement` — **the caller renders it**                            |
| the `useOn*` family                        | lifecycle observers — see [Observing the run](#observing-the-run)     |
| the guard / transform family               | in-path interceptors — see [Participating](#participating-in-the-run) |

`useModelRegistration` mirrors `createTool`'s `Tool` component: it registers the run-ready model on the bridge and returns the declaration element for you to render. It returns an element rather than nothing because declarations enter the IR through exactly one path — the walker traversing the committed tree — and a `void` hook cannot contribute to it.

### Compiler, factory, contexts

| Export                                                                         | Purpose                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------- |
| `reactCompiler(opts?)`                                                         | `CompilerFactory` for `createApp`           |
| `CompilerHarness` / `CompilerHarnessOptions`                                   | The implementation, for direct construction |
| `createCompiler` / `createHostConfig`                                          | Low-level `react-reconciler` integration    |
| `compileTemplate` / `renderTemplate`                                           | One-shot IR and string entry points         |
| `createTool`                                                                   | React-flavored tool factory with `use()`    |
| `BridgeProvider` / `useBridges` / `BridgeContext`                              | React context over the bridge record        |
| `LifecycleProvider` / `useLifecycleDispatch` / `LifecycleContext`              | React context over lifecycle dispatch       |
| `InterceptorProvider` / `useCommandInterceptorRegistry` / `InterceptorContext` | React context over the per-mount registry   |
| `enableReactDevTools` / `isReactDevToolsConnected` / `disableReactDevTools`    | React DevTools bridge                       |

### `/testing`

```ts
import { flush, waitFor } from "@agentick/compiler-react/testing";
```

`flush()` awaits pending effects — registration happens in `useEffect`, after commit. `waitFor(assertion)` polls until an assertion passes. Pair with `fakeBridges()` from [@agentick/compiler](../compiler) to drive a tree without a session.

### React feature support

| Feature                                   | Behavior                                                |
| ----------------------------------------- | ------------------------------------------------------- |
| Components, hooks, refs, effects, context | Full support — this is real React                       |
| `useData`                                 | Blocks render via a thrown promise; the loop awaits     |
| `<Suspense>` fallbacks                    | Warns once per mount; the fallback still reaches the IR |
| Error boundaries                          | Supported; a catch is reported as an info diagnostic    |
| `useTransition` / `useDeferredValue`      | Allowed, no effect (render is synchronous)              |
| React Server Components                   | Not supported                                           |

## Patterns

**Capability surfaces.** Each capability ships its own `/react` subpath that depends on this package: `<Timeline>` and `useTimeline` from [@agentick/timeline](../timeline), `<Knobs>` and `useKnob` from [@agentick/knobs](../knobs), `useSessionState` from [@agentick/state](../state).

**Model-visible vs. internal state.** `useKnob` is model-visible and model-settable — it surfaces in the knob listing and the model can change it. `useSessionState` survives mounts and hibernate but the model never sees it. Both round-trip through snapshot and restore, and this package iterates the bridges generically to do it — it has no hardcoded knowledge of either slot.

**Formatters.** [@agentick/formatters](../formatters) owns the IR-to-string pass. Framing rules — how a section is wrapped, how blocks become text — belong to the formatter, not to the renderer.

**Shapes.** [@agentick/spec](../spec) owns `RenderedTree`, `ContentBlock`, the lifecycle event types, and `HandlerVerdict`.

## Roadmap & known gaps

- **No uppercase content-block wrappers.** `<Code>`, `<Text>`, `<Image>`, `<Audio>`, `<Video>` are referenced in source comments but not exported. Blocks whose names collide with HTML need `React.createElement` today.
- **`<Model model={adapter}>` sugar.** `useModelRegistration` ships and takes a spec-typed registration. The component that derives it from a live adapter is deferred.
- **`useActiveModel` is construction-bound.** It reads the session's target, so it's stable across ticks rather than reflecting a per-tick model swap.
- **`ActiveModel.capabilities` is provisional.** The capability set is carried over from v1 and not yet frozen — don't build hard branches on its exact shape.
- **`useSession()` status is not reactive.** The bridge exposes no subscription; subscribe to bus events if you need status changes.
- **Renaming the colliding intrinsics** (`code` → `code-block`, and friends) would let them be declared in the JSX namespace cleanly. Open design question.

## Verified by

- `src/__tests__/semantic-html.spec.tsx` — the HTML markup surface end to end: coalescing into one text block, headings, lists, links, images, blockquote, and the markdown / XML / plain-text formatter outputs.
- `src/__tests__/surfacing.spec.tsx` — default `timeline` and `tools` projections, lazy suppression by an override, empty-override suppression, `<Project>` tree position, and provenance staying index-aligned with the entries.
- `src/__tests__/default-projections.spec.tsx` — the `mcpServerInfo` default and its override, including that a server cannot shadow another's alias.
- `src/__tests__/lifecycle.spec.tsx` — every `useOn*` hook, catch-up on mid-tick mount, and unregister on unmount.
- `src/__tests__/tree-interceptors.spec.tsx` — guard and transform registration, per-mount isolation, and unmount cleanup. The end-to-end veto, defer-to-elicitation, and transform-reaches-the-model paths are covered in [@agentick/session](../session).
- `src/__tests__/use-context-info.spec.tsx` — the window / `usedTokens` / `utilization` merge across the two channels.
- `src/__tests__/render-context.spec.tsx` — `useActiveModel` and render-context threading.
- `src/__tests__/create-tool.spec.tsx` — register and unregister, and `use()` capture reaching the handler.
- `src/__tests__/content-blocks.spec.tsx` — every content-block intrinsic and its IR shape.
- `src/__tests__/formatter-scope.spec.tsx` + `formatter-registry.spec.tsx` — subtree formatter framing and `renderedWith` stamping.
- `src/__tests__/positional-sections.spec.tsx` — the container/position law, and the island rule on top of it: an xml island inside a markdown `<System>` and a markdown island inside an xml one (both embedded verbatim, `&` escaped exactly once by the island's own dialect), same-dialect nesting unchanged, and `<FormatScope purpose="section">` actually taking effect on a nested section.
- `src/__tests__/collect.spec.tsx` — `<Output>` forwarding `name` / `description` / `strategy` / `schema` to the declaration.
- `src/__tests__/template.spec.tsx` — `compileTemplate` and `renderTemplate`, the stability loop, and the diagnostics.
- `src/__tests__/hooks.spec.tsx` — `useData` returning a cached value synchronously, blocking the loop until resolve, honoring `awaitTimeoutMs`, and propagating a rejection as a render error; `useSession`; `useLoopControl`.
- `src/__tests__/boundary-diagnostics.spec.tsx` — the once-per-mount `<Suspense>` warning (including nested inside an intrinsic), the error-boundary info diagnostic and its at-most-once rule, and a clean render emitting nothing.
- `src/__tests__/compiler-harness.spec.tsx` + `conformance.spec.tsx` — the phase contract and protocol conformance.
- `src/__tests__/factory.spec.tsx` — the `reactCompiler()` factory: the compiler marker, shared-substrate envelopes landing on the parent bus, dep-less construction mounting end to end on a local substrate, and distinct scopes across dep-less calls.
- `src/__tests__/semantic-wrappers.spec.tsx` — `<H1>`–`<H3>` / `<Paragraph>` reaching markdown heading and paragraph output, byte-identity with the lowercase intrinsics they wrap, document order inside `<Section>`, and inline emphasis nesting.
- `src/__tests__/formatter-registry.spec.tsx` — the `formatter-unresolved` warning diagnostic: emitted once per distinct unresolvable ref (unknown id, unknown format, caller-pinned `renderToString` miss), never for an id miss a format hint rescues, and the tree still renders through the default rather than throwing.

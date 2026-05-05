# Agent Harness

Agentick is a model harness — `<Agent>` components compile JSX into model context, the model emits tool calls, the loop runs. That part is established.

Agentick is also an **agent harness** — a set of programmatic methods on `Session` that let host code drive the agent, observe its state, and invoke its capabilities directly. The two surfaces share the same primitives (one timeline, one tool registry, one execution path); the agent harness just exposes them through TypeScript-native APIs instead of going through the model.

This page covers the host-side surface: methods you call from your code, in TypeScript, with typed inputs and outputs. The model never has to be involved.

## Two doors, one room

Every session capability sits behind two doors:

| Capability            | Model door                                  | Host door                                       |
| --------------------- | ------------------------------------------- | ----------------------------------------------- | ----------- |
| Run a shell command   | `<Bash>` tool                               | `session.shell(cmd)`                            |
| Invoke a tool by name | tool_use in agent loop                      | `session.dispatch(name, args)`                  |
| Run a skill           | implicit `skill` tool                       | `session.skill(name                             | def, opts)` |
| Append to timeline    | `<Message>`, `<Event>`                      | `session.append(entry)`, `session.observe(...)` |
| Subscribe to entries  | `useOnEntry`, `useOnEvent` (component-tree) | session events / channels                       |

The host door is for code that wants the agent's capabilities without LLM-mediated control flow. Same blast radius. Same sandbox. Same registries.

## Tool dispatch

### `session.tools.<name>(input)`

The tool registry exposed as a typed proxy. Any tool registered on the session — JSX-mounted, app-level, or per-execution — is reachable as `session.tools.<name>`.

```tsx
const result = await session.tools.bash({ command: "ls -la" });
// result: ContentBlock[]

// Nested namespaces compose with dot-paths:
const hits = await session.tools.knowify.search({ q: "ledger" });
// → dispatch("knowify.search", { q: "ledger" })
```

The proxy is purely sugar over `session.dispatch`. Property access composes the dot-path; calling it dispatches. Untyped at compile time (the tool registry isn't statically known); throws clear errors at runtime if the tool isn't registered.

### `session.dispatch(name, input)`

The lower-level primitive. Validates input against the tool's schema, executes the handler, returns `ContentBlock[]`.

```tsx
const result = await session.dispatch("bash", { command: "pwd" });
```

Use `tools.<name>` for ergonomics; use `dispatch` when the tool name is dynamic (`session.dispatch(userInput, args)`).

## Shell

### `session.shell(command)`

Sugar over `dispatch("bash", { command })` that joins the result's text content into a single string. Requires a `<Bash>` tool to be mounted.

```tsx
const out = await session.shell("git diff --stat");
console.log(out); // stdout text
```

Useful for headless host-driven shell work. Same sandbox the agent uses — if `<Bash>` is wired to a `localProvider()`, commands run on host; if wired to a Docker provider, they run in a container; etc. The host gets exactly the privileges the agent has, no more.

**Output shape.** The bundled `<Bash>` tool emits stdout, stderr, and exit-code annotations as a single text block on failure:

```
stdout content
[stderr]
stderr content
[exit code: 1]
```

The string is returned as-is — `session.shell()` does not parse or strip. If you need structured `{ stdout, stderr, exitCode }`, dispatch `bash` directly and inspect the content blocks, or wait for the typed shell-result variant in a later phase.

### Errors

If no `<Bash>` is mounted, `session.shell()` throws with a clear hint pointing at `@agentick/sandbox`. Better than silent host exec — the lack of a sandbox should fail loudly so it gets fixed deliberately.

## Skill invocation

Skills get their own surface — a typed, scoped sub-agent with caller-provided result schemas. See [Skills](/docs/skills) for the full spec; the harness side is short:

```tsx
import { z } from "zod";

// Programmatic — typed result via caller-provided schema
const triage = await session.skill("triage", {
  args: { issueNumber: 42 },
  result: z.object({ fixApplied: z.boolean() }),
});
// triage: { fixApplied: boolean }

// Free-form — returns the model's final assistant text
const summary = await session.skill("summarize", {
  args: { content: longText },
});
// summary: string
```

The first argument is either a string (looked up in `app.skills`) or a `SkillDef` directly. The second is `{ args, result?, maxTicks? }`. Without `result`, the skill returns text. With `result`, a transient `submit` tool is registered with the result schema as its input — the model calls it, args are validated, you get a typed value back.

This is the **sub-execution model** — the skill runs as its own focused task, returns a value, doesn't pollute the parent conversation. For the **load-into-context model** (skill body becomes part of the agent's current conversation), use the implicit `skill` tool from the model side. Both are documented in detail on the Skills page.

## Timeline writes

The session timeline is the conversation's source of truth. Three host-facing primitives let you write to it:

### `session.append(entry, opts?)`

The lowest-level primitive. Appends any `TimelineEntry` directly. Bypasses the queue. Optional `{ trigger: true }` runs a tick after appending.

```tsx
await session.append({
  kind: "message",
  message: {
    role: "event",
    content: [{ type: "text", text: "build_completed" }],
    eventType: "build_completed",
  },
});
```

### `session.observe({ type, content })`

Sugar over `append` for event-role messages — ambient observations that should be visible to the model without queueing as a turn.

```tsx
await session.observe({
  type: "file_opened",
  content: "/src/payments.ts",
});

await session.observe({
  type: "user_idle",
  content: [{ type: "text", text: "30 seconds since last interaction" }],
});
```

Use `observe` for "facts the agent should know" that aren't user turns: file events, MCP resource changes, ambient state updates, telemetry the agent can act on if relevant.

### `session.queue(message)`

Existing primitive — queues a message for the next tick. Different timing semantics from `append`/`observe`: it sits in an inbox until execution, then becomes a timeline entry. Use for "user is sending this; respond on next send."

```tsx
await session.queue({
  role: "user",
  content: [{ type: "text", text: "Pause on this for me." }],
});
```

## Entry hooks

The component-tree side of the timeline. Components register handlers that fire when entries are committed.

### `useOnEntry(filter, handler)`

The primitive notification hook. Fires whenever an entry is committed to the timeline — from `append`, `observe`, or the agent loop's commit path.

```tsx
function FileWatcher() {
  useOnEntry({ kind: "message", role: "event", type: "file_opened" }, (entry) => {
    const path = (entry.message as any).content[0]?.text;
    console.log("file opened:", path);
  });
  return null;
}
```

Filter shape: `{ kind?, role?, type? }`. AND semantics — every specified field must match.

### `useOnEvent(type?, handler)` and `useOnMessage(handler)`

Sugar over `useOnEntry`:

```tsx
useOnEvent("file_opened", (entry) => {
  /* events of this type only */
});
useOnEvent((entry) => {
  /* any event-role entry */
});

useOnMessage((message, ctx, state) => {
  /* fires when a message is queued */
});
```

`useOnMessage` retains its existing semantic (queue-time) for backward compatibility. `useOnEntry` is commit-time. See the source comments in `message-context.ts` for the full migration story.

## When to use the harness

Build features through the harness when:

- **Workflow code is in TypeScript**, not in agent reasoning. Iterating a list, reading config, deciding which skill to invoke based on metadata — all easier when you're holding the reins.
- **The result needs to be typed.** `session.skill(skill, { args, result })` returns a typed value. The model calling a tool returns text the host has to parse.
- **The agent shouldn't decide.** Some workflows — deployments, financial ops, anything irreversible — shouldn't be auto-invoked by the model. The host calls them directly.
- **You're driving the agent from a CRON, an HTTP endpoint, a queue.** Headless. No human. The agent harness is the natural surface.

Build features through the model door when:

- **The flow is open-ended.** Triage, research, debugging — work where the model's pattern-matching is the value.
- **Tool selection is part of the task.** "Figure out what to do" is a cognitive job; let the model do it.
- **You want the conversation to record what happened.** Tool calls land in the timeline as part of the agent's turn, naturally auditable.

Most non-trivial agents use both surfaces. The host orchestrates; the model reasons inside individual steps.

## Calling skills from skills

A natural composition: a skill loaded into context (model-driven via implicit `skill` tool) can itself programmatically run other skills via the typed `session.skill(name, opts)` path. The harness reaches _into_ the agent loop too:

```tsx
const Bash = createTool({
  name: "run-typed-skill",
  input: z.object({ skillName: z.string() }),
  handler: async ({ skillName }, ctx) => {
    // Inside a tool handler, ctx exposes the session
    const result = await ctx!.session.skill(skillName, {
      args: { something: "..." },
      result: z.object({ ok: z.boolean() }),
    });
    return [{ type: "text" as const, text: JSON.stringify(result) }];
  },
});
```

The harness isn't separate from the agent — it's just the interface the agent is also able to use, programmatically, when it has structured work to do.

## See also

- [Sessions & Execution](/docs/sessions-and-execution) — session lifecycle, ticks, send/render
- [Skills](/docs/skills) — full skill spec, file format, registry, substitution
- [Tools](/docs/tools) — defining tools, audience, JSX integration
- [Sandbox](/docs/sandbox) — wiring `<Bash>` to a sandbox provider

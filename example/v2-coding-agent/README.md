# example-v2-coding-agent

A **naive coding agent**, driven over the wire by a client — the end-to-end
showcase of the v2 **client ergonomics**.

The agent is the vehicle; the point is what the *client* does with a live
session. Everything the frontend needs comes from **one import**,
`@agentick/client-next` (the batteries-included bundle), and every built-in
session sub-handle self-assembles with no per-harness wiring.

## What it shows

A JSX coding agent runs server-side with tools that reach the v2 substrate
through `ctx`; a decoupled client drives it and consumes the results:

| Ergonomic | Client code | Backed by |
| --- | --- | --- |
| Batteries-included client | `import { createClient } from "@agentick/client-next"` | the core/bundle split |
| Live knobs + client write | `session.knobs.get()` / `session.knobs.set("explainSteps", true)` | `session:channel:knobs-state` (CQRS) |
| Live task status | `session.tasks.subscribe(...)` | `run_shell` → `ctx.tasks.submit(...)` → `session:channel:task-status` |
| Human-in-the-loop approval | `for await (const e of session.elicitations()) e.accept(true)` | `write_file` → `ctx.elicit.confirm(...)` |
| Streamed run | `for await (const ev of handle.events()) …` | `content-delta` / `tool-dispatch-start` events |
| Diagnostics | `session.onLog((e) => …)` | every tool's `ctx.log(...)` |

`session.knobs`, `session.tasks`, `session.elicitations()` appear **only**
because `@agentick/client-next` side-effect-imports the harness `/client`
subpaths — install-to-appear (ADR 87). Use `@agentick/client-core-next`
instead and you opt in per-harness.

## The agent's tools

| Tool | Kind | Demonstrates |
| --- | --- | --- |
| `read_file` / `list_dir` / `grep` | plain, safe | `createTool`, `ctx.log` |
| `write_file` | **elicitation-gated** | `ctx.elicit.confirm(...)` — blocks until the client approves |
| `run_shell` | **task** | `ctx.tasks.submit(...)` — status FSM the client watches |

Plus one `explainSteps` knob the model *or the client* can flip; the agent
re-renders and its system prompt changes.

## Run

```bash
cp .env.example .env    # add OPENAI_API_KEY
pnpm --filter example-v2-coding-agent dev
```

The scenario seeds a throwaway workspace, then asks the agent to list files,
read `greeting.js`, add a `farewell` export (which triggers a client-approved
write), and run it via `node` (which runs as a task). Watch the console: the
`·`-prefixed lines are the client's live subscriptions firing as the run
proceeds.

## Layout

```
src/
  tools.tsx   — read/list/grep + elicitation-gated write_file + task-based run_shell
  agent.tsx   — the CodingAgent JSX (System prompt, tools, knob, Timeline)
  server.ts   — gateway + app hosting the agent (createGateway → listen → createApp)
  client.ts   — connect over in-process transport + drive the session (THE showcase)
  index.ts    — wires server + client, runs the scenario
```

The server and client are fully decoupled. Swap `inProcessTransport` in
`client.ts` for `webSocketTransport(url)` and the identical client code drives a
remote browser session — the whole reason the sub-handles ride the wire.

## Status

🚧 v2 example (`feat/v2`). Typechecks against the live v2 packages; runs with an
`OPENAI_API_KEY`. It is intentionally naive — no edit-diff tool, no verify gate,
no sandbox isolation (`write_file`/`run_shell` hit the real scratch dir). It
exists to exercise the client surface, not to be a production coding agent.

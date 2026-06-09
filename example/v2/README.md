# example-v2

Substrate driver for the in-progress v2 rewrite. Exercises every harness
surface that exists today.

## Running

```bash
pnpm --filter example-v2 dev
```

## What this proves

The substrate (`@agentick/runtime-next`) and the two harnesses that exist
today (`@agentick/reconciler-react-next`, `@agentick/tool-executor-next`) compose
into something an application author can use end-to-end:

1. **Mount a JSX agent** → produce a `RenderedTree` IR
2. **Render to markdown** via the reconciler harness
3. **Register tools** from the rendered tree's declarations
4. **Dispatch tools** through the tool executor — happy path, abort,
   failure
5. **Context plumbing through `ctx`** — `whoami` tool reads
   `sessionId` / `executionId` / `tickId` / `toolCallId` from the
   harness-supplied `ctx` (second arg to the handler). The substrate
   owns a FiberRef-backed `RuntimeContext` for the _Effect_ side; the
   harness mirrors it into `ctx` for Promise-typed tool handlers.
6. **Bus subscription** — every harness operation publishes on the same
   `EventBus`; one Stream observes both
7. **Journal audit** — durable record of every `requested` / `terminal`
   envelope for replay / crash recovery / OTel projection
8. **Inbox tell** — send a `recompile` / `unmount` / `invalidate`
   message to the reconciler harness by address. The same call shape
   works once a `ClusterInbox` substitutes the local impl.

## What's NOT here (waiting on later phases)

The substrate is locked. The harness model is locked. The orchestration
glue around them isn't built yet:

- **Executor harness (Phase 4c)** — language-model invocation, token
  streaming. Without it we can't actually call a model.
- **Loop executor (Phase 4d)** — multi-tick orchestration, `useLoopControl`
- **Session harness (Phase 4e)** — `app.session(id).send({ messages })`,
  per-session timeline, channel routing
- **App harness (Phase 4f)** — `createApp(<Agent />, { model })` entry
  point, lifecycle handlers at app/session/global scope

The structure of this example anticipates those harnesses landing — each
scenario is a function that can grow into a richer demo as the harness
behind it ships.

## What this surfaces as friction

This example is also a friction-finder for the v2 API. The list below
is what currently feels awkward and should be addressed before v2
stabilizes:

- **No user-facing component wrappers.** `<Section>`, `<Message>`,
  `<H2>`, etc. live in `src/components.tsx` here — they should graduate
  into a v2 package (`@agentick/components` or merge into
  `@agentick/reconciler-react-next`).
- **`<Tool>` element accepts JSON Schema, not Zod.** The spec firewall
  bans function references on declarations, so Zod schemas need to be
  serialized to JSON Schema before they hit the JSX. v1's `createTool`
  helper handled this; v2 needs an equivalent.
- **Tool registration is two-step.** Declarations come from the rendered
  tree; handlers register separately into the resolver. The session
  harness (Phase 4e) should auto-register handlers via a `useTool` hook
  or convention.
- **Bridges are stubs.** Real timeline / knob / data bridges land with
  the session harness.
- **FiberRef context is invisible to Promise tool handlers.** The
  example originally tried `await Effect.runPromise(getContext)` inside
  a tool handler — that returns `EMPTY_CONTEXT` because the Promise
  body runs outside the Effect fiber that owns the FiberRef. Open
  design question: do we (a) accept Effect-typed `ToolHandler` so the
  FiberRef propagates naturally, (b) keep Promise handlers and rely on
  the harness-plumbed `ctx` (current behavior), or (c) both? Today
  the example uses `ctx.sessionId` and friends — the working pattern.

## File map

```
src/
  components.tsx   — JSX wrappers (<Section>, <Message>, <H2>, <Tool>, …)
  agent.tsx        — the example JSX agent
  tools.ts         — tool handlers + InMemoryHandlerResolver setup
  substrate.ts     — journal + bus + inbox + harness wiring
  index.ts         — scenario runner; entry point
```

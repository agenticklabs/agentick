# @agentick/client-next

**The batteries-included agentick client — the default.**

Re-exports everything from [`@agentick/client-core-next`](../client-core) (the
lean, harness-agnostic core) **and** side-effect-imports every built-in
`/client` subpath, so their session sub-handles ([ADR 87](../../docs/proposals/v2/blueprint/87-client-sub-handles.md))
self-assemble on the client `SessionHandle` with **no per-harness imports**:

```ts
import { createClient } from "@agentick/client-next";

const client = await createClient({ transport });
const session = client.session(id);

// Every sub-handle is a ClientHandle: list() / get(id) / subscribe(cb) + verbs.
session.tasks.list(); // TaskInfo[]                      — @agentick/tasks-next/client
session.knobs.list(); // WireKnobDescriptor[] (+values)  — @agentick/knobs-next/client
await session.knobs.set("temperature", 0.7);
session.timeline.list(); // TimelineEntry[]              — @agentick/timeline-next/client
session.elicitations.subscribe(() => {  // pending asks  — @agentick/elicitation-next/client
  for (const e of session.elicitations.list()) void e.accept({});
});

// Client-handled tools — @agentick/tool-executor-next/client
// A client is a declarative tool SOURCE: declare the FULL set; the framework
// replaces the client slice wholesale (the wire twin of replaceCompilerTools).
const calls = session.clientToolCalls;
await calls.set([{ name, description, inputSchema }]); // whole-slice replace, no handler
calls.route({ open_file: async ({ path }) => read(path) }); // dispatch → auto-respond
calls.confirm("approve"); // policy over tool_confirmation asks
```

That's the whole package: three side-effect imports + `export * from
"@agentick/client-core-next"`. It carries no logic of its own.

## Tool results may be truncated on the wire (ROADMAP A3)

Content a client receives — folded timeline entries (`session.timeline` /
`timelineView`), `session.send` results, and progress/subscription
notifications — **can be truncated at the gateway** so a multi-megabyte tool
result never floods the browser. This is **opt-in and OFF by default** (output
shaping is app-UX policy, not a framework default — unlike security defaults,
which protect the operator and ship on); a deployment turns it on with
`createGateway({ truncateToolResults: true })` (see the gateway README). Only
oversized _tool output_ is affected (a `tool_result` block's inline text/data
over the threshold); ordinary messages and small results pass through untouched.
A truncated block carries `block.metadata.bounded` (`{ truncated: true,
originalBytes, retainedBytes, reason, hint }`) — check it when rendering to show
a "truncated — N bytes" affordance. The full content is never lost: it lives in
the durable timeline store server-side (reachable via a future
`timeline_history` read).

## Core vs bundle

| Package                      | What                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| `@agentick/client-next`      | **This package.** Batteries-included — core + every built-in `/client`. |
| `@agentick/client-core-next` | The lean, harness-agnostic core. Opt in to built-ins per-harness.       |

Use **this package** for the default experience (everything works). Drop to
`@agentick/client-core-next` when you want minimal imports and will add only the
`/client` subpaths you need. The full client API — `createClient`, the
`GatewayHandle` / `AppHandle` / `SessionHandle` surface, `channelView`, the
sub-handle registry, hooks — is documented in the
[`@agentick/client-core-next` README](../client-core).

This is the client twin of how the public `agentick` metapackage bundles the
server built-ins (ADR 27 — bundled, not privileged). At the v2 cut these become
`@agentick/client` (this bundle) + `@agentick/client-core`.

## Adding a built-in to the bundle

A new built-in harness that ships a `/client` subpath (a `register.ts` that
augments `SessionHandleExtensions` + calls `registerSessionHandleExtension`)
becomes automatic here by adding one line to `src/index.ts`:

```ts
import "@agentick/<harness>-next/client";
```

## Status

🚧 In active development as part of v2 (`feat/v2`). Interim stand-in for the
public `agentick/client` metapackage entry until the v2 cut.

## Verified by

- `src/__tests__/bundle.spec.ts` — importing the bundle registers every built-in
  slot; a session handle self-assembles `.tasks` / `.knobs` / `.elicitations`
  / `.clientToolCalls` / `.timeline` (each a `ClientHandle`) with no per-harness
  imports.

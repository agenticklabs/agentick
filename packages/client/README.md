# @agentick/client

**This is the client to install.** Every built-in capability's client surface —
timeline, tools, tasks, knobs, elicitations, skills, prompts, resources, state,
gates — is already on the session handle, typed, with nothing to register. Reach
for [@agentick/client-core](../client-core) only when you are trimming a bundle
and will register the capabilities you use yourself.

Installing a capability on the server shouldn't mean wiring it on the client, and
this package is the proof: one import, and the whole surface is there.

It carries no logic of its own. It re-exports
[@agentick/client-core](../client-core) and side-effect-imports every built-in
`/client` subpath, so each one types its slot and registers its factory. Ten
imports and one `export *` — that is the entire source file. The interesting
property is that a first-party capability and one you write are assembled by
exactly the same mechanism.

## Install

```bash
npm install @agentick/client
```

You still pick a transport:
[@agentick/transport-websocket](../transport-websocket),
[@agentick/transport-http](../transport-http),
[@agentick/transport-unix-socket](../transport-unix-socket), or
[@agentick/transport-in-process](../transport-in-process).

## Quick start

```ts
import { createClient } from "@agentick/client";
import { websocket } from "@agentick/transport-websocket/client";

const client = await createClient({
  transport: websocket({ url: "wss://example.com/agentick" }),
});
await client.connect();

const session = client.session("sess-123");

// Every slot below exists because of the single import above.
session.timeline.subscribe(() => render(session.timeline.list()));
session.tasks.subscribe(() => showQueue(session.tasks.list()));
await session.knobs.set("temperature", 0.7);

const run = session.send({ messages: [{ role: "user", content: "start the migration" }] });
await run.result;
```

`createClient`, the gateway / app / session handles, `client.use`, `client.hook`,
the fold kit, the extension surface — all of it is
[@agentick/client-core](../client-core)'s, re-exported unchanged. Read that
README for the client API itself; this one covers what the bundle adds.

## What the import lights up

Every slot is a `ClientHandle`: `subscribe(cb)` fires on change with no
arguments, `list()` reads the current snapshot, and each carries its own verbs.
That uniformity is what makes `useSyncExternalStore` — and therefore
[@agentick/client-react](../client-react)'s `useHandle` — work on all of them
without a per-slot adapter.

| Slot                      | `list()` yields           | Verbs                                                              | From                              |
| ------------------------- | ------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `session.timeline`        | timeline entries          | `seed` · `prepend` · `append` · `clear` · `loadOlder` · `view`     | [timeline](../timeline)           |
| `session.tasks`           | task records              | `cancel`                                                           | [tasks](../tasks)                 |
| `session.knobs`           | knob descriptors          | `set` · `use`                                                      | [knobs](../knobs)                 |
| `session.elicitations`    | pending asks (as handles) | `respond` + per-ask `accept` / `decline` / `cancel`                | [elicitation](../elicitation)     |
| `session.clientToolCalls` | pending client calls      | `set` · `route` · `confirm` · `respond`                            | [tool-executor](../tool-executor) |
| `session.tools`           | tool descriptors          | `dispatch` · `refresh`                                             | [tool-executor](../tool-executor) |
| `session.gates`           | gate records              | `clear` · `defer` · `override` · `refresh`                         | [gates](../gates)                 |
| `session.skills`          | skills                    | `search` · `register` · `update` · `remove` · `refresh`            | [skills](../skills)               |
| `session.prompts`         | prompt declarations       | `render` · `invoke` · `register` · `update` · `remove` · `refresh` | [prompts](../prompts)             |
| `session.resources`       | resource descriptors      | `listTemplates` · `read` · `refresh`                               | [resources](../resources)         |
| `session.state`           | key/value rows            | `set` · `delete` · `refresh`                                       | [state](../state)                 |

Slots are lazy, cached getters — a slot's subscription or first poll happens on
first property access, not when you build the handle. Touch none and you pay for
none.

### Reading and steering a conversation

```ts
const session = client.session(id);

// The timeline handle IS your state, or feeds it — both are first-class.
session.timeline.subscribe(() => render(session.timeline.list()));

onScrollTop(async () => {
  const { done } = await session.timeline.loadOlder(50); // tail-anchored, spliced at the head
  if (done) detachScrollHandler();
});

// A second concurrent projection over the SAME wire subscription.
const modelOnly = session.timeline.view({ filter: (e) => e.visibility === "model" });
```

### Asking what the server knows about a model

The client never derives model facts. An adopter's `models` registry is merged
over the seed catalog **server-side**, so a client resolving from the seed alone
would compute a different answer than the server actually used.

**Use the session verb for anything about the current conversation.** It reads
the session's LIVE target, so it follows a runtime model change — `setModel` /
`setTarget`, a spawn override, a per-tick `<Model>` — and it answers before the
first turn, where message provenance cannot.

```ts
const current = await client.session(id).modelInfo();
current?.modelId; // "gemini-3.6-flash" — what THIS session will call next
current?.info?.contextWindow; // 1048576 — the denominator for a usage gauge
current?.info?.pricing?.outputPerMTok; // 7.5
current?.info?.capabilities?.supportsVision; // gate an attach button on this, not a hardcoded list
```

`null` when the session has no model bound — a legal state, not a failure.

The app-scoped verb answers a different question: **what is model X?** Reach for
it when the model is not the session's current one — pricing out a history where
each turn may have run on a different model, or filling a model picker.

```ts
// Every assistant entry carries the model that produced it.
const last = session.timeline.list().findLast((e) => e.message?.role === "assistant");
const stamp = last?.message.metadata?.model; // { provider, modelId }

const { info } = await client.app(appId).modelInfo(stamp.provider, stamp.modelId);
info?.pricing?.outputPerMTok; // what THAT turn was billed at
```

`info` is `null` when no layer describes that model. That is an answer, not an
error — the catalog never fabricates, so a gauge with no denominator should
render _unknown_ rather than zero.

The reply is **static** for a given model: cache it for the life of the page and
re-fetch only when the provenance changes. There is deliberately no push. A
model change is announced by the next assistant entry carrying a different
`metadata.model`, and a second path to one fact is worse than one path that is a
turn late — two sources can disagree, and the client would have to arbitrate.

A context-window gauge needs both halves, and the numerator is already local:

```ts
const used = last?.message.metadata?.usage?.inputTokens;
const window = current?.info?.contextWindow;
const ratio = used && window ? used / window : undefined; // undefined ⇒ render unknown
```

One caveat worth designing around: `usage` is what the LAST request carried, so
the gauge reads "as of your last turn", and it is empty until the first one
completes. Both are honest — a fresh conversation has no measured usage, and
rendering zero would claim otherwise.

### Answering the server

Two slots are request-shaped: the server asks, the client replies. Both list
their pending items — including ones that arrived before this client connected —
so a page reload doesn't strand a dialog.

```ts
// Elicitations: a listed ask carries its own reply verbs.
session.elicitations.subscribe(() => {
  for (const ask of session.elicitations.list()) {
    void ask.accept({ approved: true });
  }
});

// Client-handled tools: declare the FULL set, then route.
await session.clientToolCalls.set([
  { name: "open_file", description: "Open a file in the editor", inputSchema },
]);
session.clientToolCalls.route({
  open_file: async (input) => {
    const { path } = input as { path: string };
    return [{ type: "text", text: await readFile(path) }];
  },
});
session.clientToolCalls.confirm("approve"); // blanket policy for confirmation asks
```

`set` is a whole-slice replace: the declaration array _is_ the truth for this
client's tools, so a tool absent from it is unregistered. `route` dispatches each
inbound call to your handler and relays the result; a handler that throws is
answered with an error result, so a suspended call is never left hanging.

## Bundle or core

| Package                                 | What                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `@agentick/client`                      | **This package.** Core plus every built-in `/client` subpath, imported. |
| [@agentick/client-core](../client-core) | The core alone. Add the `/client` subpaths you want.                    |

Use this one unless you're bundle-size sensitive or genuinely need only two
capabilities. Dropping to the core costs you one `import "@agentick/x/client"`
line per capability and nothing else — the slot mechanism is identical.

If you do drop to the core and forget a line, reading the slot throws and names
the import to add — so on this bundle that throw can only mean an _optional_
capability (`@agentick/live/client`) you meant to add.

## Adding your own capability

A capability that ships a `/client` subpath joins this bundle by adding one line
to `src/index.ts`:

```ts
import "@agentick/<name>/client";
```

That subpath does two things — augments `SessionHandleExtensions` to type the
slot, and calls `registerSessionHandleExtension` to register the factory. Nothing
in this package or in the core knows the slot's name. Your own package can do the
same without touching either; see
[@agentick/client-core](../client-core#sub-handles-install-to-appear).

## Tool results may be truncated on the wire

Content a client receives — folded timeline entries, `send` results, subscription
notifications — **can be truncated at the gateway** so a multi-megabyte tool
result never floods a browser. It is opt-in and off by default; output shaping is
application policy, not a framework default. A deployment turns it on with
`createGateway({ truncateToolResults: true })` (see [gateway](../gateway)).

Only oversized _tool output_ is affected — a `tool_result` block whose inline text
or data exceeds the threshold. Ordinary messages and small results pass through
untouched. A truncated block carries `block.metadata.bounded`:

```ts
import { BOUNDED_METADATA_KEY, type BoundedContentMarker } from "@agentick/spec";

const marker = block.metadata?.[BOUNDED_METADATA_KEY] as BoundedContentMarker | undefined;
if (marker?.truncated) {
  show(`truncated — ${marker.retainedBytes} of ${marker.originalBytes} bytes · ${marker.hint}`);
}
```

The full content is never lost: it lives in the durable timeline store on the
server, reachable through `session.timeline.loadOlder()`.

## Roadmap & known gaps

- **All-or-nothing bundling.** Importing this package registers all eleven slots
  and pulls in all eleven capability packages. There is no subset bundle; a
  tree-shaking build cannot drop a slot you never touch, because registration is
  a side effect of the import. Use the core directly if that matters.
- **RPC-backed slots poll rather than subscribe.** `gates`, `tools`, `skills`,
  `prompts`, `resources`, and `state` refresh on construction and after their own
  mutations. A change made by another client, or server-side, is not pushed —
  call `refresh()`. The fold-backed slots (`timeline`, `tasks`, `knobs`,
  `elicitations`, `clientToolCalls`) are live.
- **No bundle-level integration coverage.** The tests here prove the slots
  register and self-assemble; each slot's behavior is proven in its own package,
  and no test drives several of them against one live gateway at once.

## Verified by

- `@agentick/transport-in-process/src/__tests__/model-info-e2e.spec.ts` —
  both model-info verbs over a real gateway and transport: the seed answer,
  longest-prefix on a dated model id, `null` for an unknown model, the adopter
  registry beating the seed (the reason the client asks rather than derives),
  the `tokenEstimator` function never crossing the wire — and the session verb
  following a runtime `setTarget` swap that the app-scoped lookup cannot see.
- `src/__tests__/bundle.spec.ts` — importing the bundle registers all eleven
  built-in slots, and a session handle self-assembles every one of them with no
  per-capability imports (each asserted down to its read and write members).
- `src/__tests__/sub-handle-dictionary-anti-rot.spec.ts` — client-core's slot →
  `/client` specifier dictionary agrees with the live registry in both
  directions, so a renamed or removed slot, a wrong specifier, or a new built-in
  that forgot its entry fails here rather than degrading into a confusing wire
  error for an adopter.
- `src/__tests__/wire-proxy-middleware-e2e.spec.ts` — end-to-end over a real
  client and transport: a wire method with no client code written for it is typed
  and round-trips; one `client.use` middleware is observed on both that
  synthesized method and `session.knobs.set`; `session.knobs.use` scopes to the
  `knobs/*` namespace and unsubscribing restores.
- Each slot's own behavior is covered in its package — see the "From" column
  above; the shared handle contract is certified by `runClientHandleConformance`
  from [@agentick/client-core](../client-core)`/testing`, which `timeline`,
  `tasks`, `knobs`, `elicitation`, and `tool-executor` each run against their
  handle.

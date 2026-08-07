# Client tools, and the context they run in

**Status:** superseded by [`packages/tool-executor/README.md`](../../../packages/tool-executor/README.md#client-handled-tools), which documents what shipped.

Layers 1–3 landed as proposed. **Layer 4 did not.** This document proposes
`accepts` — a per-tool predicate each client evaluates to decide whether a call
is its to answer — and that was cut before release. A rule evaluated
independently by N clients is only sound when it compares against a value the
server chose, which is not something to ask every tool author to rediscover. It
was replaced by server-stamped addressing: the server marks each call with the
`clientId` that asked for the turn, and the client compares. `createClientTool`
also shipped as `createTool`, from `@agentick/tool-executor/client`.

Read this for the reasoning that produced the design. Read the README for the
design.

Four layers, discovered top-down and built bottom-up. `createClientTool` is the
visible defect; fixing it fixes a handler signature, which is the one thing that
is expensive to change after adopters write handlers. So it lands last.

```
4. createClientTool + app.tools.set + notFound + accepts       ← the visible defect
3. ClientToolCtx / ClientToolAcceptCtx                        ← what a handler receives
2. ClientRuntimeContext                                       ← the trunk
1. Observability on the client (log · trace · metrics)        ← build first
```

---

## Layer 1 — Observability on the client

The server trunk is three facets (`packages/spec/src/data/observability.ts:253`):

```ts
interface Observability {
  readonly log: Log;
  trace<T>(name: string, fn: (span: Span) => T | Promise<T>): Promise<T>;
  readonly metrics: Metrics;
}
```

Mirror the **facet names and the discipline**, not the implementation:

- **`log` is always present and always live**, independent of the telemetry
  switch. No `ctx.log?.()` anywhere.
- **`trace` is passthrough when off** — runs `fn` with a no-op span and zero
  machinery, so authors write traced code unconditionally and pay nothing.

**BUILT** — a TOP-LEVEL namespace, the twin of `createApp({ telemetry })`:

```ts
createClient({ transport, telemetry: { adapter, sample, serviceName } });
```

One object, two consumers. `@agentick/client-core` reads `adapter` for the ctx
facets; `@agentick/client` takes the same option and ALSO installs the wire-span
extension from it. The adapter cannot be passed twice, so the two span trees
cannot diverge.

Wiring the extension in the metapackage rather than the core is ADR 27 doing its
job — the lean core must not depend on `client-extensions`, and bundling
built-ins is what a metapackage is for. It also sets the pattern: **a built-in
extension that takes config gets a named option on the metapackage's
`createClient`**, rather than making adopters hand-build an `extensions` entry.
The sub-handle built-ins need none, so telemetry is the first member.

The adapter contract moved to `@agentick/spec` (`TelemetryAdapter` /
`TelemetrySpan`) so both packages reach it; `log` and `metrics` were added as
OPTIONAL members so the ctx facets have somewhere to go without a second seam.
Every pre-existing adapter still satisfies it.

### The constraint that does not port

Server-side span parenting uses the ADR 77 ambient-fiber mechanism — documented
as "the ONLY parenting path". That is `AsyncLocalStorage`, which **does not exist
in a browser**. A module-level current-span stack looks equivalent and silently
misparents as soon as two async handlers interleave, which is the normal case
with several tabs.

**Parent explicitly from the ctx.** `ctx.trace(name, fn)` nests under _this
context's_ span, not an ambient one. It gives up free nesting inside a handler's
own helpers; it cannot lie. Misparented spans are worse than flat ones, because
they read as truth.

### Wire propagation — BUILT, both halves

`@agentick/client-extensions`' `telemetry()` extension has propagated
`_meta.traceparent` all along. Two corrections landed:

- **It was written UNTYPED.** `RequestMeta` was `{ progressToken? }`, so the wire
  carried a field the contract did not describe — invisible to anyone
  implementing a client in another language. Now specced.
- **The sampled bit was hardcoded `01`.** A method the `sample` predicate rejects
  propagates context but opens no span, so the trace announced a client half that
  was never recorded. `generateTraceparent(sampled)` now reports the truth.

The SERVER half is now built, and it is not "seed the root":

```
ignore  — drop it; two trees, as today
link    — record the client span as a LINK on the server's root   ← default
parent  — adopt it; one tree, and you inherit the client's sampling decision
```

A browser is untrusted and `traceparent` is attacker-controllable. Honouring it
blindly lets any client force 100% sampling — driving someone else's telemetry
bill — and lets a crafted trace id join or pollute another trace. OTel's own
guidance for public endpoints is not to trust a remote parent by default.

`link` keeps correlation without inheriting a stranger's sampling decision.
`parent` is right for a first-party product and is a deliberate opt-in, matching
how `web-security` ships closed and widens explicitly.

```ts
await createGateway({ telemetry, remoteParent: "parent" }); // default: "link"
```

The decision is made ONCE, at the wire boundary, and encoded in **which scope
field** it writes — `traceparent` to adopt, `traceLink` to link. The substrate
(`operation-runner`) applies whichever field is present and knows nothing about
the policy; that is what keeps a trust decision at the wire and mechanism in the
substrate. Because `wire:<method>` IS the root op and the fields are read off
`op.scope` rather than ambient context, a remote parent can only ever apply at
the root — no guard needed to stop a child inheriting it.

An unparseable header is dropped, never an error: a malformed `traceparent` is a
fact about the caller, not grounds to fail their request. Values are re-serialised
from the parse, so what reaches the substrate is always canonical.

### Effect posture — settled, recorded so it is not relitigated

The client is **Promise-native by policy**, the inverse of the server:

```
server:  Effect-native core.  `.fx` is canonical (ADR 77, the dual-typed edge);
                              the Promise method is the derived facade.
client:  Promise-native core. Effect is an opt-in ADAPTER (`effectMiddleware`).
```

> _"The canonical client middleware is Promise-based (most adopters write trivial
> wrappers); Effect-flavored authors get an opt-in via this adapter."_
> — `client-core/src/effect-middleware.ts`, ADR 33 §"Why the client is Promise-native"

So **no `.fx` twins on client surfaces**, and `createClientTool`'s handler stays
`async (input, ctx) => ContentBlock[]`. The asymmetry is deliberate: server
extension authors write inside the substrate where Effect is the medium; client
extension authors are Angular and React developers. If Effect-flavored client
authors appear, the precedent is a second adapter, not a dual-typed edge.

**This is not why parenting is explicit.** Effect's `FiberRef` propagates inside
Effect computations only — the moment a handler does a raw `await`, a nested
`ctx.trace` cannot be attributed to the outer span. Effect-all-the-way-down would
be required, which is the imposition just rejected. Explicit parenting stands on
its own merits.

**Open, unrelated to this design:** `effect` is a RUNTIME dependency of
`client-core`, not a type-only one — `client.ts:64` value-imports
`{ Deferred, Effect, Stream }`, and `interrupt` is initialised with
`Effect.runSync` at construction, so it is not tree-shakeable behind the opt-in.
Ten call sites, all serving one feature (the interruptible `ClientEventStream`):
a promise with external resolve, and an interruptible mapped async iterable.
Worth measuring what it costs a browser bundle; if it is material, ~40 lines of
plain JS replaces it and the client becomes Promise-native in weight as well as
in policy.

---

## Layer 2 — `ClientRuntimeContext`

**BUILT** — `client.runtime`.

```ts
interface ClientRuntimeContext extends Observability {
  readonly clientId: string;
  /** `undefined` before the first handshake, and NEW after every reconnect. */
  readonly connectionId: string | undefined;
  activeSpan(): ClientSpanContext | undefined;
}
```

The trunk every client-side context extends. Deliberately small: identity the
framework mints, plus the three observability facets.

Two corrections to the sketch above, found in the build:

- **`connectionId` is optional and READ, never captured.** It arrives with the
  handshake, so it does not exist before one, and a reconnect mints a new one. A
  value copied at construction is stale for the rest of the session — and a stale
  connection id is exactly how a targeted tool call gets addressed to a
  connection that is gone. Identity is supplied as thunks.
- **One observability instance for the client's lifetime.** Span nesting lives on
  it, so a trunk that rebuilt it per read would orphan every child span.

---

## Layer 3 — what a handler receives — BUILT

**The filter: only what closure cannot provide.** Server-side `use()` exists
because a handler runs at dispatch and cannot reach render-time context. That
problem does not exist in a browser — the handler is authored inside the app and
closes over the router, the injector, the stores. So ctx must not become a
service locator; the closure already is one. Same ddmin criterion as
`packages/model/src/index.ts`: does this require knowledge only the framework
has?

```ts
interface ClientToolCtx extends ClientRuntimeContext {
  readonly toolCallId: string;
  readonly name: string;
  /** Addressed connection, when the call carries one. */
  readonly target?: string;
  /** Which connection asked, and what it said about itself. */
  readonly origin?: { readonly connectionId: string; readonly metadata?: ClientMetadata };
  /** The execution died — stop. */
  readonly signal: AbortSignal;
  readonly progress?: (update: ProgressUpdate) => void;
}
```

`signal` is the one that gets forgotten and then hurts: a client tool mid-fetch
when the user hits stop has no way to know today.

`origin.metadata` is where the `ClientMetadata` the app already sends comes back
— a handler sees the asking tab's route and platform without re-plumbing it.

**Extensible by augmentation**, following ADR 27 — built-ins are not privileged:

```ts
declare module "@agentick/tool-executor/client" {
  interface ClientToolCtxExtensions {
    elicit: ClientElicitor;
  }
}
```

Cheap now; a retrofit after adopters depend on a closed interface is not.

### A separate, narrower context for `accepts`

```ts
interface ClientToolAcceptCtx {
  readonly name: string;
  readonly input: unknown;
  readonly self: string;
  readonly target?: string;
  readonly origin?: { connectionId: string; metadata?: ClientMetadata };
}
```

No `log`, no `trace`, no `progress`, no `respond`. A predicate runs in **every
attached client** — side effects there multiply by tab count, and a channel is an
invitation someone eventually accepts. It gets `input`, because acceptance can
legitimately depend on arguments.

### Deliberately absent

- **The session handle.** Reachable by closure, and putting it on ctx invites a
  handler to send or read the timeline mid-call — reentrancy nobody wants.
- **Anything app-shaped** (`router`, `store`). The moment ctx carries app
  services it stops being a framework contract.

---

## Layer 4 — `createClientTool` — BUILT at session scope

### The defect

A client-executed tool is authored in two halves the framework never joins:

```ts
session.clientToolCalls.set([{ name: 'read_selection', description, inputSchema }]);
session.clientToolCalls.route({ read_selection: async (input) => … });
```

The join is a **string**, unchecked, failing quietly in both directions: a
declaration with no handler suspends every call until it times out; a handler
with no declaration is never invoked.

An adopter wrote the warning by hand
(`knowify-app/src/ai/services/client-tool-handlers.ts`):

> _"Declare and handle the same names: a declaration with no handler suspends
> every call until it times out, and a handler with no declaration is never
> called."_

That paragraph exists because the API cannot enforce it. The same file carries
two DI tokens, two provider factories, and a hand-rolled handler type — eighty
lines whose only job is to carry two halves of one thing.

### The shape

```ts
const readSelection = createClientTool({
  name: "read_selection",
  description: "What the user currently has highlighted",
  inputSchema: z.object({ includeHtml: z.boolean().optional() }),
  handler: async (input, ctx) => [{ type: "text", text: getSelection() }],
});

await client.app("ernesto").tools.set([readSelection, navigateTo]);
```

Field names mirror `createTool` so the two read as one idea at different
locations. **The declaration is a projection, never authored** — `set` drops
`handler` and runs `inputSchema` through `toJsonSchema` (already in
`@agentick/spec`, already shipped to the client). The halves become
unconstructable apart.

### Authored by the client, granted per app — NOT BUILT

What shipped is `session.clientToolCalls.use(tools, { notFound })` — the join
closed at the scope that needed no new plumbing. `app.tools.set` needs three
things that do not exist: an `AppHandleExtensions` seam, `appId` threaded into
session handles, and a session-touch notifier so sessions opened LATER receive
the grant. Worth building — but paired with the connection stamp below, since
`accepts` cannot bite without it.

Two different questions, and conflating them gets one of them wrong:

**Authoring is client-side.** A tool describes what _this client_ can do — a
mobile client navigates mobile routes, a browser tab reads a DOM selection. The
handler lives here. `appId` is a server-side composition identity and has no
opinion about what a browser can execute.

**Granting is per app.** Which app may _call_ a capability is a separate decision
from who implements it. A client can talk to several apps, and offering every
capability to every one of them is a default that is fine until one of those apps
belongs to a different team.

```ts
const readSelection = createClientTool({ … });   // authored once, here
const navigateTo    = createClientTool({ … });

client.app('ernesto').tools.set([readSelection, navigateTo]);
client.app('other').tools.set([readSelection]);   // no driving my UI
```

`set` is a **grant across a trust boundary**, and grants are per grantee. Note
this is not "the app owns the tool list" — that framing was tried and rejected,
because it makes a server-side identity the author of a browser capability.

**No convenience "grant to every app."** It buys nothing — a client with one app
writes one call either way — and it is exactly the over-granting default the
split exists to avoid. A second app should be a deliberate second line.

The wire is unchanged: `session/set_client_tools`, published per session, with an
app's granted set applied to each session of that app — **including sessions
opened later**. If it only reached open sessions, adopters would call it per
session and the defect would have moved rather than closed.

`notFound` stays client-level: it answers calls that arrive, and is not a
capability offered to anyone.

### `set` replaces

Whole-slice, matching the wire verb:

> _"subsumes register, unregister, and idempotency (the set IS the truth — it's a
> replace, not an accumulate). Reconnect = re-declare; drift-free by
> construction."_

A delta API needs client and server to agree on history across a disconnect; miss
one `remove` and the server holds a tool nobody can run, forever. `add`/`remove`
would be sugar recomputing and republishing the slice — omitted until something
contributes tools from more than one place.

### `notFound`

```ts
client.tools.notFound(async (input, ctx) => { … });
```

Single slot, last write wins. Unset, the current default stands: an error result
reading `no client handler for "<name>"`.

Named for the router condition — no handler matched the name, the same shape as
no route matched the URL. Not `onUnknown`: `on*` reads as an observer, and this
must RETURN a result.

**A named slot, not a wildcard member.** Angular (`path: '**'`) and React Router
(`path: '*'`) put the catch-all in the route collection; TanStack uses a named
option. TanStack's shape survives here because a route table is LOCAL and a tool
set is a WIRE PAYLOAD — `set` publishes declarations the model is offered. A `'*'`
member would either declare a tool literally named `*` to the model, or force one
element of a homogeneous array to mean something categorically different.

**It survives the merge because the mismatch is temporal, not authorial** —
declarations and calls happen at different moments:

- a `set` that removed a tool, with a call already in flight;
- a resumed session routing a call before this client republished — the
  client-tool slice is server-side state that outlives a page load;
- deploy skew: a tool dropped in a new bundle, an old session still holding a
  queued call.

---

## Connection targeting

Multiple connections attach to one session. Today the tool-call channel
broadcasts to all of them and the router **dispatches the handler locally before
responding** — so four tabs receive `navigate_to` and **four tabs navigate**. The
respond race dedupes the answer; the side effect already happened four times.

Naming does not solve this: all four declare the same `navigate_to`, so
name → declaring connection is one-to-many.

Three layers, each able to correct the one above:

1. **The framework stamps the originating connection.** The send arrived on a
   connection; the execution inherits it. Right almost always — the user asked
   from the tab they are looking at.
2. **The model may override**, for "open that on my other tab". Optional, never
   required: a mandatory parameter is a per-call opportunity to be wrong for a
   value that is right by default. Only on tools declared targetable — most
   client tools have exactly one sensible destination.
3. **`accepts` is the client's last word**, because the right rule differs per
   tool:

```ts
createClientTool({
  name: "navigate_to",
  accepts: ({ target, self }) => target === undefined || target === self,
});
createClientTool({ name: "read_selection", accepts: () => document.hasFocus() }); // NOT the target
createClientTool({ name: "show_toast", accepts: () => true }); // every tab, deliberately
```

`read_selection` proves the point: the correct handler is not the addressed
connection, it is the focused one, and no framework rule can know that.

**The stamp is NOT BUILT.** `ToolCallRequestPayload` carries `toolCallId`, `name`
and `input` — no originating connection. `accepts` receives `target: undefined`
today, so `target === undefined || target === self` accepts everywhere, which is
exactly the current behavior. The client half is shipped and inert; the rule an
adopter writes now starts working the day the stamp lands, with no API change.

**Stamp-and-ignore is the first version.** No routing change — the channel keeps
broadcasting, each client compares the stamp, and non-matching clients **do not
run the handler**. That removes the damage (duplicate execution) and the respond
race, and narrowing delivery later is invisible to clients that already filter.

### Two silences, which must not be confused

- `accepts → false` — "I have this tool, it is not for me." Silent, correct.
  `notFound` must **not** fire.
- no declaration — "I do not know this tool." That is `notFound`.

Four tabs where one accepts should produce three silent declines and one result,
not three `notFound` warnings about a system working correctly.

### The hazard

**All clients decline** — the addressed tab closed, or nothing has focus. Nothing
responds, nothing errors, the call hangs to timeout: the exact failure
`notFound`'s default was written to prevent, arriving through another door. No
single client can know it was the last to decline, so this needs a framework-side
answer — resolve as unhandled after a beat, with a reason the model can relay.

---

## Adopter migration (knowify)

```
- CLIENT_TOOL_DECLARATIONS   + provideClientToolDeclarations
- CLIENT_TOOL_HANDLERS       + provideClientToolHandlers
- ClientToolHandler          (local re-declaration)
- the "declare and handle the same names" warning
+ provideClientTools([...createClientTool(…)])
```

`conversation.service.ts` drops one of its two injections and the wiring that
joins them.

---

## What of this is WIRE

The spec is the contract someone writes a client against in another language.
Most of this design is not that — it is TypeScript ergonomics over a wire that
already exists. Keeping the line visible so a non-TS implementer knows what they
must honour.

**Wire — belongs in `@agentick/spec`:**

|                                                                        | status                          |
| ---------------------------------------------------------------------- | ------------------------------- |
| `session/set_client_tools` — declare the client-handled slice          | exists                          |
| the tool-call notification + `session/respond_to_tool_call`            | exists                          |
| `traceparent` on `RequestMeta` (`_meta`)                               | typed; propagation shipped      |
| gateway `ignore \| link \| parent` policy for an inbound `traceparent` | typed; shipped (default `link`) |
| the addressed-connection stamp on a tool-call notification             | **not built**                   |

`RequestMeta` is `{ progressToken? }` today; `traceparent` joins it there rather
than becoming a transport header, so it survives every transport equally and a
non-HTTP client has one place to look.

**Client contract — portable as guidance, implemented idiomatically:**

The facets a conforming client offers its adopters: `log` / `trace` / `metrics`
on the context, the two disciplines (`log` always live, `trace` passthrough when
off), and the ctx fields. A Go client would want all of this — and would build it
on `log/slog` and `go.opentelemetry.io/otel` rather than porting `createLog`. The
SHAPE travels; the implementation does not.

Where two implementations must actually agree is trace **correlation** — hence
`traceparent` being wire, not guidance.

**TypeScript only — implementation detail:**

`createLog`, `NOOP_SPAN` / `OFF_TRACE` / `NOOP_METRICS`, the declaration
projection through `toJsonSchema`. A client in another language builds a
`ClientToolDeclaration` however its ecosystem prefers; only the JSON shape on the
wire is binding.

So a second implementation owes the wire table above — two of whose rows are not
built — and is _advised by_ the client contract. Confusing the two is how a spec
grows requirements nobody can satisfy in another language.

## Deliberately out of scope

- **`origin` on `ToolInfo`**, and **`list()` returning the server+client+MCP
  union.** Reasoned to from API symmetry, not from a caller — nothing in
  k-assistant-v3 reads a tool list. Worth revisiting sooner than the others: once
  a grant is per app, one handler serves several grantees, and a handler may
  legitimately want to know which app is calling it. Still no consumer, so still
  cut — but the motivation is now a real question rather than symmetry.
- **`session.tools.set()`** for per-session capabilities. The consumer provides
  one fixed set; the session verb already exists underneath.
- **Per-connection tool slices.** They optimise the rare case (heterogeneous
  clients) and make the common one worse: N tabs of one app declaring the same
  name produce a union with duplicate names, disconnect churn that flaps the
  prompt and busts prefix caching, and no principled answer to which duplicate
  the model sees. Ownership — one connection holds the slice, others do not
  declare — is the better extension, and is its own proposal.

## Open questions

1. **Where does the client apply its set?** On session open, or first send?
   Opening is obvious but races `tools.set()` in the same tick.
2. **Must `set` be awaited before a send is safe?** If a send outruns the
   declaration, the model is offered a tool the client has not published.
3. **Per-session apply failure** — does `app.tools.set()` reject wholesale or
   report per session?
4. **All-decline resolution** — how long is "a beat", and is the timeout a seam
   or a constant?

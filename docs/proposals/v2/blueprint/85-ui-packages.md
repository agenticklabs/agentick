# ADR 85 — UI packages: framework bindings over the client

**Status:** DRAFT / WORKSHOPPING 2026-07-14 (Fable, with Ryan)
**Depends on:** ADR 33 (client + transports + `channelView`), ADR 64 (signals), the timeline harness (conversation store), ADR 83/84 (client hooks). **Assumes** the `reconciler → compiler` rename (#243) for the naming split below.

## TL;DR

Build agentick UIs in any framework by layering thin bindings over the existing
`ClientProtocol`. The library is two tiers:

1. **`@agentick/ui-core`** (framework-agnostic) — opens **one firehose
   subscription per session** (`session.events`) and **demuxes it client-side**
   into family `get/subscribe` stores (messages, elicitation, tasks, knobs, …),
   each seeded from a snapshot. A **per-session store registry** shares that one
   firehose across every hook/component (multiplexing). The families are pure
   reducers over the shared stream — not N subscriptions.
2. **`@agentick/ui-<framework>-next`** (React, Angular, …) — ~30-line bindings
   that wrap any store in the framework's reactive primitive (`useSyncExternalStore`,
   Angular signals). Hooks: `useClient` / `useSession(id)` / `useChannel(view)`.

The thesis: a UI composes a **family** of reactive sources — messages, progress,
logs, task status, knobs, **elicitation**, MCP, custom channels, connection — and
**every one is the same `get/subscribe` store** on the read side, with the
bidirectional ones (elicitation, knobs, …) adding an action verb. One consumption
primitive; a new family is a façade + a one-line hook. That's what keeps the
library tiny (and multiplexing free) even as the surface grows.

## 1. Motivation

The client (`@agentick/client`) is already transport-agnostic (ws / http /
in-process) and exposes typed streams (`handle.events()`), scoped subscriptions
(`onLog` / `onProgress`), and channel views (`channelView`). What's missing is
the last mile: turning those streams into **reactive UI state** in whatever
framework an adopter uses, without re-implementing transport/reconnect/capabilities
per framework. Analogous to the Vercel AI SDK's split of a framework-agnostic
`AbstractChat` core + thin `@ai-sdk/{react,vue,svelte}` bindings — except our
"core" is already the client, and channels are first-class instead of bolted-on
`data-*` parts.

## 2. Thesis — a UI composes a FAMILY of reactive sources, all one primitive

A real agentick UI is not "render messages." It responds to **many** server-side
projections at once — messages are one family. And several are **bidirectional**:
the server asks, the UI shows an affordance, the user answers.

agentick already committed to the `useSyncExternalStore` contract (`channelView`
→ `{ get(); subscribe(); close() }`). Every family below reduces to that same
`get/subscribe` store on the READ side; the bidirectional ones add **action
verbs** on top (respond / accept / set / call):

| Family                        | client seam (today)                                  | UI hook                   | kind                                        |
| ----------------------------- | ---------------------------------------------------- | ------------------------- | ------------------------------------------- |
| **messages**                  | timeline channel — §4 (to build)                     | `useSession(id).messages` | read                                        |
| **elicitation**               | `session.elicitations()` + `respondToElicitation` ✅ | `useElicitation(session)` | **bidirectional** (accept / decline)        |
| **progress**                  | `onProgress(scope)` ✅                               | `useProgress(scope)`      | read                                        |
| **logs**                      | `onLog(scope)` ✅                                    | `useLogs(scope)`          | read                                        |
| **task status**               | `session:channel:task-status` (façade to build)      | `useTasks(session)`       | read (+ cancel)                             |
| **knobs**                     | `knobsStateView` ✅                                  | `useKnobs(session)`       | **bidirectional** (set)                     |
| **MCP apps / resources**      | `mcp/src/client` ✅                                  | `useMcp…`                 | read (+ tool actions)                       |
| **connection / capabilities** | `onStateChange` / `onCapabilitiesChange` ✅          | `useClient().status`      | read                                        |
| **custom**                    | `channelView` + a colocated façade                   | `useChannel(view)`        | read (or bidir via the channel's `request`) |

The framework binding is a **single** adapter — "wrap a `get/subscribe` store" —
reused across every family; the bidirectional hooks just also return the action
verb. `useSession(id).messages`, `useChannel(todosView)`, and the read side of
`useElicitation` are the same `useStore(...)` underneath. **This is why the
library stays tiny even as the surface grows** — a new family is a façade + a
one-line hook, never a new binding.

Bidirectional is not special-cased: it's the `ChannelHandle` `request`/`onRequest`
substrate surfaced to the UI as _(pending request store, respond action)_.
Elicitation is the canonical instance; a custom channel can do the same ask/respond.

## 2a. One firehose per session, demuxed client-side (NOT N merged streams)

The families are **not** N separate wire subscriptions the UI merges. Everything
above is already a `ProtocolEvent` on the **one substrate bus**, and
`client.session(id).events(query)` is a single cursor-based subscription over it.
The gateway's subscription projection (`openScopeEvents` → `app.events(query)`
stamped with `sessionId`) applies the query with **no per-event-type gating and
no server-only visibility flag** — auth is on the _scope_ (may you watch this
session?), not per event. So a broad `EventQuery` (surface/name-wildcard) is the
**whole session firehose**.

So `ui-core` opens **ONE** subscription per `(client, session)` and **demuxes
client-side**:

```
session.events(query)  ──►  router (by surface + name)  ──►  message fold
   (one cursor,                                          ├─►  elicitation queue
    one reconnect-resume)                                ├─►  task-status view
                                                         ├─►  knobs view
                                                         └─►  channel views (custom)
```

The "family façades" become **pure reducers over the shared stream** — a demux
table `(event → which family)` + each family's fold — NOT subscriptions. One
cursor, one reconnect-resume, unified ordering across every family for free. This
is strictly simpler than per-family subscriptions and is the model this ADR adopts.

**Granularity — DECIDED: token streaming is sender-only.** The COARSE events are
all on the bus: `timeline:append` (messages), channel publishes (knobs / tasks /
elicitation / custom), `*:signal:*` (log / progress), plus lifecycle including
**abort** (execution terminal / `stopReason: "aborted"`). Fine token-level
streaming (`content-delta`) is fed to the _sender's_ `handle.events()` queue and
is **intentionally not** put on the session bus. So:

- **The sender** renders token-by-token from its own `handle.events()`.
- **Observers** (other clients on the same session) render from the firehose —
  message _appends_ as they land, plus lifecycle (started / aborted / completed).
  No token-by-token for observers; that's the deliberate trade (no
  `session:stream:*` fan-out, less wire traffic).

This means the firehose is **complete for every family** for the observer's needs;
the sender's live typing effect is a local concern on its handle. Abort is a
firehose lifecycle event — the fold marks the in-flight message `aborted` for
everyone (a first-class `onAbort` hook is a convenience over the same event).

## 3. The `UIMessage` model + the fold (StreamEvent-native)

`ui-core` defines the normalized UI message model — a **UI concern, not spec**
(spec stays wire/protocol). It is derived straight from agentick's `StreamEvent`
union (not an AI-SDK clone):

```ts
interface UIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UIPart[]; // ordered, incrementally built
  status: "streaming" | "complete";
}
type UIPart =
  | { type: "text"; text: string } // ← content / content-delta
  | { type: "reasoning"; text: string } // ← reasoning-*
  | { type: "tool-call"; callId; name; input; output? } // ← tool-call-*
  | { type: "custom"; tag: string; data: unknown }; // ← custom-block-*
```

The **fold** is the one piece of real logic — a pure reducer
`(messages, event) => messages`:
`content-delta` appends to the open text part, `reasoning-delta` to a reasoning
part, `tool-call-*` opens/fills a tool part, `usage`/terminal marks the message
`complete`. Pure and unit-testable; the store just runs it over the stream.

## 4. Message source — snapshot bootstrap + firehose demux (no new channel needed)

Under the firehose model (§2a) the messages family needs no new server projection.
Live message events (`timeline:append`) already ride the firehose; the only thing
the firehose can't give you is **history from before you subscribed**. So messages
= **snapshot bootstrap + delta fold**:

- **Seed** from the timeline's own read on mount — `read()` in process,
  `timeline/history` over the wire. (There is no session-level snapshot value to
  seed from: `session.snapshot()` is a flush barrier that returns nothing.)
- **Fold** `timeline:append` (+ compact/replace) deltas demuxed from the firehose.

This is the K8s **list + watch** shape, but with **one** watch (the firehose) and a
per-stateful-family **list** (its snapshot). Every stateful family (messages, knobs,
tasks) follows it: snapshot-seed once, fold firehose deltas. A dedicated
`session:channel:timeline` channel becomes **optional** — the firehose + the
existing snapshot cover live + history — which is a real simplification the
firehose model buys.

> **Deferred to prior art if needed:** the channel's open-with-snapshot bundling
> (`resolveChannelSnapshot`, §channels) is the tidy alternative if we'd rather the
> server atomically bundle snapshot+deltas per family than have the client fetch a
> snapshot alongside the firehose. Both work; the firehose+snapshot is fewer moving
> parts for the UI. Pick during implementation.

The remaining real dependency is granularity (§2a): fine token-streaming isn't on
the firehose. Until the executor emits streaming deltas on the session bus, the
message fold renders appends live and reserves token-by-token for the sender's
`handle.events()`.

---

**Historical note — the conversation is the timeline harness** — already an append-only event log
(a fold), with `read()` (the current state) and `timeline:append` bus events
(deltas). For a **multiplexed / collaborative** UI you must fold the _session's_
stream (all activity — another client or the agent itself can produce messages),
NOT your own `send()` handle. `handle.events()` covers one execution; the UI's
live view is the session-wide stream.

So `useSession(id).messages` folds a **timeline channel** —
`session:channel:timeline`, snapshot+delta, consumed via a `timelineView` client
façade that mirrors `knobsStateView`. This does **not exist yet** and is ADR 85's
**enabling dependency**:

- **Server projection (to build):** the timeline harness publishes its channel —
  a `snapshot` frame from its current projection on subscribe, then `delta` frames
  from `timeline:append`. This is the exact knobs-state pattern (ADR 73) applied
  to the timeline. It lives in `timeline/src/client/` (façade) + a harness-side
  publisher.
- **`useSession(id).messages` = `timelineView(client, id)` folded by §3's reducer.**
- **Interim fallback:** fold `client.session(id).events()` (the raw
  `SubscriptionStream`) with a timeline-name query — works today, lower-level;
  the channel is the clean end-state.

This makes the message list "just another channel," which is _why_ multiplexing
(§5) falls out for free. It also makes the client `useSession(id).messages` the
**over-the-wire twin** of the existing in-process `useTimeline` (`timeline/src/react`,
via `useBridges`): same conversation, one bridged into the render tree, one folded
from the wire channel.

## 4a. Fold location — client by default, server when needed (one reducer)

The `foldMessage` reducer (Appendix A) is agentick's `toUIMessageStream` — it turns
the raw event stream into `UIMessage[]`. **Where it runs is a deliberate decision,
and it differs from AI-SDK for a structural reason.**

AI-SDK runs it **server-side**: it's a stateless route handler, so the `POST` is
where the model call happens and its **wire _is_ the UI message stream**
(`createUIMessageStreamResponse`); the client just accumulates. agentick's topology
is inverted — the model call runs **inside the session/harness**, events flow onto
the **bus → firehose**, and our **wire is the raw substrate event stream**
(UI-agnostic, serving _every_ consumer: other agents, logging, tooling, N UIs). A
UIMessage-shaped wire would couple the substrate to one UI model — against
"substrate, not opinion."

**DECIDED: client-side by default.**

- The `UIMessage` model + `foldMessage` are a **UI concern** → they live in
  `ui-core`, folding the raw firehose on the consumer.
- The adopter writes **no route handler** — the gateway already serves the
  firehose; `ui-core` folds it. That's _less_ server code than AI-SDK's pattern,
  not more.

**Server-side is the escape hatch, via the SAME reducer.** Because `foldMessage`
is pure, it also runs server-side for consumers that can't fold:

- **Thin / non-TS / SSR clients** (a Python client, an edge SSR endpoint): run the
  fold server-side and project a **`session:channel:messages` UIMessage channel**
  (the fold as a channel producer). A dumb client then reads pre-normalized
  `UIMessage`s — AI-SDK's shape, opt-in, without making the default wire
  UI-opinionated.

So it is not client-_or_-server: **one shared reducer, client by default, server
when a consumer can't fold.** `ui-core` ships `foldMessage` + a
`toUIMessageStream(events)` wrapper usable on either side; the optional
`session:channel:messages` projection is the server-side deployment of it.

## 5. Multiplexing — the per-session store registry

"Multiple clients subscribed to different sessions at once" forbids a global
singleton. `ui-core` holds a **store registry keyed by `(client, sessionId)`**,
and that key owns exactly **one firehose subscription** (§2a) whose demux feeds
every family store for the session:

- `useSession(id)` (and `useElicitation`/`useTasks`/… for the same session)
  **share the one firehose** for that key — N components, N families, **one** wire
  subscription and **one** cursor.
- The registry is **ref-counted** — the firehose opens on the first subscriber to
  any family of that session, and tears down when the last unmounts.
- A **`ClientProvider`** (React context / Angular DI) supplies the client;
  multiple clients (multiple gateways) → multiple providers or an explicit client
  arg. `useClient()` reads it.

The transport already multiplexes the underlying wire subscriptions; the registry
multiplexes the _stores_ on top.

## 6. Hooks — a family per projection, hierarchy mirrors the handles

```ts
// structural (mirror the handle hierarchy):
useClient(): { client, status, capabilities }        // from ClientProvider
useApp(appId): { sessions, createSession, … }
useSession(id): { messages, status, send, stop, dispatch, … }   // the 90% hook

// the read families (each wraps a get/subscribe store):
useProgress(scope): ProgressState
useLogs(scope): LogEntry[]
useTasks(session): TaskStatus[]
useKnobs(session): { values, set }                   // read + set (bidirectional)
useChannel(view): T                                  // any channelView — custom channels

// the bidirectional family (the exemplar):
useElicitation(session): {
  pending: ElicitationRequest[];                     // the read store
  // each request carries its own accept/decline/cancel (typed by schema):
}
```

Each hook is `useStore(sourceForThatFamily)` under the hood. The **structural**
hooks are convenience aggregations (`useSession(id).messages` is `useChannel` over
the timeline view; its `send`/`stop` are `client.session(id).send()` /
`handle.abort()`).

**Bidirectional** hooks return `(store, action)`. `useElicitation(session)`
surfaces the pending elicitation requests as a store; each request is a
`ClientElicitationHandle` with typed `.accept(value)` / `.decline()` — so a UI
renders the server's question (form/confirm/choice) and the user's answer routes
back via `session/respond_to_elicitation`. `useKnobs` is the same shape (read the
values, `set(id, value)`). This is the `ChannelHandle` `request`/`onRequest` loop
surfaced to the UI; a custom channel can expose the same ask/respond.

## 7. Package topology + dependencies

```
@agentick/ui-core        // UIMessage model, fold reducer, store registry,
                              //   ClientProvider-agnostic core; re-exports channelView
@agentick/ui-react       // useClient/useSession/useChannel = useSyncExternalStore
@agentick/ui-angular     // the same over Angular signals + DI
```

- **`ui-core` types against `ClientProtocol` (spec), not `client-next`** — so it
  works against ANY conforming client (the reference impl, a Worker-thread proxy,
  a test mock). `client-next` is the reference, not a hard dep.
- Framework bindings take the framework as a **peer dependency**.
- Naming follows the `{layer}-{framework}` rule. It is unambiguous once #243 lands:
  **`ui-<framework>` = client consume**; **`compiler-<framework>` = server author**
  (today's `reconciler-react`). Until #243, note the split in the READMEs.

## 8. Custom channels are a UI feature slice

A custom channel is a vertical slice and the canonical way to stream app-specific
structured state to a UI (the `data-*` analog):

1. **Server:** `session.channel<Todo[]>("todos").publish(...)` from a tool/harness.
2. **Client façade (colocated with the owner, mirroring `knobsStateView`):**
   `todosView(client, sessionId) = channelView(client, { kind: "session", id }, "todos", reduce)`.
3. **UI:** `const todos = useChannel(todosView(client, id))`.

The **runnable end-to-end example** belongs in a **v2 example app** (`example/v2*`
— none demonstrate channels today; this fills the gap), as a feature slice with
the façade colocated. README snippets (session publish / client consume) are the
API reference.

## 8b. Prior art (AI-SDK) — three patterns we already have primitives for

- **Backpressure** ([ai-sdk backpressure](https://ai-sdk.dev/docs/advanced/backpressure)).
  A push firehose into a UI must not buffer unboundedly. agentick's
  `MultiplexedStream` already ships per-stream backpressure — `unbounded` /
  `drop-oldest` / `drop-newest` / `close-on-overflow` + `capacity`. `ui-core`'s
  firehose consumer picks a bounded policy (a UI can safely **`drop-oldest`**
  intermediate coarse frames — the next snapshot/append supersedes them; never
  drop lifecycle/terminal). The fold is pull-shaped (`for await` over the
  demux), so slow renders exert backpressure naturally. No new primitive — a
  policy choice on an existing one.
- **Multiple streamables** ([ai-sdk multiple streamables](https://ai-sdk.dev/docs/advanced/multiple-streamables)).
  This is **exactly the channel model.** Each family / `channelView` is an
  independent streamable `get/subscribe` store; a response streams several at once
  (messages + a `todos` channel + a `plan` channel). agentick has this natively —
  the UI composes N stores, all demuxed from the one firehose (§2a). No `createStreamableUI`
  equivalent needed; channels _are_ the streamables.
- **Generative UI — tools rendered as UI** ([ai-sdk rendering-ui](https://ai-sdk.dev/docs/advanced/rendering-ui-with-language-models)).
  A tool's output renders as a component, not text. Two agentick paths:
  1. **Tool-call parts** — the `UIMessage` `tool-call` part carries `{ name, input,
output }`; the binding takes a **render map** `Record<toolName, Component>` and
     renders the part with it (the static/one-shot case).
  2. **Tool-owned channel** — for _interactive/live_ generative UI, the tool opens a
     `session.channel<T>(name)` and the component is a `useChannel(view)` over it
     (a live widget the tool keeps updating, even bidirectional via the channel's
     `request`). This is the richer path and the one custom channels (§8) unlock.
     So generative UI isn't a separate subsystem — it's a render map for the static
     case and a channel for the live case.

## 9. Open decisions (workshop)

- **Launch scope** — `ui-core` + React first (Angular next), or React + Angular
  together? (leaning core+React first.)
- **`useSession` return shape** — how much beyond `{ messages, status, send, stop }`
  (regenerate? edit? input state?).
- **Bidirectional hook shape** — `(store, action)` vs each item carrying its own
  verbs (elicitation already does the latter — each `ClientElicitationHandle` has
  `.accept`/`.decline`). Standardize one shape across elicitation / knobs / tool
  confirm / custom-channel-request?
- **Client façades to build** — which families need a new typed client façade:
  **timeline** (§4) and **task-status** (`taskStatusView`) don't exist yet;
  **elicitation** and **knobs** do. Do those façades live in their harness packages
  (`timeline/src/client/`, `tasks/src/client/`) — the established pattern — and does
  ADR 85 depend on them or drive them?
- **MCP apps in the UI** — MCP resources/tools have a `mcp/src/client` surface, but
  "MCP apps" (interactive MCP UI) is the least-defined family. Scope it here or
  defer to an MCP-UI ADR?
- ~~Streaming on the bus~~ **DECIDED (§2a): token streaming is sender-only.** The
  sender renders token-by-token from its handle; observers render appends +
  lifecycle from the firehose. No `session:stream:*` fan-out.
- **Bootstrap: snapshot-fetch vs open-with-snapshot (§4)** — seed stateful family
  stores from a separate snapshot read alongside the firehose, or use the channel
  `resolveChannelSnapshot` bundling per family? (leaning firehose + snapshot fetch —
  fewer moving parts, and it drops the need for a dedicated timeline channel.)
- **`UIMessage` parts coverage** — files/images, sources, step boundaries — model
  now or grow as `StreamEvent` grows?
- **First-class `onAbort` (follow-up, both sides)** — today abort is observed via
  the firehose terminal event (UI covered) and `handle.status`; there's no
  dedicated `onAbort`. Propose: server = a hookable execution-abort op
  (`onExecutionAbort`, alongside the existing `tool:abort` hooks); client = an
  `onAbort` on the handle + a session-scoped observer. Small, orthogonal to the UI
  package — tracked here because the UI motivated it.
- **Render map for generative UI (§8b)** — does the render map
  (`toolName → Component`) live in `ui-core` (framework-agnostic registration) or
  per-binding? Leaning: registration in core, resolution in the binding.

## 10. Non-goals

- No server-side rendering framework — this is client consume; authoring is the
  compiler (`reconciler`) side.
- No bespoke transport — rides `ClientTransport`.
- Not tied to "chat" — `useSession` is agent-session-centric; a chat UI is one
  shape built on it.

## Appendix A — `ui-core` sketch (illustrative, not final)

The whole library is: **the model, one router, one fold, a store, a registry, and
`useStore`.** Everything below is framework-agnostic (`@agentick/ui-core`); a
binding is `useSyncExternalStore` over any `Store`.

```ts
// ── 1. The store contract — the ONE thing bindings wrap ───────────────────
interface Store<T> { get(): T; subscribe(cb: () => void): () => void; }
// channelView already IS this; every family store is too.

// ── 2. The UIMessage model (StreamEvent-native, a UI concern) ─────────────
type UIPart =
  | { type: "text"; text: string }                                   // content(-delta)
  | { type: "reasoning"; text: string }                              // reasoning(-delta)
  | { type: "tool-call"; callId: string; name: string; input: unknown; output?: unknown } // tool-call-*
  | { type: "custom"; tag: string; data: unknown };                  // custom-block-*
interface UIMessage {
  id: string; role: "user" | "assistant" | "system";
  parts: UIPart[]; status: "streaming" | "complete" | "aborted";
}

// ── 3. The message fold — one pure reducer (unit-testable) ────────────────
// Handles BOTH the sender's fine StreamEvents AND observers' coarse timeline
// appends + terminal. `ev` is the union of {StreamEvent | TimelineAppend | Terminal}.
function foldMessage(msgs: UIMessage[], ev: MessageInput): UIMessage[] { /* … */ }

// ── 4. The demux router — firehose ProtocolEvent → which family ───────────
// A table of matchers over (surface, name); each routes to a family store's push.
interface FamilyRoute { match(ev: ProtocolEvent): boolean; push(ev: ProtocolEvent): void; }
function demux(ev: ProtocolEvent, routes: FamilyRoute[]) {
  for (const r of routes) if (r.match(ev)) return r.push(ev);
}
// routes (built per session):
//   name "timeline:append"        → messages.applyAppend
//   name "session:channel:elicitation" → elicitation.push
//   name "session:channel:knobs-state" → knobs.applyDelta
//   name "session:channel:task-status" → tasks.applyDelta
//   name wildcard "*:signal:log"  → logs.push   /  "*:signal:progress" → progress.push
//   terminal (outcome: aborted|…) → messages.finalize + status
//   custom "session:channel:<x>"  → the matching channelView

// ── 5. The per-session store — ONE firehose, demuxed ──────────────────────
class SessionStore {
  readonly messages: Store<UIMessage[]>;
  readonly elicitations: Store<ElicitationRequest[]>;
  readonly status: Store<SessionStatus>;
  // …knobs, tasks, logs, progress, custom channels lazily.
  constructor(private client: ClientProtocol, private id: string) {
    // seed stateful families from a snapshot (list), then watch the firehose:
    void this.bootstrap();                     // session.snapshot() → messages/knobs/tasks
    void this.watch();                         // for await (session.events(BROAD)) → demux
  }
  private async watch() {
    const stream = this.client.session(this.id).events(BROAD_QUERY); // ONE subscription
    for await (const ev of stream) demux(ev, this.routes);           // backpressure: pull-shaped
  }
  send(input: SendInput) {                     // sender path: also fold my token stream
    const h = this.client.session(this.id).send(input);
    void (async () => { for await (const e of h.events()) this.messages.applyStream(e); })();
    return h;                                  // .result / .abort() still available
  }
  close() { /* cancel the firehose, close channelViews */ }
}
const BROAD_QUERY: EventQuery = { scope: { /* sessionId stamped by the gateway */ } };

// ── 6. The registry — multiplexing (one firehose per (client, session)) ───
const stores = new Map<string, { store: SessionStore; refs: number }>();
function acquireSession(client: ClientProtocol, id: string): SessionStore {
  const key = `${client.id}:${id}`;
  const e = stores.get(key) ?? { store: new SessionStore(client, id), refs: 0 };
  e.refs++; stores.set(key, e); return e.store;
}
function releaseSession(client: ClientProtocol, id: string) {
  const key = `${client.id}:${id}`, e = stores.get(key);
  if (e && --e.refs === 0) { e.store.close(); stores.delete(key); }
}

// ── 7. The React binding (@agentick/ui-react) — the whole thing ──────
function useSession(id: string) {
  const client = useClient();
  const store = useMemo(() => acquireSession(client, id), [client, id]);
  useEffect(() => () => releaseSession(client, id), [client, id]);
  const messages = useSyncExternalStore(store.messages.subscribe, store.messages.get);
  const status   = useSyncExternalStore(store.status.subscribe, store.status.get);
  return { messages, status, send: store.send.bind(store), stop: /* handle.abort */ };
}
function useChannel<T>(view: Store<T>): T {           // any channelView / family store
  return useSyncExternalStore(view.subscribe, view.get);
}
```

Angular is the same shape over signals + DI: `acquireSession` in a service,
`toSignal(fromStore(store.messages))`. **The only real logic is `foldMessage` and
the `routes` table** — everything else is plumbing over primitives that exist.

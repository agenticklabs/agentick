# ADR 85 — UI packages: framework bindings over the client

**Status:** DRAFT / WORKSHOPPING 2026-07-14 (Fable, with Ryan)
**Depends on:** ADR 33 (client + transports + `channelView`), ADR 64 (signals), the timeline harness (conversation store), ADR 83/84 (client hooks). **Assumes** the `reconciler → compiler` rename (#243) for the naming split below.

## TL;DR

Build agentick UIs in any framework by layering thin bindings over the existing
`ClientProtocol`. The library is two tiers:

1. **`@agentick/ui-core-next`** (framework-agnostic) — opens **one firehose
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

The client (`@agentick/client-next`) is already transport-agnostic (ws / http /
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

| Family | client seam (today) | UI hook | kind |
| --- | --- | --- | --- |
| **messages** | timeline channel — §4 (to build) | `useSession(id).messages` | read |
| **elicitation** | `session.elicitations()` + `respondToElicitation` ✅ | `useElicitation(session)` | **bidirectional** (accept / decline) |
| **progress** | `onProgress(scope)` ✅ | `useProgress(scope)` | read |
| **logs** | `onLog(scope)` ✅ | `useLogs(scope)` | read |
| **task status** | `session:channel:task-status` (façade to build) | `useTasks(session)` | read (+ cancel) |
| **knobs** | `knobsStateView` ✅ | `useKnobs(session)` | **bidirectional** (set) |
| **MCP apps / resources** | `mcp/src/client` ✅ | `useMcp…` | read (+ tool actions) |
| **connection / capabilities** | `onStateChange` / `onCapabilitiesChange` ✅ | `useClient().status` | read |
| **custom** | `channelView` + a colocated façade | `useChannel(view)` | read (or bidir via the channel's `request`) |

The framework binding is a **single** adapter — "wrap a `get/subscribe` store" —
reused across every family; the bidirectional hooks just also return the action
verb. `useSession(id).messages`, `useChannel(todosView)`, and the read side of
`useElicitation` are the same `useStore(...)` underneath. **This is why the
library stays tiny even as the surface grows** — a new family is a façade + a
one-line hook, never a new binding.

Bidirectional is not special-cased: it's the `ChannelHandle` `request`/`onRequest`
substrate surfaced to the UI as *(pending request store, respond action)*.
Elicitation is the canonical instance; a custom channel can do the same ask/respond.

## 2a. One firehose per session, demuxed client-side (NOT N merged streams)

The families are **not** N separate wire subscriptions the UI merges. Everything
above is already a `ProtocolEvent` on the **one substrate bus**, and
`client.session(id).events(query)` is a single cursor-based subscription over it.
The gateway's subscription projection (`openScopeEvents` → `app.events(query)`
stamped with `sessionId`) applies the query with **no per-event-type gating and
no server-only visibility flag** — auth is on the *scope* (may you watch this
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

**The one completeness gap — granularity (the enabling dependency).** The COARSE
events are all on the bus today: `timeline:append` (messages), channel publishes
(knobs / tasks / elicitation / custom), `*:signal:*` (log / progress). What is
NOT is the **fine token-level streaming** — `content-delta` etc. are fed to the
*sender's* `handle.events()` via a private in-memory queue, not the session bus.
So an observer on the firehose sees a message *append*, not token-by-token
streaming. To make the firehose complete for collaborative live rendering, the
executor must **emit streaming deltas on the session bus** (a `session:stream:*`
family, or the timeline channel carrying streaming deltas). Until then: firehose
= coarse/complete for every family + message *appends*; live token streaming stays
the sender-handle path. This is the concrete "do they all make it over the wire?"
answer, and the dependency this ADR names.

## 3. The `UIMessage` model + the fold (StreamEvent-native)

`ui-core` defines the normalized UI message model — a **UI concern, not spec**
(spec stays wire/protocol). It is derived straight from agentick's `StreamEvent`
union (not an AI-SDK clone):

```ts
interface UIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UIPart[];          // ordered, incrementally built
  status: "streaming" | "complete";
}
type UIPart =
  | { type: "text"; text: string }                        // ← content / content-delta
  | { type: "reasoning"; text: string }                   // ← reasoning-*
  | { type: "tool-call"; callId; name; input; output? }   // ← tool-call-*
  | { type: "custom"; tag: string; data: unknown };       // ← custom-block-*
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

- **Seed** from a timeline snapshot on mount — `session.snapshot()` /
  `exportSnapshot()` already exist (the timeline is SnapshotCapable).
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
(a fold), with `exportSnapshot()` (snapshot) and `timeline:append` bus events
(deltas). For a **multiplexed / collaborative** UI you must fold the *session's*
stream (all activity — another client or the agent itself can produce messages),
NOT your own `send()` handle. `handle.events()` covers one execution; the UI's
live view is the session-wide stream.

So `useSession(id).messages` folds a **timeline channel** —
`session:channel:timeline`, snapshot+delta, consumed via a `timelineView` client
façade that mirrors `knobsStateView`. This does **not exist yet** and is ADR 85's
**enabling dependency**:

- **Server projection (to build):** the timeline harness publishes its channel —
  a `snapshot` frame from `exportSnapshot()` on subscribe, then `delta` frames
  from `timeline:append`. This is the exact knobs-state pattern (ADR 73) applied
  to the timeline. It lives in `timeline/src/client/` (façade) + a harness-side
  publisher.
- **`useSession(id).messages` = `timelineView(client, id)` folded by §3's reducer.**
- **Interim fallback:** fold `client.session(id).events()` (the raw
  `SubscriptionStream`) with a timeline-name query — works today, lower-level;
  the channel is the clean end-state.

This makes the message list "just another channel," which is *why* multiplexing
(§5) falls out for free. It also makes the client `useSession(id).messages` the
**over-the-wire twin** of the existing in-process `useTimeline` (`timeline/src/react`,
via `useBridges`): same conversation, one bridged into the render tree, one folded
from the wire channel.

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
multiplexes the *stores* on top.

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
@agentick/ui-core-next        // UIMessage model, fold reducer, store registry,
                              //   ClientProvider-agnostic core; re-exports channelView
@agentick/ui-react-next       // useClient/useSession/useChannel = useSyncExternalStore
@agentick/ui-angular-next     // the same over Angular signals + DI
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
- **Streaming on the bus (the real dependency, §2a/§4)** — do we emit fine
  token-streaming deltas on the session bus (a `session:stream:*` family) so the
  firehose is complete for collaborative live rendering, or accept token-by-token
  as the sender-handle-only path and render appends live for observers? This is
  the one thing that isn't already over the wire.
- **Bootstrap: snapshot-fetch vs open-with-snapshot (§4)** — seed stateful family
  stores from a separate snapshot read alongside the firehose, or use the channel
  `resolveChannelSnapshot` bundling per family? (leaning firehose + snapshot fetch —
  fewer moving parts, and it drops the need for a dedicated timeline channel.)
- **`UIMessage` parts coverage** — files/images, sources, step boundaries — model
  now or grow as `StreamEvent` grows?

## 10. Non-goals

- No server-side rendering framework — this is client consume; authoring is the
  compiler (`reconciler`) side.
- No bespoke transport — rides `ClientTransport`.
- Not tied to "chat" — `useSession` is agent-session-centric; a chat UI is one
  shape built on it.

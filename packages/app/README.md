# @agentick/app

**The outermost runtime boundary.** One app owns the substrate (journal, bus, inbox), the shared spine (compiler, loop, model executor, tool executor), and the session registry. `createApp` is the one door into all of it.

The split that explains the whole options bag: everything at the app is **shared**, everything below it is **per-session**. `model` sits at the app because provider clients are session-agnostic; a conversation sits at the session because a conversation is. Configure the shared things once and every session inherits them.

## Install

```bash
npm install @agentick/app
```

Subpaths: `/react` (same surface, with the JSX compiler pre-wired).

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { openai } from "@agentick/model-openai";

const app = await createApp(<Agent />, { model: openai("gpt-4o") });

const session = await app.createSession();
const handle = await session.send({ messages: [{ role: "user", content: "Hello" }] });
console.log((await handle.result).response);

await app.closeApp();
```

`createApp` is async because the substrate's inbox registrations must be complete before the first command — awaiting it is the guarantee that `app.createSession()` on the next line cannot race.

The `/react` subpath defaults `compiler` to the JSX compiler. Bring your own and import from `@agentick/app` instead:

```ts
import { createApp } from "@agentick/app";
import type { CompilerFactory } from "@agentick/spec";

declare const myCompiler: CompilerFactory;

const app = await createApp(rootElement, { model, compiler: myCompiler });
```

`rootElement` is opaque to the app — the bound compiler owns its type.

## One execution, nothing persists — `run()`

```tsx
import { run } from "@agentick/app/react";

const result = await run(<Agent />, {
  model: openai("gpt-4o"),
  messages: [{ role: "user", content: "What's 47 * 23?" }],
}).result;
```

A temporary app and session are created, the element executes once — full loop, tree and model and tools — and everything tears down when the execution settles. It streams too:

```tsx
for await (const event of run(<Agent />, { model, messages })) {
  render(event);
}
```

`run` takes every `createApp` option plus `messages`, `history`, `props`, `maxTicks`, and `signal`. It is the middle rung of a three-step ladder, each step strictly adding to the last:

| Reach for                | When                                              | From                        |
| ------------------------ | ------------------------------------------------- | --------------------------- |
| `generate({ model, … })` | One model call, no tree, no tools                 | [@agentick/model](../model) |
| `run(<Agent/>, …)`       | One execution — tree, model, tools — nothing kept | this package                |
| `createApp` + sessions   | Conversations that persist and resume             | this package                |

## Configuring the app

### `model` vs `modelExecutor`

`model` is _what to call_ — a bare adapter. The app wraps it in the one model executor on its substrate, so executor events land on `app.events(...)` with no wiring. `modelExecutor` is _how to execute_ — an engine you built. **At most one:** passing both throws, and passing a bare adapter to `modelExecutor` throws (it belongs on `model`).

Passing **neither** is legal. A model-less app is fully valid — dispatch, snapshot/restore, and wire plumbing all work without one. The requirement is enforced at execution time: a `send` whose effective-model cascade (per-tick `<Model>` → per-send override → session default) resolves empty fails with `NoModelForExecutionError`.

### Namespace slots — configuring a per-session capability from the app

A namespace like the timeline is per-session, but its _configuration_ belongs at the app. So each namespace package contributes its own top-level slot:

```tsx
import { createApp } from "@agentick/app/react";
import { defineTimeline, hydrateTail } from "@agentick/timeline";
import { fsTimelineStore } from "@agentick/timeline-fs";

const app = await createApp(<Agent />, {
  model,
  timeline: defineTimeline({
    store: fsTimelineStore({ dir: "./.agentick/transcripts" }),
    hydrate: hydrateTail(200),
  }),
});
```

There is **no `timeline?:` line in this package.** The slot arrives by module augmentation from `@agentick/timeline` and a side-effect registration that tells the app "`timeline` is a namespace key, forward it" — the app names no namespace and imports no namespace package for this. Install an optional namespace and its slot appears on `createApp` the same way; don't, and it never exists at the type level.

Every slot takes the same two forms and no third: a `defineX(...)` **definition** (or the identical inline bag — `timeline: { store }` is the same type) or a **live instance** when you own the lifecycle.

```tsx
const app = await createApp(<Agent />, { model, timeline: { store } }); // inline bag
```

Omit the store and a store-backed slot still gets one: the namespace builds an **app-scoped** default, once per app, keyed by session underneath. That lifetime is the point — a default that lived on the harness would leave with the evicted session, and the rebuild would hydrate from nothing. Your own store is merged over the default, so injecting one wins.

### `sessionNode` — where a session's events land

**Topology is configured at the gateway**, which keys it by principal and hands every app it hosts the same tree — see [`@agentick/gateway`](../gateway/README.md#subscriptions). Reach for this option when there is no gateway to configure: an embedded host that builds an app directly and still wants its sessions carved.

By default every session in an app publishes on the app's own bus, and anyone reading that bus reads all of them. `sessionNode` names a **scope-node path** instead: sessions of one principal, tenant, or room get their own bus, which fans in to its parent and on to the app's.

```tsx
const app = await createApp(<Agent />, {
  model,
  sessionNode: (ctx) => [`tenant:${ctx.metadata.tenantId}`, `user:${ctx.principal}`],
});
```

The isolation is then structural rather than inspected: a reader attached to `tenant:acme` sees every session under it and nothing from `tenant:other`, because there is no edge to carry a frame across. Nodes are built on first use and closed when their last session leaves; returning `[]` means the root, which is the app's bus — the unauthenticated pole, unchanged. An explicit `createSession({ bus })` owns its own wiring and the resolver stands aside. A gateway-hosted app that names its own resolver keeps it, and leaves the gateway's tree.

### `extensions` — the fully-dynamic escape hatch

Slots are declarative and statically typed. `extensions: []` is the array you build at runtime — conditional composition, a slot-less third party, anything assembled in a loop:

```tsx
import { withMCP } from "@agentick/mcp";
import { withTimeline } from "@agentick/timeline";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = await createApp(<Agent />, {
  model,
  extensions: [
    withMCP({
      servers: [
        {
          serverId: "fs",
          transport: new StdioClientTransport({ command: "mcp-server-filesystem" }),
        },
      ],
    }),
    ...(process.env.TRANSCRIPTS ? [withTimeline({ store })] : []),
  ],
});
```

App extensions install once at construction; session extensions re-install per session. The `target` field routes each one — you never sort them yourself. Order is install order, and a slot-name collision is last-writer-wins, so an adopter extension listed after a framework default overrides it.

#### What an extension can do — the installer surface

`install(installer)` receives the host's registration surface. The parts every extension author reaches for:

```ts
export function withAuditedTools(): AppExtension {
  return {
    name: "audited-tools",
    target: "app",
    install(installer) {
      // Ship a tool to every session this app constructs.
      installer.registerToolHandler("audit.handlers/report", reportHandler);
      installer.registerExtensionTool(
        toRegistration(reportDeclaration, {
          scope: "extension",
          extensionName: "audited-tools",
          level: "app",
        }),
      );

      // Register command hooks — the imperative twin of `createApp({ hooks })`.
      // Same derived names, composes with adopter hooks, never overrides them.
      installer.hook({
        onBeforeToolDispatch: (input) => audit.record(input),
      });

      // Reach a live session later (handlers run mid-session; the host handle
      // resolves by id). Sessions don't exist yet at install time — late-bind.
      const session = installer.app.getSession?.(sessionId);
    },
  };
}
```

Session extensions get the same surface plus session identity (`sessionId`, `principal`, `metadata`) and the session-owned bridges (`elicitation`, `tasks`, `resources`); hooks they register detach automatically when their session closes. For host bridges the session constructs _after_ installs run (`timeline`, …), hold `installer.getNamespace` and read at use time, never at install — see the ordering note on `SessionInstaller`.

#### Surviving an eviction — two lanes, and they don't mix

**Your state** rides `CheckpointCapable` on your bridge: implement `persist(ctx)` (flush to your own store) and `hydrate(ctx)` (read your scope back), plus `branch(ctx)` if forking should copy it. Feature detection finds them, so there is nothing to register. The ctx deliberately carries no reason — a hook that could see why it was running would flush differently per trigger, and evict / restart / crash would stop being one path.

**Your policy** rides `installer.hook()` on the lifecycle seams. `onBeforeSessionClose` sees `reason: "evicted"`, which is where pinning (veto it), draining (hold it), and audit belong. That layer knows the trigger precisely because it is the layer allowed to care.

One rule decides whether any of it works: **your store must outlive the session.** A store constructed per harness leaves with the evicted session and `hydrate` finds nothing on the way back. Build it once at app scope and key it by session — the [namespace-slot](#namespace-slots--configuring-a-per-session-capability-from-the-app) `appScope` arm is exactly that shape.

### Genesis — what a session opens on

A store-bearing namespace carries a `hydrate` seam, and the app is what runs it. Three laws are worth knowing because they are the ones that bite:

- **Genesis completes before the first render.** The first compile already sees the resumed conversation — there is no window where the tree renders against an empty log.
- **A throwing hydrator fails `createSession`** with its typed error (`TimelineHydrateFailed` for the timeline). There is no half-hydrated session that only explodes at the first `send`.
- **Genesis runs on create and resume, and on a fork — never on a spawn.** A spawned child opens on nothing, so it has no durable scope to read. A fork branches the parent's scopes at the store layer first, so the child genesises over its own copy.

```tsx
const app = await createApp(<Agent />, { model, timeline: { store } });

const a = await app.createSession({ sessionId: "chat-1" }); // genesis runs
const b = await app.createSession({ sessionId: "chat-1" }); // same id, later process → genesis runs
const child = await a.spawn({ agent: <SubAgent /> }); // opens empty; no genesis
const twin = await a.fork(); // branched copy of a's scopes; genesis over the copy
```

Create-is-resume: there is no separate `resume` verb. Opening a session id whose durable log exists rehydrates it. Over the wire, `app/create_session` answers `{ sessionId, status }` — so a client that reopens a thread knows immediately whether it is `running` or `input_required` mid-turn, without waiting for a frame (the live feed after that moment is `session.status` — see [@agentick/client-core](../client-core#is-it-running-right-now)).

## Sessions

### `getSession` vs `listSessions`

The app keeps **two** structures for sessions, deliberately not merged:

| Structure         | Holds                                         | Read it for                                        |
| ----------------- | --------------------------------------------- | -------------------------------------------------- |
| **Live registry** | `sessionId → live session`, in-memory         | Routing and interaction — `app.getSession(id)`     |
| **Session store** | `sessionId → SessionRecord`, durable superset | "List / resume my sessions" — `app.listSessions()` |

The store is the queryable superset: every non-ephemeral session ever, including closed ones the live registry dropped.

```ts
const live = app.getSession("chat-1"); // undefined once closed or evicted
const mine = await app.listSessions({ status: "running", updatedAfter: Date.now() - 86_400_000 });
const record = await app.getSessionRecord("chat-1"); // resolves closed sessions too
```

It is an app singleton, defaulting to a node-local in-memory store. Swap a durable adapter and the list survives an app restart — which is the store's entire purpose. Ephemeral `runOnce` sessions get no store entry; they are throwaway and stay out of the durable list.

`title` / `description` / `metadata` are yours to populate — seed them at `createSession({ title })` or set them later with `app.setSessionMeta(id, { title })`. The framework stores them and is blind to their semantics.

### The same list over the wire — paged, and scoped to the caller

`app.listSessions()` in process is a bounded snapshot: every matching record, unpaged, because the caller is already holding the whole store. `app/list_sessions` is the same read with the two things a remote caller needs added.

```ts
let cursor: string | undefined;
do {
  const page = await client.gateway
    .app("ernesto")
    .listSessions({ status: "running" }, { cursor, limit: 50 });
  render(page.sessions);
  cursor = page.nextCursor;
} while (cursor !== undefined);
```

**Walk until `nextCursor` is absent**, not until a page comes back short — a page can be exactly `limit` long and still be the last one.

**The cursor belongs to the store, not the framework.** Agentick defines the _envelope_ — `{ cursor?, limit }` in, `{ sessions, nextCursor? }` out — and nothing about what the token means. A store that implements the optional `SessionStore.page` owns its own paging and mints its own cursor, and the framework hands the token straight back to you. Pass it back verbatim; never parse it.

That rule generalizes: **the cursor belongs to whoever owns the ordering.** Where the framework owns the ordering it owns the cursor too — `timeline/history` pages by a store-assigned `seq` for exactly that reason. Session list ordering is not the framework's to dictate, so the cursor is not either.

**Two paths, one envelope.** A store with `page` gets paging pushed down to the backend, where a keyset over an index is one query. A store without it — the capability is optional — gets the framework's fallback: snapshot the query, sort, and cut in process. Same rows, same opacity; the fallback just reads every match to serve fifty of them, which is the reason to implement `page` once a store holds real volume.

The framework's default (and what the bundled in-memory store uses) is a **keyset** cursor, because sessions are ordered newest-activity-first and last activity moves: a thread that receives a message while you are mid-walk jumps to the front and pushes everything behind it down one. An offset cursor would then re-serve rows you already have. A keyset holds a _position in the list_ rather than a count of rows before it. The trade is honest: a row that jumps ahead of your cursor is not seen again on that walk, because it sorted into a region you already passed. (`paginate()` in `@agentick/utils` is the offset mechanism for catalogs whose order does not move — tools, prompts, resources. A session list is not one of those.)

**Scoped to the authenticated caller, inside the query.** Ownership rides `SessionStoreQuery.principal` rather than filtering the answer, because once a store cuts the page a filter applied afterward shortens it and leaves a `nextCursor` pointing past rows that were dropped. A record owned by another principal is absent from the page; a record owned by _nobody_ is visible to everyone, which is the ADR 48 rule the `destroy_session` handlers apply to a single named record. Absent, not an error: a list answers with what you may see, and a 403 would confirm the id exists.

This is not redundant with the dispatch gate — the gate's same-principal rule resolves a target from `params.sessionId`, and a list names no session, so without this the verb would enumerate every principal's threads.

**Writing a store adapter?** `runSessionStoreConformance` ships the obligations `page` has to meet — rows in the canonical order (N stores get merged at the gateway, so they must agree), a walk that skips no settled row and repeats none while writes land mid-walk, scoping honored inside the page, and an undecodable cursor answering page one rather than raising. They are tests rather than framework code precisely because the cursor is yours: nothing but your store can enforce them.

**Topology rides the events you already have.** There is no `session.added` / `session.removed` notification, because there does not need to be one: `app:command:create-session` and `app:command:destroy-session` are ops, and `session:command:close` is one too — all three land on the app bus, so a client subscribed to the app scope already sees sessions appear and disappear. Enumeration plus the existing events is the whole collection contract.

```ts
for await (const e of client.gateway.app("ernesto").events({ surface: "app" })) {
  if (e.name === "app:command:create-session" && e.phase === "terminal") refetch();
}
```

### The cancellation ladder

Four verbs, strictly increasing in what they take away. Each rung does everything the rung above it does, and more:

| verb                                 | cancels                          | disposes                   | detached tasks | durable record               |
| ------------------------------------ | -------------------------------- | -------------------------- | -------------- | ---------------------------- |
| `session.abort()`                    | that session's current execution | nothing                    | keep running   | untouched                    |
| `session.abort(reason, { cascade })` | ⤷ plus every live descendant's   | nothing                    | keep running   | untouched                    |
| `session.close()`                    | that session's current execution | the session + its children | ABANDONED      | survives                     |
| `app.closeSession(id)`               | ⤷ the same, through the app door | ⤷ plus the registry entry  | ABANDONED      | survives                     |
| `app.destroySession(id)`             | the whole live subtree's         | the whole live subtree     | CANCELLED      | DELETED + store scopes freed |

The two abort rungs are the only reversible ones: the session stays open, addressable, and immediately sendable again. Cascade is **scope, not kind** — each aborted execution mints the same ordinary `loop:abort` operation it always did, so a guard watching aborts sees the ops it already knew, just more of them.

```ts
await session.abort("user pressed stop"); // this turn
await session.abort("user pressed stop", { cascade: true }); // this turn and every sub-agent's
```

Cascade reaches descendants through the app's session registry, which is what holds their harnesses — a session knows its children's ids and nothing else. A session built without an app-level parent cannot have spawned anything, so cascade there is the plain self-abort.

### Close vs destroy

Two removal verbs, deliberately far apart.

`session.close()` is the gentle one — hang up. The session ends, its durable record survives as history on a `closed` status, and its **detached** tasks keep running: they were spawned to outlive the conversation.

Reach it as `app.closeSession(id)` whenever the app is holding the session for you — which is every session it created. Closing the harness directly ends the session but leaves the app's live registry pointing at the corpse: `getSession` keeps handing it back, the LRU cap keeps counting it, and `createSession` with the same id returns the dead one. Same teardown, plus the bookkeeping. It also reaches a session that is only evicted, ending it in the durable record without bringing it back first, and it is idempotent for an id that is already gone.

`app.destroySession(id)` deletes the thread — the record AND the conversation. It is transitive and it is the strongest form:

```ts
const { live, record } = await app.destroySession("chat-1", { reason: "user deleted the thread" });
live.abortedExecutions; //  in-flight work stopped, across the whole spawn subtree
live.disposedDescendants; //  sub-agent sessions torn down with it
live.cancelledDetachedTasks; //  the tasks close would have left running
record.existed; //  there was a durable record to delete
```

The abort pass is the same registry walk `session.abort({ cascade: true })` runs — one implementation, two callers — because a bare `session.abort()` reaches only that session's own current execution: a spawned child feels its parent's construction signal without its running execution being cancelled by it.

**Every store scope goes too.** A session's durable identity is its record plus its per-harness store scopes — the timeline log, the knob partition, the state partition. Destroy deletes all of them: each store-backed harness gets a `dropScope` call that removes its OWN scope from its OWN store, across the whole destroyed subtree, before the records are deleted. This is what makes destroy mean what it says. Without it the record would go and the conversation would stay, and the next session created with that id would hydrate a thread you had deleted.

A harness deletes only what it owns, so a sibling session sharing the same app-scoped store is untouched. A harness with no durable state implements nothing and is skipped. If a drop fails, destroy fails — it will not report a deletion that did not happen.

**An evicted target is brought back first.** A checked-out session has no live harnesses, and only a live harness can name its own scopes — so destroy rebuilds it through the same recovery path a send would take, drops, disposes, and deletes. One recovery path, teardown included.

**Idempotent.** Destroying an id that is already gone is a success reporting `live.found: false` / `record.existed: false`. You get facts, not an exception, for the case you were probably racing anyway.

**Descendants go with the target** — their scopes and their records both — for every descendant in the live spawn subtree destroy tore down. A descendant the live registry cannot see (already evicted, parented to a session that is gone) is out of reach of the walk, and whether deleting a parent row cascades to it is your store's decision — a SQL `ON DELETE CASCADE` is exactly where that belongs. So is what deletion MEANS at all: `SessionStore.delete` may soft-flag or hard-remove. That is why the result reports whether a record `existed`, and makes no claim about what happened to it.

Over the wire it is `app/destroy_session`, and it is ownership-gated twice: once by the dispatch gate, once by the handler on the durable record's principal. Belt and braces rather than redundancy — the gate resolves the target from the live session and falls back to the durable record when there is none, so ownership is enforced on an evicted or historical session too, and the handler's check holds even for a caller that reached the verb some other way.

A client holding a session id with no app id beside it — from a cross-app listing — reaches the same verb through [`gateway.destroySession(id)`](../gateway#reaching-a-session-without-naming-its-app), which resolves the owning app itself and reports which one it was.

### Cancelling one turn's fan-out

A long-lived session runs many turns, and turn N's sub-agents are not turn N+1's business. So the third scope is an **execution**:

```ts
const { sessionIds, originAborted } = await app.abortExecutionTree(handle.executionId, {
  reason: "user undid that step",
});
```

Every spawn stamps the execution that asked for it — `SessionRecord.originExecutionId`, beside the `originCallId` of the tool call that fanned out. `abortExecutionTree` walks that edge: the target execution's direct children, then each of their whole live subtrees, because once a branch belongs to the cancelled turn everything under it does too. Deepest-first, abort-strength only — nothing is disposed and nothing is deleted. It answers with the sessions it stopped, so a supervisor can go on to inspect or destroy them.

**Cancelling a RUNNING turn needs none of this.** A spawn inherits its origin execution's teardown signal, so aborting (or timing out, or failing) an execution already tears down the sub-agents it started — no walk, no registry, no verb. `abortExecutionTree` is for the other case: the turn ENDED WELL, its sub-agents outlived it deliberately, and you now want them gone. There is no live signal left to fire, and the durable origin edge is the only thing that still knows what belonged to that turn.

**The same question, one session at a time.** `executionTreeContains(executionId, sessionId)` answers "is this session's work part of that turn?" — the membership `abortExecutionTree` fans out over, read from the other end:

```ts
if (app.executionTreeContains(turn.executionId, event.scope.sessionId)) render(event);
```

The fan-out walks DOWN over a registry snapshot, which suits a one-shot cancellation. A subscriber filtering a live stream has the opposite problem — one session id per event, arriving continuously — so this walks UP instead, following `parentSessionId` until it hits an ancestor stamped with that origin execution. O(depth), no snapshot, and the gateway's [`fanIn` progress fan](../gateway#progress-on-a-running-turn) is its first caller.

The origin session itself is deliberately **not** a member of its own turn's tree: a session that has moved on to a later turn must not be dragged in by an id naming an earlier one. And like the fan-out walk, it reads only the live registry — an evicted ancestor breaks the chain.

**The other membership question — the tree, not the turn.** `sessionTreeContains(rootSessionId, sessionId)` is the same climb, terminating on a session id instead of an origin execution:

```ts
if (app.sessionTreeContains(rootId, event.scope.sessionId)) render(event);
app.sessionTree(rootId); // ["root", "kid1", "kid2", "grand"] — root first, then breadth-first
```

The asymmetry between the two is the whole reason both exist. An execution id names a turn a session moves **past**, so the origin session is out of its own turn's tree; a session id names the session **itself**, so the root is in its own tree — a subscription that watched a session's tree but not the session would be one nobody wants. And membership here is lineage rather than turn: a descendant belongs whichever turn spawned it, and keeps belonging once that turn settles. That is what a **subscription** needs, because a subscription outlives any one execution — the gateway's [`session-tree` scope](../gateway#watching-a-sessions-living-subtree) is its caller, with `sessionTree` supplying the one-time member list its snapshot splice orders.

### Who answered — `appId` joined to the app's `title`

An app declares the same `id` / `title` / `description` triple a tool or a prompt does:

```tsx
const app = await createApp(<Ernesto />, {
  model,
  appId: "ernesto",
  title: "Ernesto",
  description: "Knowify's assistant",
});
```

A session records which app opened it, so **who answered is the app** — one app mounts one root element, and a client that reached the sessions through `app("ernesto")` already knows which app that is. It reads the name off the app:

```ts
const { title } = await client.gateway.getApp("ernesto"); // "Ernesto"
const { sessions } = await client.gateway.app("ernesto").listSessions();
sessions[0].title; // the THREAD's title — not the app's
```

**A live join, on purpose.** Copying a display name onto every session record would make renaming an app a data migration and freeze historical threads under the old label. Renaming should relabel them. That is the opposite of `boundary.target`, which stamps the model that ran a turn onto the timeline precisely so a later model swap cannot rewrite it — evidence about the past must not move, a display label should.

There is no per-session author field. A spawned child shares its parent's `appId`, so naming individual specialists is a spawn-level concern and waits for one; inventing the field now would mean maintaining it everywhere for a feature that does not exist.

**`title` is not `name`.** `name` is the telemetry identity dimension — a deployment-flavoured value like `"assistant-api-prod"`. They are deliberately not defaulted from one another: promoting an ops identifier to a user-visible label is easy to add and awkward to remove.

### Bounding the live registry

The live registry is otherwise an unbounded map — a leak in a deployment that opens sessions and never closes them. Two knobs cap it by **evicting** idle sessions:

```tsx
const app = await createApp(<Agent />, {
  model,
  sessions: {
    store: pgSessionStore,
    maxActive: 500, // soft LRU cap on live sessions
    idleTimeout: 30 * 60_000, // evict after 30 min idle
  },
});
```

`maxActive` is a **soft** cap: when a create pushes the live count over it, the least-recently-active evictable session is evicted. Soft because an in-flight session is never evicted, so a burst may exceed the cap transiently; the bound is restored at the next create or sweep. `idleTimeout` is milliseconds of inactivity after which a background sweep evicts a session — on an `unref`'d timer, so a quiet app still releases memory without traffic to trigger it.

Those two configure the automatic callers. `app.evictSession(id)` is the same operation invoked by hand, for a host that knows a session is done being active before the sweep would notice. It resolves without effect if the session is not live or has work in flight — the hard invariant is that active work is never interrupted, by any caller.

> [!IMPORTANT]
> **Eviction is a checkpoint, not deletion.** Every harness flushes to its own store, then the session is torn down — the app keeps no copy of it. What comes back is what the stores hold, so eviction is invisible to correctness _to the extent the stores are durable_. The zero-config defaults are one in-memory store per app: enough to survive eviction, not a process restart. Inject durable adapters (`sessions.store`, `timeline.store`, `knobs.store`, `state.store`) and the same path survives both.

An evicted session is recorded as **`hibernated`**, which is a state and not an ending: it keeps the session out of the store's prune sweep, tells a thread list "dormant" rather than "over", and rides the `session:channel:status` channel like every other transition. `closed` is reserved for a session that actually ended.

Bring one back with `app.resumeSession(id)`:

```ts
const session = await app.resumeSession("chat-1"); // undefined if it cannot come back
```

There is **one** way back, whether the session was evicted a second ago or the process restarted since: the durable record identifies it, the app recipe rebuilds it, and each harness rehydrates from its own store. So what survives is the record plus the stores — the id, principal and metadata ride the record; the root element, props and per-session construction arguments (extra tools, the scope ceiling) come from the app or not at all. `undefined` means it cannot come back: an id never opened here, or one whose session genuinely ended. Concurrent resumes of one id collapse onto a single remount.

Over the wire this is automatic: `session/send` and `session/dispatch` remount an evicted session rather than answering `SessionNotFoundError`. Observation verbs (`sub/subscribe`, `session/compile`, …) deliberately do not — a UI that reconnects and subscribes to fifty threads must not bring all fifty back.

A `getSession(id)` handle captured before an eviction points at the closed instance; re-fetch (or `resumeSession`) after the window. Activity is any operation scoped to the session, tracked off the shared bus — so a session constructed with its **own** bus factory (a multi-tenant isolation lever) is not activity-tracked, and should be paired with an explicit `app.closeSession(id)` rather than idle eviction.

Every eviction — LRU, idle sweep, or `evictSession` — runs `session:snapshot` then `session.close({ reason: "evicted" })`, the same operations an explicit checkpoint and teardown run, not a path around them. So an `onBeforeSessionClose` observer sees evictions (and a guard on it, checking `reason === "evicted"`, is how you pin a session in memory), and the audit trail tells an eviction from a hangup by the record's `reason`, not by which code path ran. A flush that fails aborts the eviction and leaves the session live: an unmount behind an un-flushed tail would lose data.

### A turn a crash interrupted

Eviction is an orderly exit. A process that dies mid-turn is not: it leaves a record still saying `running`, naming a turn that never finished. `onInterruptedExecution` is where you decide what happens to that turn.

```tsx
const app = await createApp(<Agent />, {
  model,
  sessions: { store: pgSessionStore },
  onInterruptedExecution: ({ executionId, attempt }) => (attempt > 3 ? "drop" : "resume"),
});
```

It receives `{ session, executionId, attempt }` — the reconciled record (already `idle`, carrying `interruptedExecutionId`), the id of the turn that died, and how many consecutive times that same turn has been found interrupted — and may be async. It fires **once per detection**, on the resume path only: `app.resumeSession(id)`, including the automatic remount a wire `session/send` performs. A `createSession` with an existing id rehydrates the session but runs no detection, and neither does a destroy-rebuild. `"resume"` re-drives the turn; `"drop"` leaves it on the record as history. Absent, the default is `drop`: the crash is recorded honestly, nothing re-runs.

Detection reads two signals, and only their conjunction is a crash. The record's `running` is the **candidate** — eviction refuses an in-flight session, so nothing but a crash leaves that behind. The timeline's turn boundary is **authoritative**: a boundary present means the turn actually finished and only the record's idle-write was lost, so nothing is marked, the callback never fires, and the turn is never run twice. Detection is `running` **only** — `paused`, `input_required` and `hibernated` are legitimate persisted waits, and a record in one of them does not reach the callback even while it names a live execution.

`attempt` is the crash-loop budget, per execution rather than per session. A resume keeps the crashed execution's own id, so a turn that dies the same way twice arrives at `attempt: 2`, while a different execution resets it to 1; completing the execution clears both it and `interruptedExecutionId`. That is what makes `attempt > 3 ? "drop" : "resume"` a real circuit breaker, and it is only as good as the store under it: an adapter that drops `interruptedExecutionId` or `resumeAttempts` on the round trip resets the budget on every boot.

> [!WARNING]
> A policy that **throws** rejects `resumeSession` — deliberately, because silently downgrading an adopter bug to `drop` would hide it. The session still opened and is live: the mark and the build ran before the callback, so a retry returns it. What the throw costs is this boot's automatic re-drive, not the session, and the interruption survives on the record for a manual one.

A `"resume"` re-drives the turn through [@agentick/session](../session#re-driving-an-interrupted-execution)'s `resumeExecution` and resolves at **acceptance** — `resumeSession` never blocks on a whole model call. The re-driven turn announces itself through the normal handle, bus and status machinery, and its failure lands where any turn's does.

**Sweeping at boot.** The record store is the queryable half, so recovering what a dead process left behind is a list plus a resume:

```ts
for (const record of await app.listSessions({ status: "running" })) {
  await app.resumeSession(record.id); // detection and your policy run inside
}
```

How many of those run at once, and which node in a multi-process deployment owns a given crashed session, are deliberately not the framework's call — that ownership decision is what the callback is for.

### App-wide `signal`

One `AbortSignal` fans into every session. It is `closeApp()` in **abort shape** — a cascading cancel, not a teardown (the substrate survives):

```tsx
const controller = new AbortController();
const app = await createApp(<Agent />, { model, signal: controller.signal });

controller.abort(); // shutdown, deadline, client disconnect
```

When it fires, every active session's in-flight execution aborts (the app signal merges into each per-send execution signal), and new work is refused: `createSession` / `runOnce` throw `AppClosedError`, and a `send()` on an already-created session resolves `aborted` with 0 ticks and no model call. A per-session `createSession({ signal })` overrides the app signal for that session.

### Spawn — depth, lineage, teardown

`session.spawn(...)` creates a child session bound to the same app.

```tsx
const app = await createApp(<Agent />, { model, sessions: { maxSpawnDepth: 10 } });
```

- **Depth ceiling.** A session already `maxSpawnDepth` deep cannot spawn further — `spawn()` throws `SpawnDepthExceededError` with `{ depth, maxDepth }`. It fails closed, so a self-recursive agent crashes with a clear error instead of blowing the stack. Depth is just `spawnPath.length`; the default is 10.
- **Lineage.** A child carries `spawnPath` — its ancestor ids, root-first. It lands on the child's `SessionRecord`, on the loop's event scope (so bus and journal envelopes attribute sub-agent work), and on the child's execution handle stream. With `parentSessionId`, the records reconstruct the whole spawn graph.
- **Teardown cascade.** The parent's signal is fanned into each child, so a parent abort tears down the child's in-flight work; a parent close or abort disposes its children transitively. No sub-session leaks.

## Lifecycle operations

Spawn and close are **operations**, not bare method calls — they run through the same pipeline as any command, which is what makes them guardable.

A spawn is two linked operations: `session:command:spawn` (this session's layer — the depth ceiling, lineage, principal descent) parents `app:command:create-child-session` (this app's layer — construction and registry admission). They share a **body** with host `createSession`, not an envelope. That distinction is the point:

```ts
// "This agent may not spawn sub-agents" — without also blocking host session creation.
app.guard((_input, ctx) =>
  ctx.op === "SessionSpawn" ? { kind: "veto", reason: "no-subagents" } : undefined,
);
```

A spawn emits no `app:create-session` record, so a guard on host session creation does not silently police spawns, and vice versa. A veto at either layer creates no child and no registry entry.

Close emits `session:command:close` carrying its `reason` (`"closed"`, `"evicted"`, …). It is bus-only by policy — the envelope reaches `app.events(...)` without filling the journal — and a veto leaves the session usable.

## Hooks, guards, and middleware

Three seams around operations, distinguished by how much they know about the op:

| Seam           | Sees                                | Scope                | Registered                                  |
| -------------- | ----------------------------------- | -------------------- | ------------------------------------------- |
| **Guard**      | One named verb's input → a verdict  | Admission, outermost | `createApp({ guards })` or `app.guard(fn)`  |
| **Hook**       | One named verb's typed input/output | Transform            | `createApp({ hooks })` or `app.hook({ … })` |
| **Middleware** | Every op, opaquely                  | Wrap                 | `app.use(mw)` / `app.fx.use(mw)`            |

```tsx
const app = await createApp(<Agent />, {
  model,
  hooks: {
    onAfterToolDispatch: (result) => redactSecrets(result),
  },
  guards: {
    timelineAppend: (input) =>
      input.entries.length > 500 ? { kind: "veto", reason: "batch too large" } : undefined,
  },
});
```

Hook keys are `onBefore`/`onAfter` + the command (`onBeforeToolDispatch`). Guard keys are the bare command (`timelineAppend`) — guards are not lifecycle observers, they are admission decisions, and the naming says so. Both are derived from the command registry, so a typo is a compile error and a new command mints its keys automatically.

Either field also takes a **list** of bags — `hooks: [audit, redaction]`, `guards: [policy, quota]` — so contributor modules each keep their own. Each element is its own layer in the fold, in list order, and two elements naming the same key both fire; pre-merging them with a spread would have dropped one silently. The same holds for `createSession({ hooks })` and for a `defineX({ hooks, guards })` definition. Compose conditionally the way `extensions` does: `...(flag ? [bag] : [])`.

Middleware wraps every op the app or anything it constructs runs — the deployment-global seam for audit, tracing, and metrics:

```ts
const off = app.use(async (input, next, ctx) => {
  const started = Date.now();
  try {
    return await next(input);
  } finally {
    audit.record({ session: ctx.sessionId, op: ctx.opId, ms: Date.now() - started });
  }
});
```

Use `app.fx.use` for middleware that must stay in-fiber (span nesting, structured cancel that reaches inner ops) — the async form severs the fiber at `await`, which is fine for observation and wrong for propagation.

### The cascade

**Guards float outermost, then the fold composes.** For any one operation the order is: app guards → definition guards → app `before` hooks → definition `before` hooks, with `after` hooks unwinding in reverse. Governance outranks local policy; a `defineX({ guards })` bag never runs ahead of the app's. A list-valued field expands ONE scope's contribution into ordered sub-layers at its place in that sequence — it does not change the cross-scope order — so an earlier element brackets a later one, and a veto from any element of a guard list vetoes.

Hooks **compose, they do not override** — app-level and session-level both fire, app-outer. And the cascade is a **construction fold**: each session snapshots the app's resolved interceptors at birth, so `app.use` / `app.guard` registered _before_ a session is created reaches it and registered _after_ does not. Register app-level policy before you open sessions.

## Telemetry

Strictly opt-in, one switch, three forms — all of them turn on framework enrichment (agent identity, model/tool/tick attributes, token usage and cost on generate terminals) and thread a provider down to `ctx.trace` / `ctx.metrics` in your tool handlers.

```tsx
import { createApp, createTelemetry } from "@agentick/app/react";
import { otlpSink } from "@agentick/telemetry-otlp";

const app = await createApp(<Agent />, {
  name: "triage-bot",
  model,
  telemetry: createTelemetry({ serviceName: "triage-bot" }, otlpSink()),
});
```

- **`telemetry: true`** — enrichment on. With no exporter wired it attempts env-driven OTLP autodiscovery: if `OTEL_EXPORTER_OTLP_ENDPOINT` is set it lazily loads `@agentick/telemetry-otlp` and exports; if that package isn't installed it logs one line and continues. Autodiscovery fires **only** when the endpoint env is explicitly set — a deliberate divergence from the OTel SDK's silent-localhost default, so there is no accidental export spam. With no endpoint, enrichment still annotates spans on the no-op tracer.
- **`createTelemetry(options, ...sinks)`** — the standard-OTel form, no Effect import. A sink is `{ spanProcessor?, metricReader?, attributes? }`; a plain object literal is a valid sink. Every sink merges (processors concat, readers concat, attributes merge under the options').
- **`{ layer }`** — hand in an `@effect/opentelemetry` tracer layer when you already have one. A layer and span processors given together compose additively; the layer is never overridden.

Nothing wraps your instruments. Sampling, filtering, and batching stay expressed as your own OTel `SpanProcessor` / `MetricReader` instances, handed to the SDK raw. Exporter dependencies live in `@agentick/telemetry-otlp`, so this package stays exporter-dep-free.

`telemetryNamespace` prefixes every framework attribute (`<ns>.op_id`, `<ns>.app.name`), defaulting to `"agentick"` — whitelabel the framework's keys without touching `gen_ai.*` semconv keys, which stay verbatim.

Every `ctx.metrics.*` emission carries the low-cardinality labels `{ tool, op }`, plus `{ app: <name> }` when the app is named. That `app` label matters under a gateway: two apps inheriting one gateway telemetry setting share the same reader instances, so the wiring materializes one meter provider per `createTelemetry` product and refcounts it across every inheriting app. High-cardinality identity (`sessionId`, `executionId`) rides spans and logs, never a metric label.

## Cluster

Pass a `cluster` factory to replace the app's substrate with cluster-aware bus and inbox routing. Local emits fan out to other nodes; remote events arrive locally.

```tsx
import { defineUnixCluster } from "@agentick/cluster-net";

const app = await createApp(<Agent />, {
  model,
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});

await app.closeApp(); // closes the cluster too
```

> [!WARNING]
> **One cluster per process.** Two `createApp({ cluster })` calls with the same factory produce two independent clusters — double connections, double delivery. For multi-app deployments wire the cluster at the [gateway](../gateway) and let apps inherit.

`createApp({ cluster, bus: instance })` is fine; `createApp({ cluster, bus: LocalEventBus.factory() })` throws. The cluster needs a concrete substrate to wrap and cannot resolve a factory without the parent shell that _is_ the substrate — resolve factories yourself if you need that combination.

## API

### `@agentick/app`

| Export                                           | Purpose                                                  |
| ------------------------------------------------ | -------------------------------------------------------- |
| `createApp(rootElement, options)`                | Construct an app; resolves once the substrate is ready   |
| `run(rootElement, options)`                      | One execution, nothing persists; awaitable and iterable  |
| `createTelemetry(options, ...sinks)`             | Build a telemetry setting from standard OTel instruments |
| `AppHarness`                                     | The implementation, for direct construction              |
| `builtinWireExtensions`                          | The bundled wire methods, for a hand-assembled gateway   |
| `AppHarnessOptions` / `CreateAppOptions` (types) | The full options surface                                 |

### `createApp` options

| Field                       | Type                                                   | Notes                                                                                     |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `model`                     | `LanguageModelAdapter`                                 | What to call. At most one of `model` / `modelExecutor`; both omitted is a model-less app  |
| `modelExecutor`             | `LanguageModelExecutor` \| factory                     | How to execute. A bare adapter belongs on `model`                                         |
| `compiler`                  | `CompilerProtocol` \| factory                          | Required; defaulted by the `/react` subpath                                               |
| `loop`                      | `LoopExecutorProtocol` \| factory                      | Defaults to the bundled loop executor                                                     |
| `tools`                     | `ToolDeclaration[]`                                    | App-scope registry; threads to every session                                              |
| `hooks`                     | `CommandHooks` \| `CommandHooks[]`                     | Declarative per-verb transforms; folded once at construction. A list is N ordered layers  |
| `guards`                    | `CommandGuards` \| `CommandGuards[]`                   | Declarative per-verb admission verdicts. A list is N ordered layers                       |
| `extensions`                | `Extension[]`                                          | The dynamic composition array; routed by `target`                                         |
| `sessions`                  | `{ store?, maxActive?, idleTimeout?, maxSpawnDepth? }` | Durable resume index, live-registry bounds, spawn ceiling                                 |
| `onInterruptedExecution`    | `(i) => "resume" \| "drop"` (async ok)                 | Policy for a turn a crash left mid-flight; absent = `drop`. See above                     |
| `signal`                    | `AbortSignal`                                          | App-wide cascading cancel                                                                 |
| `cluster`                   | `ClusterFactory`                                       | Substrate fusion across nodes                                                             |
| `bus` / `inbox` / `journal` | instance \| factory                                    | Substrate overrides                                                                       |
| `sessionNode`               | `(ctx) => readonly string[]`                           | Where a session's events land in the scope-node tree. Omitted: sessions share the app bus |
| `telemetry`                 | `boolean` \| `TelemetrySetting`                        | The one observability switch; off by default                                              |
| `telemetryNamespace`        | `string`                                               | Prefix on framework attribute keys; defaults to `"agentick"`                              |
| `name`                      | `string`                                               | Logical app name — the telemetry identity dimension and default `functionId`              |
| `metadata`                  | `Record<string, unknown>`                              | Adopter bag carried on the instance                                                       |
| `appId`                     | `string`                                               | Defaults to `app:${generateId()}`                                                         |
| `title`                     | `string`                                               | Display label — what a person reads. Distinct from `name`; see below                      |
| `description`               | `string`                                               | One line for a picker or catalog                                                          |
| `costResolver`              | `(input) => RateCard \| Cost \| undefined`             | Pricing seam; wins over a model's declared `rates`. See below                             |
| _namespace slots_           | e.g. `timeline`                                        | Contributed by namespace packages; not declared here                                      |

Also accepted: `models`, `session`, `toolExecutor`, `tasks`, `defaultMaxTicks`, `streaming`, `narrate`, `initialProps`, `initialKnobs`, `target`, `interceptorParent`, and the failed-tick recovery pair `tickFailurePolicy` / `maxConsecutiveFailedTicks` (ADR 99) — flat shortcuts that cascade like `defaultMaxTicks`, with `session.*` longhand winning; semantics in [@agentick/session](../session#retrying-a-failed-tick).

#### `costResolver` — the pricing seam

The framework ships no prices. Static rates are declared on the model (`ExecutionTarget.rates`), so a per-tick `<Model>` override carries its own card. `costResolver` covers what a table cannot: per-tenant contracts, volume tiers, marketplace markup, a rate that depends on the request.

```ts
const app = await createApp(<Agent />, {
  model: anthropic("claude-sonnet-5"),
  costResolver: ({ target, usage, sessionId }) => contractFor(sessionId, target.modelId),
});
```

It is consulted per tick at settlement and **wins over the model's declared `rates`** whenever it returns a value; returning `undefined` falls through to them. Both return arms are real: a `RateCard` says "here are the rates, you do the arithmetic"; a `Cost` says "I did the arithmetic" — the marketplace case, where the number billed is not a function of tokens at all. A callback rather than a config table because pricing policy is unbounded, and any enum shipped here would be a guess at which three policies matter.

Every session the app creates gets it, spawned and forked children included. When neither the resolver nor the target supplies rates, the tick is **unpriced** — recorded as such, never as zero. See [@agentick/session](../session) for how that folds upward.

### `AppHarness`

| Member                            | Returns                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `createSession(input?)`           | A session bound to this app; opening an existing id resumes |
| `runOnce(input)`                  | One execution in an ephemeral session                       |
| `getSession(id)`                  | The live session, or `undefined`                            |
| `resumeSession(id)`               | Rebuild an evicted / persisted session, or `undefined`      |
| `evictSession(id)`                | Flush and unmount a live session; no-op if busy or unknown  |
| `closeSession(id)`                | End a session through the app door — registry entry too     |
| `listSessions(query?)`            | Durable records — the queryable superset (bounded snapshot) |
| `pageSessions(query?, page?)`     | One page of the same registry; the store's cursor, or ours  |
| `getSessionRecord(id)`            | One durable record, closed sessions included                |
| `setSessionMeta(id, meta)`        | Set app-owned `title` / `description` / `metadata`          |
| `destroySession(id, opts?)`       | Delete a session — transitive, strongest form               |
| `abortExecutionTree(id, opts?)`   | Cancel one execution's fan-out — abort strength, no removal |
| `executionTreeContains(eid, sid)` | Is that session's work part of that turn? (O(depth), live)  |
| `sessionTreeContains(rid, sid)`   | Is that session in this one's live tree? (root included)    |
| `sessionTree(rid)`                | The live tree's ids, root first then breadth-first          |
| `events(query?)`                  | Cross-session bus subscription                              |
| `use(mw)` / `fx.use(mw)`          | Register middleware; returns an unsubscribe                 |
| `guard(fn)` / `hook(bag)`         | Register a guard / hooks imperatively                       |
| `hooks.onBeforeToolDispatch(fn)`  | Per-verb imperative registrar                               |
| `closeApp()`                      | Close every session, fire close handlers, tear down         |

`closeApp()` closes registered sessions, fires extension close handlers in reverse registration order, closes the cluster if there is one, then tears down the substrate. Idempotent. `close()` is the same operation under the name every harness shares.

## Patterns

**Tools at app scope.** `createApp({ tools })` reaches every session; `createSession({ tools })` overrides per session, and the narrower scope wins. Build them with [@agentick/tool](../tool).

```tsx
import { createTool } from "@agentick/tool";
import { z } from "zod";

const calculator = createTool({
  name: "calculator",
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  handler: async ({ a, b }) => [{ type: "text", text: `${a + b}` }],
});

const app = await createApp(<Agent />, { model, tools: [calculator] });
```

**Sessions.** [@agentick/session](../session) owns `send`, steering, spawn/fork, and the snapshot surface.

**Conversations.** [@agentick/timeline](../timeline) owns the log, its store port, and compaction.

**Serving over a wire.** [@agentick/gateway](../gateway) hosts apps, owns the cluster for multi-app deployments, and cascades extensions down to every app and session beneath it.

**Interceptor mechanics.** [@agentick/runtime](../runtime) owns the operation pipeline, the hook-name derivation, and the middleware tiers.

## Roadmap & known gaps

- **No double-wrap detection.** Pass the same substrate instance to two `createApp({ cluster })` calls and the local bus gets two subscriptions per cluster event — double delivery, with nothing to warn you.
- **No mid-flight cluster swap.** Replacing a cluster means closing the app and constructing a new one.
- **No per-session namespace override.** Namespace configuration is app-wide; `createSession` takes no `timeline` override.
- **The interruption mark has a best-effort window.** A crash between construction's record write-back and the mark landing loses the evidence, and the turn is never detected as interrupted. The loss is silent-drop-shaped rather than run-twice-shaped, which is the tradeoff taken deliberately.
- **`resumeAttempts` is not in the store conformance suite.** The two resume slots are documented obligations on an adapter; nothing yet fails an adapter that drops them on the round trip.
- **`onSessionClose` does not fire on eviction.** Leaving memory is not a lifecycle end, so the app-level handler stays quiet; the session's own bridge and extension close handlers do run. Observe evictions on `onBeforeSessionClose` instead, where the reason is `"evicted"`.
- **A session's emission target is scoped per EXECUTION, not per harness.** A configured topology puts the session and its per-session harnesses (elicitation, tasks, resources, tool executor) on the node bus, but the app-shared spine — model executor, loop, compiler — is one instance per app on the app's bus. What puts ITS frames on the node is the session scoping `withEmissionBus(session.bus)` around the loop run, which the ADR 77 one-fiber spine carries to every nested emission. The consequence is worth knowing: anything the execution's fiber emits lands on the session's bus, app-level ops included. Nothing is lost (fan-in still carries it to the app bus), but a node subscriber sees slightly more than that session's own surfaces. An emission made OUTSIDE the execution fiber — a detached `Effect.runFork`, which is how the log/progress signal family emits — falls back to the emitting harness's own bus.
- **`onBeforeAppResumeSession` counts attempts, not resumes.** The wire's resolution walks every app asking "can you resume this id?", so the before-hook fires once per app asked — including apps that answer nothing, and ids that resume nowhere. The truthy signal is the around form: `onAppResumeSession` observing a session out of `next()` is a resume that actually happened. Telemetry and dashboards key on the around form; the before form is only right when attempts are the thing being measured.

## Verified by

- `src/__tests__/session-scope-nodes.spec.tsx` — sessions on the app's own bus with no `sessionNode` configured and with one that resolves `[]`, two principals landing on disjoint node buses while the app bus sees both, two sessions of one principal sharing a node, an explicit per-session `bus` outranking the resolver, a node closing with its last session so the next one gets a fresh bus, and model deltas from the APP-SHARED executor reaching the sending session's node and the root but never a sibling principal's.
- `src/__tests__/app-harness.spec.tsx` — construction, session lifecycle, close cascade, and the durable store: `listSessions` / `getSessionRecord` read it, records mirror lifecycle and execution accounting (status, `executionCount`, `currentExecutionId`, aggregated usage, close → `closed`), `setSessionMeta` sets the app-owned slots, and ephemeral `runOnce` sessions stay out of the list.
- `src/__tests__/genesis-lifecycle.spec.tsx` — the app-level namespace slot reaching the session's timeline (definition form and inline bag), the genesis and shaping seams riding it, the zero-config default with no slot, genesis completing before first render, `createSession` failing with the typed error on a throwing hydrator, and the genesis law as amended — a spawn runs none, a fork branches the parent's scope and genesises over the copy, a resume re-runs it.
- `src/__tests__/lifecycle-operations.spec.tsx` — the spawn and close envelopes end to end: spawn emits both operations with the child-create carrying `{ sessionId, parentSessionId, spawnPath }` and naming the spawn as its parent op, a spawn adds no host-create record, a fork adds snapshot + restore records, a guard veto at either layer creates no child, a spawn-only guard leaves host `createSession` alone, and close stays out of the journal while a veto leaves the session usable.
- `src/__tests__/hooks-cascade.spec.tsx` — `createApp({ hooks })` firing on dispatch, `createSession({ hooks })` composing app-outer, `onAfter*` transforms flowing through, list-valued `hooks` / `guards` composing as ordered layers, and no-hooks being behavior-preserving.
- `src/__tests__/session-eviction.spec.tsx` — `maxActive` evicting the least-recently-active session (LRU order proven via a send that refreshes an older one), `idleTimeout` evicting a quiet session on the sweep, an evicted session reopening with its timeline rehydrated, an in-flight execution never being evicted, an evict→resume reading exactly what a fresh app over the same stores reads, no field of the app retaining the evicted session, and `evictSession` as the manual caller of all of it.
- `src/__tests__/session-residency.spec.tsx` — the states between live and gone: an eviction stamping `hibernated` where a genuine close stamps `closed`, the store's prune sweep passing over a hibernated record and taking the closed one, `resumeSession` rebuilding an evicted session idle and able to run another turn with its identity (principal, metadata) read back off the record while the construction-bound scope ceiling does not survive, a resume from a record written by a previous process adopting rather than blanking it, two concurrent resumes collapsing onto ONE construction, `undefined` for an id never opened / already ended / destroyed, and `closeSession` dropping the registry entry — including after a `session.close()` behind the app's back — so reopening the id yields a live session rather than the corpse.
- `src/__tests__/interrupted-callback.spec.tsx` — the crash-detection seam: the callback firing exactly once with the marked record when a `running` record is resumed, staying quiet for a clean record, for the non-`running` waits that carry a live execution id, and for `running` with no id at all; a present turn boundary meaning the turn finished, so no mark and no callback; a throwing policy rejecting the resume rather than being swallowed; a `drop` leaving `interruptedExecutionId` on the record as history; and the mark surviving a store whose unmarked writes complete late, so construction's write-back cannot clobber it.
- `src/__tests__/reconcile-interrupted.spec.ts` — the mark itself: recorded additively over an idle, cleared record, `resumeAttempts` incrementing for a re-crash of the same execution and resetting to 1 for a different one.
- `src/__tests__/execution-resume.spec.tsx` — the re-drive end to end: a crashed turn completing under its **original** execution id with ticks continuing at 2 rather than restarting at 1, its input not re-appended, its `executionCount` not bumped, and completion clearing both resume slots off the durable record; a `drop` running nothing and leaving honest history; and a manual `resumeExecution` of the now-finished execution refusing.
- `src/__tests__/app-signal.spec.tsx` — an aborted app signal refusing new work at the edge, fanning into every session so a post-abort `send` resolves `aborted` with 0 ticks, and tearing down an in-flight execution.
- `src/__tests__/spawn-hardening.spec.tsx` — the depth ceiling failing a too-deep spawn (configured cap and the default chain), `spawnPath` landing on the record, the loop scope, and the handle stream, and a parent close or abort disposing its children with no registry leak.
- `src/__tests__/destroy-session.spec.tsx` — destroy aborting a grandchild held mid-tool and disposing the whole subtree, cancelling a detached task the same setup under `close()` leaves running, calling `SessionStore.delete` exactly once by id while a bystander's record survives, reaching a closed session's record, and staying silent (not faulting) on a second destroy.
- `src/__tests__/cascading-abort.spec.tsx` — the ladder, rung by rung: a plain `abort()` leaving a spawned child's in-flight work alone, `abort({ cascade: true })` stopping a grandchild deepest-first while disposing nothing and leaving the session immediately sendable again, a detached task surviving that cascade and being cancelled by `destroySession` on the same setup, a child spawned DURING an execution torn down by a plain abort of that execution, `originExecutionId` / `originCallId` stamped on the child's record while a SUCCEEDED turn leaves its child running, and `abortExecutionTree` taking one settled turn's branch transitively (a grandchild it never spawned included) while a sibling turn's child keeps working. Plus `executionTreeContains` over that same tree: child and grandchild in, a sibling turn's child out, the origin session itself out, and both unknowns quiet. And `sessionTreeContains` / `sessionTree` over it: both turns' children in (lineage, not turn), the root a member of its own tree where the origin session is not a member of its turn's, a parent never in its child's tree, and the enumeration root-first then breadth-first.
- `src/__tests__/session-address-reuse.spec.tsx` — create-or-resume never colliding with the id it reuses: every disposal path (destroy, `disposeChildSession`, `closeApp`, LRU eviction, a direct `session.close()`) releasing all three per-session inbox addresses even when a task executor's `cancel` rejects during teardown, a resume after eviction or destroy building a fresh harness set cleanly, and a create that fails partway releasing what its aborted construction claimed so the retry reports the real error instead of an address collision.
- `src/__tests__/tasks-elicit.spec.tsx` — a background task's `ctx.elicit` reaching the session's real elicitation harness through app-built wiring: the question arriving at the client verbatim, the answer resolving the work function, `canDoForm()` reporting the live capability rather than the stub's `false`, and a detached task still failing with the typed error before any ask leaves it. The app constructs the tasks harness itself, so the session-level escalation spec cannot see this path.
- `src/__tests__/session-principal-lifecycle.spec.tsx` — owning-principal inheritance across spawn and fork, fork metadata inheritance, and the `onSessionCreate` reshape and veto arms.
- `@agentick/transport`'s `src/__tests__/list-sessions-wire.spec.ts` — `app/list_sessions` over a real gateway: recency order and the projected descriptive slots, a three-page keyset walk staying disjoint while a touched row and a new row move underneath the open cursor (with the rows an offset cursor would have re-served named), rows sharing a millisecond each walked once, an undecodable cursor answering page one, another principal's sessions absent rather than erroring, and scoping running before the page is cut. Also both store paths: a store whose own cursor format survives the round trip untouched (and receives the paging call), a store implementing no cursored read paging correctly through the framework fallback, and a `metadata` filter — a dimension no store query expresses — forcing the snapshot path rather than returning short pages. (Home is transport because this package does not depend on it.)
- `@agentick/session`'s `src/__tests__/session-store.spec.ts` — the `SessionStore` conformance obligations, including the six that `page` must meet: canonical order (the gateway merge contract), a whole-store walk serving each row once, no repeat and no skip of a settled row while writes land between pages, principal scoping honored inside the page (with an unowned record matching every principal), an undecodable cursor answering page one, and the walk ending by clearing the cursor rather than shortening the page.
- `src/__tests__/create-app-cluster.spec.tsx` — cluster wiring, factory-substrate rejection, and close via registry removal.
- `src/__tests__/usage-cost.spec.tsx` — `costResolver` reaching the loop's run input verbatim, staying off it entirely when unset, and a spawned child inheriting it through the one session-construction body; plus a spawned child's cost landing on the child's own record while the parent's `cost` and `byModel` stay absent — not zero.
- `src/__tests__/session-extensions.spec.ts` + `layered-tools.spec.tsx` — extension target routing with per-session install, and app-scope tool propagation.
- `src/__tests__/telemetry-e2e.spec.tsx`, `telemetry-wiring.spec.ts`, `telemetry.spec.ts` — the `createTelemetry` → `ctx.trace` / `ctx.metrics` → sink path, sink merging and validation and env autodiscovery, and enrichment on/off.
- `src/__tests__/run.spec.tsx` — `run()` as awaitable and iterable, with teardown on settle.

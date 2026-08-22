# ADR 87 — Client sub-handles mirror server bridges (the `HookBridges` client twin)

**Status:** DRAFT 2026-07-14 (Fable, with Ryan)
**Depends on:** ADR 27 (modular built-ins / augmentation law), the `HookBridges` seed (`spec/protocol/hook-bridges.ts`), ADR 33 (client + `channelView`), ADR 85 (the UI families).
**Completes:** the client-handle surface — the missing keystone the ADR 85 façades (`taskStatusView`, `knobsStateView`) slot into.

## Problem

The **server** session harness carries a self-assembling bag of per-session
sub-surfaces — `bridges.{tasks, knobs, elicitation, timeline, resources}` —
contributed by harness packages via module augmentation of the empty-seed
`HookBridges` interface (ADR 27). A server dev reaches `session.tasks`,
`bridges.knobs`, etc., and the set grows with whatever harnesses are installed;
core hardcodes none of them.

The **client** session handle is inconsistent with this. It has the _generic_
per-session surface on the handle (`onLog`/`onProgress`/`channelView`, and
`elicitations()`), but the _typed harness projections_ are **loose free
functions** — `taskStatusView(client, sessionId)`, `knobsStateView(client,
sessionId)` — that never made it onto the handle. So `client.session(id)` isn't
the mirror of the server session it's supposed to be:

```ts
// server:                          // client (today):
session.tasks.list()                taskStatusView(client, id)        // free function
bridges.knobs.set(k, v)             knobsStateView(client, id)        // free function
session.elicitation                 client.session(id).elicitations() // on the handle (inconsistent verb)
```

Same capability, worse ergonomics, and a broken symmetry — the client's whole
reason for existing is that "adopters write the same code in-process or across the
wire."

## Thesis

**The client `SessionHandle` is the wire-side twin of the server session's bridge
bag, and it self-assembles from installed harness _client_ packages the same way
the server session self-assembles bridges from harnesses.** It's the client twin
of `HookBridges` — one empty seed, augmented per harness, contributed by the
`/client` subpath, never hardcoded in client-core.

|             | Server (in-process)                      | Client (over-wire)                                               |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------- |
| empty seed  | `HookBridges` (spec)                     | `SessionHandleExtensions` (spec/client)                          |
| contributor | harness package `augment.ts`             | harness package `/client` subpath                                |
| slot type   | `interface HookBridges { tasks: Tasks }` | `interface SessionHandleExtensions { tasks: TasksClientHandle }` |
| access      | `useBridges().tasks` / `bridges.tasks`   | `client.session(id).tasks`                                       |
| assembly    | session harness wires bridges            | `makeSessionHandle` spreads registered factories                 |
| what it is  | the live harness                         | the wire projection: **a read view + action verbs**              |

## 1. The seed + the augmentation

New empty-seed interface in spec (client subpath), mirroring `HookBridges`:

```ts
// @agentick/spec/client
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionHandleExtensions {}          // seed — core declares nothing

export interface SessionHandle
  extends ResourceHandle, HandleSubscriptions, SessionHandleExtensions {
  send(…); dispatch(…); events(…); elicitations(…); /* generic surface stays */
}
```

Each harness client package augments it (the exact `HookBridges` move):

```ts
// @agentick/tasks/client
declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    readonly tasks: TasksClientHandle;
  }
}
// @agentick/knobs/client → interface SessionHandleExtensions { readonly knobs: KnobsClientHandle }
```

## 2. The registration seam (runtime assembly)

Augmentation adds the TYPE; a small registry attaches the IMPL — the one new
mechanism, and the client twin of how the server wires bridges:

```ts
// @agentick/client
type SubHandleFactory = (client: ClientProtocol, sessionId: string) => unknown;
export function registerSessionHandleExtension(name: string, make: SubHandleFactory): void;

// makeSessionHandle spreads the registered factories onto the handle:
//   for (const [name, make] of registry) handle[name] = make(client, sessionId);
```

Harness client packages register on import (side-effect), delegating to the
existing façade:

```ts
// @agentick/tasks/client
registerSessionHandleExtension("tasks", (client, id) => makeTasksClientHandle(client, id));
// makeTasksClientHandle wraps taskStatusView(client, id) as .view() + the wire verbs.
```

**Install-to-appear** (ADR 27 modularity): `client.session(id).tasks` exists iff
`@agentick/tasks/client` is imported. The `agentick` metapackage bundles the
built-in client packages, so `.tasks`/`.knobs`/`.elicitation`/`.timeline` are
present by default; optional harnesses add their own. Client-core stays agnostic —
it hardcodes no slot, exactly like spec's `HookBridges` seed hardcodes none.

## 3. The sub-handle shape — a read view + action verbs (ADR 85 families)

Each sub-handle IS an ADR 85 family, structured as a handle: the **read view** (a
`channelView`) plus the family's **action verbs** (wire methods).

```ts
interface TasksClientHandle {
  view(): ChannelView<Record<string, TaskInfo>>; // == taskStatusView (the read store)
  list(): Promise<readonly TaskInfo[]>; // wire tasks/list
  get(taskId: string): Promise<TaskInfo | undefined>;
  cancel(taskId: string): Promise<void>; // wire tasks/cancel
}
interface KnobsClientHandle {
  view(): ChannelView<KnobsState>; // == knobsStateView
  set(id: string, value: unknown): Promise<void>; // wire set — bidirectional
}
// elicitation: the existing stream + respond, pulled under `session.elicitation`.
```

Read side = the `useSyncExternalStore` store a UI's `useTasks`/`useKnobs` wraps
(ADR 85); action side = the bidirectional verbs. This is where the ADR 85 family
model _lives_ on the client.

## 4. Migration (no rework — the bricks slot in)

- `taskStatusView(client, id)` → **stays** (tree-shakeable free function); `session.tasks.view()`
  delegates to it. Same for `knobsStateView` → `session.knobs.view()`.
- `session.elicitations()` → keep, but surface as `session.elicitation.stream()` (or
  `session.elicitation` iterable) for naming consistency with the other sub-handles.
- The tier-1 generic methods (`onLog`/`onProgress`/`channelView`) are unchanged —
  they're the _generic_ floor; the sub-handles are the _typed_ projections above it.

## 5. App / Gateway (same pattern, if needed)

`AppHandleExtensions` / `GatewayHandleExtensions` seeds exist for the same reason
if a harness projects an app- or gateway-scoped surface (most are session-scoped,
so `SessionHandleExtensions` is the primary). Symmetric with the server's
app/gateway bridge scoping.

## 6. Open decisions

- **Checkpoint parity** — the server iterates `HookBridges` generically for
  persist/hydrate via `CheckpointCapable`. Do client sub-handles need an analogous
  generic capability (e.g. a uniform `close()` so the handle tears down all
  sub-handles)? Leaning: yes, a `Closeable` marker the handle sweeps on `close()`.
- **Lazy vs eager** — build every registered sub-handle at `makeSessionHandle`, or
  lazily on first access (a getter)? Leaning lazy — a sub-handle opening a channel
  subscription shouldn't fire until touched.
- **Naming** — `SessionHandleExtensions` (matches `ToolHandlerCtxExtensions`) vs
  `ClientSessionBridges` (matches server `bridges`). Leaning the `*Extensions`
  form, consistent with the other client-side augmentation seeds.

## 7. Non-goals

- Not a new transport or wire concept — sub-handles are typed groupings over
  existing wire methods + channels.
- Client-core gains no harness dependency — the whole point is augmentation.

## 8. Rollout

1. `SessionHandleExtensions` seed + `SessionHandle extends` it (spec).
2. `registerSessionHandleExtension` + `makeSessionHandle` spread (client-core).
3. `tasks/client` + `knobs/client`: augment + register (`session.tasks`/`.knobs`),
   sub-handles wrapping the existing façades + wire verbs. Pull elicitation under
   `session.elicitation`.
4. Update the client README (the handle surface), ADR 85 (families = sub-handles),
   and each harness README.

## 9. Packaging — core vs bundle (landed)

The agnostic core and the batteries-included bundle are **two packages**, the
client twin of how the `agentick` metapackage bundles server built-ins:

- **`@agentick/client-core`** — the lean core. Owns `createClient`,
  `makeSessionHandle`, the `registerSessionHandleExtension` registry, the handle
  surface. Depends on **no** harness (the whole point — augmentation, not import).
- **`@agentick/client`** — the default. Re-exports the core AND
  side-effect-imports every built-in `/client` subpath (`tasks`, `knobs`,
  `elicitation`), so all slots self-assemble with zero per-harness imports. Carries
  no logic — three imports + `export *`.

Harness `/client` packages depend on **`client-core-next`** (never the bundle —
that would be a cycle). At the v2 cut these become `@agentick/client` (bundle) +
`@agentick/client-core` (core). Elicitation, once hardcoded in the core, is now a
registrant like tasks/knobs — the core knows about no harness at all.

A wire-method a client sub-handle calls (e.g. knobs' `knobs/set`) needs its
`WireMethods` augmentation loadable from the `/client` subpath alone — so that
augmentation lives in a dedicated type-only file (`wire-augment.ts`) the client
index side-effect-imports, NOT bundled with the server-bridge augmentation.

## 10. The symmetry law (three-audiences-plan §G, ratified 2026-07-24)

**A harness that projects a session handle SHIPS the matching client handle.**
The two are twins: the same noun, the same verb grammar minus what cannot cross
the wire (functions, live schemas, resolver-backed reads), rows typed by the
wire projection, `Enumerable` by default, delivered per this ADR (`/client`
subpath: `declare module` types the slot + registers the runtime factory;
`@agentick/client` bundles the built-ins — bundled, not privileged, the
same as ADR 27 server-side). A new harness the client can't see is half a
harness — so the omission is an architectural defect, not a follow-up.

Concretely, the **per-harness package checklist becomes six**: `harness` +
`augment` + `extension` + `conformance` + **`/client`** (+ `react`/`testing`
where they apply). The `/client` surface is the parity obligation; a harness
PR that adds a session handle without it is incomplete.

Read verbs are RPC-backed (`list()`/`get()` poll + fire-and-refetch after
mutations — the `gates`/`skills`/`prompts`/`resources`/`state`/`tools` pattern),
NOT channel-backed: a live reactive mirror (channel-projected views like knobs'
`knobsStateView`) remains gated on the client channel-consumer primitive.
Parity here means **verbs + enumeration**, not live state — a floor every
handle clears, with the reactive mirror an opt-in ceiling.

Deliberate holds are recorded, not silently skipped: `session.model` projects
in-process only (a model swap over the wire is an authz question decided
separately), so it ships no client handle by design.

# ADR 102 — Attachment is authorization (the bus tree is the scope model)

**Status:** DRAFT 2026-08-16 (Fable, with Ryan) — generalized same day from a tenancy-only draft at Ryan's direction
**Depends on:** ADR 31 (harness hierarchy, fan-in bus factories), ADR 48 (principal), ADR 101 (status channel — the first ambient-tier consumer).
**Supersedes when accepted:** the `onlyOwnedBy` arrival filter (#299 interim), the tenancy half of #297, the `session`-scope query-filter emulation.
**Related:** #304 (unstamped emitters — becomes defense-in-depth, not load-bearing), `docs/proposals/v2/arena.md` (rooms), `session/send` `fanIn` (an existing instance of this model).

## Problem

The gateway's event surface has one shape today: every subscription scope
reads a shared bus and narrows by _inspection_. `gateway` and `app` scopes
drain the shared bus wholesale — until #299 they leaked every tenant's frames
to any holder of `sub:subscribe`; since #299 they pass through `onlyOwnedBy`,
a per-envelope arrival filter keyed on a `principal` stamp that emitters keep
forgetting to apply (#304: three found and fixed at the emitter; a fourth —
elicitation request frames via `BaseHarness.request()`'s hand-built scope —
found in the same pass and still open). Even `session` scope is a `sessionId`
_query filter_ over the app bus, not a read of the session's own bus.

Filters have the structural failure mode we have now hit twice: they are
only as good as the stamping discipline of every emitter, forever, and a
missed stamp fails either open (leak) or closed (starvation — the #304
symptom). The doctrine set alongside ADR 101 names the end-state:
**isolation is a property of which bus you attach to, authorized once at
attachment — never a per-event identity check.**

The 2026-08-18 production outage added the performance half of the
argument. Because every subscription attaches at the root of the fan-in
tree, dispatch cost concentrates there: each append is tested against
every subscriber (`events × subscribers`), and under connector churn the
subscriber population saturated the event loop for minutes at a time
(captured live — `wakeSubscribers`/matcher frames at ~98% busy). Targeted
wake and the `sub/subscribe` teardown fix (next.129/130) removed the
constant factors; the topology this ADR describes removes the product
itself, factoring `E×S` into per-node sums where both terms are small.

## The claim, generalized

Tenancy was the motivating case, but it is one instance of a pattern the
codebase already contains twice more:

- **`session-tree` / `fanIn`** — "see this session and its descendants" is
  already topology: spawned children's buses wrap their spawner's, so
  reading the root session's bus IS the tree view. No filter computes the
  lineage; the wiring does.
- **Arena rooms** (`arena.md`) — a room is a set of principals entitled to
  each other's frames. That is not a new subsystem; it is a bus node that
  several principals are authorized to attach to, with room broadcast being
  publication at that node.
- **Operator/support views** (#297 remainder) — an operator is not a
  special code path; it is an ordinary subscriber whose attachment was
  authorized higher up the tree.

Three consumers, one primitive. So the framework concept is not "tenant
isolation" — it is the **scope node**: a named bus in a tree, where
_grouping, isolation, and broadcast are all the same fact_ (what fans into
a node, who may attach to it, what gets published at it). Tenancy is a
profile over the primitive, not the primitive.

## The mechanism already exists

`LocalEventBus` takes a `parent`: writes fan IN to the parent, reads are
isolated to the node's subtree (ADR 31). A subscriber on a child sees only
that subtree; a subscriber on an ancestor sees everything below. The missing
piece is _nodes at meaningful boundaries_ — and the insight that makes this
cheap: **the harness-ownership tree and the bus tree are separate trees
joined at the bus-factory seam.** A session's bus can parent to any node;
it does not mirror `gateway → app → session` ownership.

## Decision

### 1. Scope nodes — a registry of named buses

The runtime grows one small capability (substrate-level; the gateway is its
first host, not its owner): a **node registry** mapping a path of scope
keys to a lazily-created, refcount-closed bus:

```
registry.node(["tenant:acme", "user:ryan"])        → principal bus
registry.node(["tenant:acme", "room:standup-42"])  → room bus
registry.node([])                                  → the root (host's own bus)
```

Each node parents to the node one segment shorter, so fan-in composes:
everything in `room:standup-42` also reaches `tenant:acme`, and nothing
crosses to `tenant:other` — by construction. Session buses resolve their
parent through the registry (spawned children resolve to their spawner's
session bus, preserving the tree profile unchanged).

### 2. Node resolution is a seam, not a setting

The adopter supplies typed callbacks (capability, not opinion) —
one for where a session's events land, one for where a caller may attach:

```ts
withGateway({
  sessionNode: (auth) => [`tenant:${auth.tenantId}`, `user:${auth.principal}`],
  attachableNodes: (auth) => [
    [`tenant:${auth.tenantId}`, `user:${auth.principal}`], // own events
    [`tenant:${auth.tenantId}`, `room:${auth.roomId}`], // rooms joined
  ],
});
```

Defaults: `sessionNode = [principal]` when a principal exists, `[]`
otherwise; `attachableNodes = [sessionNode]`. With neither configured the
tree collapses to today's `gateway ← app ← session` — zero-config behavior
unchanged. A session (or any harness) can additionally publish AT a node it
is entitled to (`registry.publish(path, frame)`) — that is room broadcast,
and it is the same verb as everything else.

### 3. Subscribing is attaching

`sub/subscribe` resolves an **attachment**, once, at subscribe time:

- Default: the caller's own node — the deepest path they own. A frame from
  outside that subtree never transits the bus; there is nothing to filter.
- Any broader or lateral node (tenant, room, app, root) is an ordinary
  authorization question asked ONCE of the authorizer via the existing
  scope label (`AuthorizeInput.scope`) — the seam the operator-view TODO in
  `subscriptions-extension.ts` already points at. Operator view, room
  membership, and support access are the same decision at different paths.
- `session` / `session-tree` scopes become attachments to the session's own
  bus (tree reachability comes free from spawn-time parenting), replacing
  the query-filter emulation.

### 4. Control-plane facts ride a second attachment, not a mirror

Fan-in goes up, so a root-level fact (`gateway:capabilities:changed`) never
reaches a leaf subscriber. A subscription is therefore an **attachment
set**: `{your node: full query}` ∪ `{root: control-plane surfaces only}`.
Surface selection is topic subscription — choosing _what_ you hear, never
inspecting _whose_ frame arrived — so the no-per-event-filter doctrine
holds. Rejected alternative: mirroring control-plane frames into every leaf
(write amplification proportional to nodes, plus a second emitter
discipline to get wrong).

### 5. What this kills, what it demotes

- `onlyOwnedBy` is deleted. The fail-open/fail-closed dilemma disappears
  because arrival inspection disappears.
- The `session`-scope query filter goes with it; scope resolution becomes
  uniform: every scope kind names an attachment.
- The #304 principal stamps stay, demoted to defense-in-depth: they still
  matter for journal reads, cross-node relays (cluster), and debugging —
  but no delivery decision depends on them.

## Consequences

- One authorization decision per attachment, zero per-event cost, and the
  leak class is closed _by construction_ — an emitter cannot mis-stamp its
  way across a boundary its bus does not reach.
- The ambient tier (ADR 101 status frames, channel frames, model deltas)
  works for every subscriber without any emitter knowing the rules.
- Arena stops needing a membership-filtering subsystem: a room is a node,
  joining is being granted attachment, broadcast is publishing at the node,
  and hard tenancy is the room path being prefixed by the tenant segment.
- Late attachers replay from the ring of their attachment node only — the
  same cursor semantics as today, now scoped to the subtree, strictly more
  correct.
- Cluster shapes cleanly (out of scope here): a relay is a subscriber on a
  node republishing into the peer registry's node of the same path — the
  path, not the stamp, is the identity.

## Ship order

1. Node registry + resolution seams + session-bus parenting through the
   registry (inert without config — the tree collapses to today's).
2. Attachment resolution for `gateway`/`app` scopes + the control-plane
   root attachment; delete `onlyOwnedBy`; port the principal-isolation spec
   to assert topology (two principals, identical grants, disjoint buses).
3. `session`/`session-tree` as attachments; delete the query-filter path.
4. Grants for non-default paths via the authorizer scope label — closes
   #297 (operator) and opens rooms without further framework work.

## Open questions

- **Attachment-set surface list**: which surfaces are control-plane is a
  host-owned allowlist today; does an extension get to register surfaces
  (harness-owned, like channel names)?
- **Wire surface for lateral nodes**: `sub/subscribe` today names scopes by
  kind (`gateway`/`app`/`session`); attaching to `room:*` wants a
  path-shaped scope on the wire. One new scope kind (`node`, carrying the
  path) or widen the existing shape?
- **Principal-less callers** (dev mode, in-process tests): resolution
  returns `[]` → they attach at the root and see everything, matching
  today's no-auth behavior — confirm this is the wanted default rather
  than fail-closed.
- **Node GC vs durable cursors**: closing an idle node discards its ring;
  a subscriber reattaching later seeds from snapshots (status channel)
  rather than replay. Acceptable, or should nodes linger for a TTL?

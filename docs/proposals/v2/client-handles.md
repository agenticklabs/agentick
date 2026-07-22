# Client Handles — the unified contract (B2 design, DRAFT for Ryan's review)

**Status:** DRAFT 2026-07-22 · **Author:** the session architect · **Decides:** B2
**Builds on:** the CQRS decision log (reads = event-driven channels, writes = req-res
commands), ADR 87 (sub-handle registration — UNCHANGED by this design), the Store/View
taxonomy (`store.md` — the thin-shared-conformance lesson), enumeration-is-foundational,
the B1 friction log (`one-shot-friction-log.md`).

## 1. Problem

The client sub-handles were built across four separate passes with no cross-cutting
owner, and it shows (Ryan: "like they were made at 4 different times by 4 different
teams"). Concretely:

| Handle | Shape today | Defects |
|---|---|---|
| `session.elicitations` | ChannelStream + `.respond` | live-only (a client connecting mid-ask sees nothing); docs drift (fixed aaccee4c) |
| `session.clientToolCalls` | ChannelStream + `.respond` | live-only; `routeClientTools`/`confirmClientTools` are LOOSE session methods, not verbs on the handle |
| `session.knobs` | get/set/subscribe | values only — no descriptors on the wire (friction #1); client says `key`, server says `id` (friction #13) |
| `session.tasks` | collection view | closest to correct |
| timeline | `timelineView(client, sessionId, …)` — a FREE FACTORY | not a sub-handle at all; no wire history path (friction #2); Cursor≠seq resume gap (friction #3) |

The registration mechanism (ADR 87) is already uniform. The incoherence is one level
up: what each handle exposes.

## 2. The anatomy (the spine of this design)

```
Handle = WRITE half  — wire-command builders, DERIVED from wire method defs
                       (uniform by construction; zero per-handle design)
       + READ half   — a mandatory thin core + declared capability PROFILES
                       (conformance-enforced) + per-handle VIEW LOGIC
                       (designed per domain; the timeline window is the exemplar)
```

**Write side** (Ryan's builder observation): a write verb is address-binding + wire
param shaping + `client.request(method, params)`. These are mechanically derivable
from the `defineWireExtension` typed method definitions. Rule: **write verbs are
generated from wire defs, not hand-written beside them** — drift becomes impossible.
(Implementation: a `wireVerb(method)` helper the registration closures use; the
generation can start as a disciplined convention + conformance check and become
codegen later if warranted.)

**The wire substrate under every verb (Ryan's unification):** there are exactly THREE
wire primitives, and every handle member is a builder over one of them, differing only
in response currency: (1) **command** — req-res, `Promise<Result>` (`knobs/set`);
(2) **read RPC** — req-res, `Promise<Result>`, identical builder mechanics, side-effect-
free (`timeline_history`, `enumerate`); (3) **subscription** — `transport.subscribe(scope,
query)` → the stream the read views fold. Extension mechanism (ESTABLISHED, unchanged):
spec `WireMethods` module augmentation (the typed row IS the contract) + the package's
gateway session-extension handler (`defineWireExtension`) + the ADR-87 client verb
binding addressing. Any package extends the wire this way — "custom methods, the user
gets whatever they want," fully typed end-to-end. Handle verbs backed by (1)/(2) return
Promises; the read VIEWS (`list`/`onChange`/iterate) are folds over (3), snapshot-first
so `list()` is truthful.

**Interceptors vs projections (principle, Ryan-review 2026-07-22):** interceptors
transform the TRUTH (one canonical result — model, store, and client all see it);
projections transform a VIEW (one audience's copy at the egress boundary). Anything
audience-specific — client truncation (`truncateToolResults`), redaction-for-clients,
per-client shaping — is a projection, never an interceptor. Config booleans
(`telemetry: true`, `truncateToolResults: true`) are sugar over their seam's canned
instances; the callback form IS the seam. Egress stays a single callback until a
third consumer appears (three-consumers rule), then generalizes to a chain.

**Read side**: the observation core is uniform; the fold/view above it is
legitimately domain-specific and is *designed*, not templated. Knobs = keyed
replace-fold (trivial). Elicitations/tool-calls = pending-state collection that also
streams. Timeline = the window (seed/tail/prepend/append/reconcile). No base class
that pretends these are the same thing.

**PRINCIPLE #5 (Ryan 2026-07-22): contracts are FLOORS, not ceilings.** The framework
asks for the minimum it needs; the user's application — their UI, their backend, their
data model — can give more, and everything of theirs rides through untouched.
Conformance tests that required members BEHAVE, never that nothing else exists;
interfaces are structural (satisfying the shape IS conforming); metadata bags carry
user data untouched (the only strips are OUR reserved security fields, by name — the
executedBy precedent). We take what we need from what the user gives.

## 3. The contract

```ts
// MANDATORY CORE — every handle, no exceptions. Thin on purpose (store.md lesson).
interface ClientHandle {
  subscribe(cb: () => void): Unsubscribe;   // THE store contract (Ryan 2026-07-22):
                                             // fires on change, cb takes NO args,
                                             // read current via list(). Makes every
                                             // framework binding zero-adapter
                                             // (useSyncExternalStore(h.subscribe, h.list)).
  close?(): void;                            // where the handle owns a subscription
}
// NOTE: client-core's existing ChannelView carries BOTH subscribe (state feed) AND
// onChange (frame feed) — a 4-teams artifact; the arc consolidates onto `subscribe`
// (the frame feed survives only as an internal/advanced tap where truly needed).

// CAPABILITY PROFILES — declared (typed) + feature-detected (conformance):
interface Enumerable<T, Id = string> {       // current STATE, not just events
  list(): readonly T[];
  get(id: Id): T | undefined;
}
// Streamable REMOVED from the contract (Ryan review 2026-07-22): a handle is
// nouns+verbs, not also a stream you drink from — the dual identity was the
// 4-teams smell in one line, and `for await` over an UNBOUNDED feed is a
// coroutine with unowned lifecycle (one exception kills all future asks).
// PRINCIPLE: iterate BOUNDED things (run.events() — a run ends); observe
// UNBOUNDED things (onChange). Async iteration survives ONLY on finite
// streams; no session-lifetime handle is iterable.
interface Respondable<In> {                  // correlated reply-by-id
  respond(id: string, input: In): Promise<void>;
}
// Writable = the handle's domain mutation verbs (set, cancel, prepend, …) — FREE
// in name and shape, but every one is a derived wire verb (write-side rule).
```

Semantics locked across all handles: `onChange` always means "the handle's state/feed
changed"; `list()` always means "current state, including what happened before I
connected" (this is the live-only fix); iteration is always sugar over the same feed
`onChange` exposes — never a second channel.

## 4. Conformance — `runClientHandleConformance`

The client twin of spec-conformance, structured like `runStoreConformance`:
- **Core cases (mandatory):** onChange fires on change; Unsubscribe stops it; close
  tears down; handle is a PROPERTY on the session handle (the aaccee4c drift class,
  now compile/conformance-checked).
- **Profile cases (run iff declared):** Enumerable — `list()` reflects pre-connection
  state (the mid-ask test: connect after an ask is pending → `list()` contains it);
  get-by-id; list/onChange coherence. Streamable — iteration yields exactly the
  onChange feed. Respondable — respond routes; unknown id rejects; double-respond
  defined.
- **Write-verb case:** every verb hits its wire method with correctly bound
  addressing (spy transport) — the derived-from-wire check.

A fifth handle written next year passes this suite or does not ship. Coherence
becomes a property of CI, not of review-time vigilance.

## 5. The five handles, mapped

| Handle | Core | Profiles | Write verbs (derived) | Read view (designed) | Changes required |
|---|---|---|---|---|---|
| `session.knobs` | ✓ | Enumerable, Writable | `set` (`knobs/set`) | keyed replace-fold | `key`→`id` (#13); **descriptors on the wire** (#1: `KnobDescriptor[]` in the knobs-state snapshot → `list()` returns descriptors+values, not bare values) |
| `session.tasks` | ✓ | Enumerable, Streamable? | `cancel`, … | collection view | minor alignment only |
| `session.elicitations` | ✓ | Enumerable, Streamable, Respondable | `respond` | pending-request collection + stream | **server: pending enumeration** (§6); keep `e.accept/decline/cancel` per-item sugar |
| `session.clientToolCalls` | ✓ | Enumerable, Streamable, Respondable | `respond`, `setClientTools` | same | fold `routeClientTools`/`confirmClientTools` onto the handle as verbs (`.route(handlers)`, `.confirm(policy)`); server pending enumeration |
| `session.timeline` (NEW — was the free `timelineView`) | ✓ | Enumerable(entries), Streamable | *(none yet; history read is a READ RPC, §6)* | **the window**: seed/tail/`prepend`/`append`/clientId reconcile — unchanged semantics, re-homed | become a sub-handle; `session/timeline_history` wire read (#2); Cursor-vs-seq addressed (§6) |

Free factories (`timelineView(...)`) remain exported for the headless/composition
case — the sub-handle is the blessed path, the factory its implementation.

### 5b. The two usage postures (BOTH first-class — Ryan 2026-07-22)

- **Posture A — the handle IS your state**: `list()`/`onChange` as the store, UI
  binds directly. The quick-app path.
- **Posture B — the handle FEEDS your state**: the adopter has their own message
  model / store / joins; the handle is a typed subscription
  (`onChange(entry => myStore.ingest(toMyMessage(entry, joins)))`) — our fold and
  window are OPTIONAL, their shape is the truth. This is the no-client-cache bright
  line as ergonomics: nothing fights the adopter whose cache isn't ours. `metadata`
  passthrough carries their join keys (clientId generalized).
  Posture B is DOCUMENTED AND BLESSED in the guide, not implicit.
- Timeline window gains **`clear()`** (local view reset — trivial gap found in
  review). Init-from-anywhere (`initial`), `prepend`, `append`, visibility filter:
  already shipped (the window pass); re-homed under `session.timeline` unchanged.

## 6. Server-side prerequisites (the read-side truths clients need)

1. **Pending-request enumeration** (friction #9): request channels become
   snapshot-first (the Design-B watch-list pattern we already use for state channels:
   subscription opens with a snapshot frame of PENDING requests, then deltas) — the
   RequestResponseRegistry already holds pending state; this projects it. No new
   subsystem.
2. **`KnobDescriptor[]` on the wire** (friction #1): the knobs-state channel snapshot
   carries descriptors, not just values.
3. **`session/timeline_history`** (friction #2): the deferred wire read RPC over
   `TimelineStore.history` — cursored, bounded pages; `session.timeline.prepend`
   gains a lazy `loadOlder()` built on it.
4. **Cursor-vs-seq** (friction #3): NOT unified in this arc (a server change with
   ordering implications). Mitigation documented: history reads return the bus cursor
   alongside seq where the server co-locates them; full unification is its own
   decision. — *flagged, honest.*

## 7. Client-side hooks — the command EQUIVALENT (deliberately not parity)

The client gets an interception seam around its verbs, mirroring the server's
command middleware in SHAPE but not in machinery — no journal, no bus, no phase
contract client-side (the server owns durability/observability; a client hook is
ergonomic interception, not a second substrate):

```ts
// ONE seam, on the client (registrable at client- or handle-scope, Unsubscribe-leased):
client.use(middleware)                      // every wire verb
session.knobs.use(middleware)               // one handle's verbs
type ClientMiddleware = (params, next, ctx: { method, sessionId }) => Promise<Result>
```

- **Covers the two req-res primitives** (commands + read RPCs): auth/header
  injection, logging, retry policy, optimistic-UI bracketing, telemetry
  propagation (stamp `functionId` automatically), request capture/replay.
- **Subscriptions get a frame tap, not middleware** (observe/transform on the
  event stream feeding a view — the client twin of chunk interceptors), because a
  fold's input is a stream, not a call.
- **NOT built new:** `client-core` already carries embryonic machinery
  (`hook-registry.ts`, `pipeline.ts`, `effect-middleware.ts`) from an early pass —
  the arc AUDITS these and consolidates onto the one seam (no second path; anything
  redundant is deleted, not deprecated).
- Conformance: a middleware registered at client scope sees every handle's verbs
  (the derived-from-wire rule makes this checkable); unsubscribe restores.

## 7b. React bindings (after, not during)

Once the contract is uniform, `@agentick/client-react-next` is one-liners:
`useHandle(session.knobs)` ≡ `useSyncExternalStore(h.onChange, h.list)` — plus
`useTimeline`, `useElicitations` as named conveniences, and a rAF-batched
`useSend` (friction #7). Bindings ship WITH the arc's final slice, never before the
contract lands (no straddle).

## 8. Rollout (no straddle, each slice gated)

1. Contract + conformance suite (types + `runClientHandleConformance`) — no handle
   moves yet.
2. Server prerequisites (§6.1–6.3) — each independently green.
3. Handle refactors onto the contract, one commit per handle, conformance green each.
4. `session.timeline` re-home (+ deprecation-free removal of the loose methods —
   pre-1.0, no compat).
5. React bindings + sugar (`session.onElicitation` style wrappers only if still
   wanted once `useElicitations` exists).

## 8b. The CONFIG TAXONOMY (added after Ryan's truncateToolResults reaction)

The createApp/createGateway/createSession options surfaces have the same disease the
handles had: one locally-reasonable key accreted per pass (name, telemetry, signal,
sessions, truncateToolResults, …), no cross-cutting owner, no taxonomy — reads
undesigned because it is. DELIVERABLE (part of the north-star design, reviewed by
Ryan as one page): the full options surface laid out top-down — what groups
(egress/client policy? observability? lifecycle/limits?), what stays flat (the
withX flat-options convention governs adopter-extension types, not necessarily the
root config), which keys are seams vs sugar-over-a-seam. Every existing key gets a
designed home or moves to it (pre-1.0 — relocation is free). The three review
principles apply: keys readable without docs; operator-vs-app defaults;
seam-vs-projection placement.

## 9. Open questions for Ryan

1. **Verb naming on clientToolCalls**: `.route(handlers)` / `.confirm(policy)` (my
   lean — verbs on the handle) vs keeping longer names on the handle
   (`.routeTools(...)`)?
2. **`session.timeline` write verbs**: `prepend`/`append` are LOCAL view mutations,
   not wire commands — fine as domain verbs, or do you want them visually
   distinguished from wire-backed verbs (I lean: no distinction; the contract cares
   about shape, not transport)?
3. **Tasks streamability**: is `for await (const t of session.tasks)` (stream of task
   *changes*) worth the profile, or is onChange enough there?
4. **Codegen now or convention-first** for the write-verb derivation (§2)? I lean
   convention + conformance check now, codegen when a fifth handle appears.

# Cold reads — the residency-free read plane

**Status:** PROPOSED (2026-08-23, spec'd for build). Companion to
[`checkpointing.md`](./checkpointing.md), which is its precondition: after §2.7
every store-backed harness has a scope-partitioned durable store reachable from
the app without a live session. This doc turns that into a product-visible
invariant and closes two production defects observed the same night
(2026-08-23 residency-debug logs, knowify dock).

**Thesis — observation is free; existence follows intent.** Nothing should
exist server-side because someone _looked_: viewing a conversation must not
mount a session (cold reads, Part I), and drafting a conversation must not
create one (deferred materialization, Part II). The one residency invariant:

> **Mounting means conversing.** A live session tree exists if and only if a
> turn is running or recently ran. Reads are served from the stores; existence
> is created by the first send.

## 0. The production evidence

- The dock materializes a session per thread **view** (`app/create_session`
  ensure-on-open — 14 views mounted 14 live trees in one browsing session;
  residency logs 01:56–01:58). Browsing churns residency; the idle window's
  floor is set by _viewing_ behavior, not conversation.
- `resumeSession` is **unreachable in production**: ensure-create wins the
  race every time, so the resume door — where interruption detection and the
  resume telemetry live — never fires.
- New chats create sessions (and, via title/meta writes, durable rows) before
  anything is sent — blank rows in `assistant.sessions`, defeating the
  runtime's own lazy-persist design (session-state.ts: "a 'new chat' that
  never sends stays off the durable registry"). The client is hacking around
  the read surface, not choosing this.
- The read surface FORCES all of it: `timeline/history` routes through the
  live harness's command lane, and the wire deliberately 404s observation
  verbs on non-live sessions. The client cannot read without mounting.

Measured costs that make the end state cheap: evict 49–92ms, rebuild 60–150ms
(cold pg read + mount), live-hit 1–16ms.

---

## Part I — Cold reads

### 1. The generalization: is it per-harness? YES, and it is already half-built

Post-checkpointing, the store-backed harnesses share one shape: an app-scoped
store, partitioned by session scope, that the harness itself derives its scope
keys for. The residency-free read is the same query the harness's `hydrate`
runs — issued by the wire layer instead of a mounting session:

| Harness  | Store (app-scoped)      | Scope key               | Cold read                            |
| -------- | ----------------------- | ----------------------- | ------------------------------------ |
| timeline | `TimelineStore` (log)   | `${sessionId}:timeline` | `history` page (seq-cursored)        |
| knobs    | `KnobStore` (cells)     | `${sessionId}:knobs`    | values partition                     |
| state    | `StateStore` (cells)    | `${sessionId}:state`    | cells partition                      |
| session  | `SessionStore` (record) | id                      | already cold (`list_sessions`/`get`) |
| tasks    | `TaskStore`             | app-scoped already      | already cold                         |

The session record and tasks prove the pattern: their read surfaces never
required residency. This doc extends that property to the session-scoped
harnesses. This is the memory rule "enumeration is foundational for client
wire surfaces" completing itself: the enumerate-half of each harness's
collection, over durable data.

### 2. Mechanism — a fourth namespace-slot arm

Precedent: the app-scoped-defaults arm (checkpointing P3) let each namespace
register a default-store factory without the app naming any namespace. Cold
reads are the same registration pattern:

```ts
// registered by each harness package alongside its slot (augment.ts)
interface NamespaceColdReads {
  /** verb suffix → handler over (store, sessionId, params). */
  readonly [verb: string]: (
    store: unknown, // the namespace's slot store (typed per package)
    sessionId: string,
    params: unknown,
    ctx: StoreCtx,
  ) => Promise<unknown>;
}
```

- The HARNESS package owns scope derivation (`timelineScopeKey(sessionId)`)
  and the query — coordinates and page shapes only, the same
  "coordinates-not-contents at the framework layer" rule as everywhere.
- The APP/gateway owns resolution: sessionId → durable record (authz by
  record principal — the `findRecordPrincipal` gate already exists) → the
  app's slot store → the registered handler. **No session, no mount, no
  bridge.** The framework still never sees data; it routes a read to the
  package that owns it.
- No hardcoded namespace list anywhere (ADR 27): `namespaceSlotColdReads()`
  iterates the registry exactly as `namespaceSlotAppScopes()` does.

### 3. Wire routing — SAME verbs, resolution order

**Decision: no new verb names.** A read verb resolves live-first, cold-fallback:

1. Live session in the registry → the existing harness command path
   (unchanged semantics; live includes any unflushed write-behind).
2. Not live → the cold handler over the store.

For `timeline/history` the two are semantically identical by construction: the
live path flushes then reads the store; a non-live session HAS no unflushed
writes (eviction is the flush barrier). So the fallback is not a second
meaning — it is the same read minus a mount. Clients change NOTHING about how
they call; they only STOP ensure-creating first. (Wire dialect logic lives in
the wire bridge, per the wire-constraints rule; the shared substrate is
untouched.)

`session/compile`, `list_tools`, `model_info` remain live-only: they are
questions about a mounted tree, and 404-on-non-live stays their honest answer.
The reaper-abuse rationale in `find-session.ts` (a reconnecting UI must not
page fifty threads back in) is PRESERVED — strengthened, because now even the
legitimate reads don't page anything in.

### 4. Subscriptions accept non-live sessions

`sub/subscribe` currently 404s on a hibernated id (findSession). Change: a
subscription is admitted for any session whose durable RECORD the principal
may see. A subscription to a quiet session is just quiet; events flow when a
send mounts it. This is what makes the UI live without the UI causing
liveness. (Bus scope-subscriptions are address-based — nothing about them
requires the session object; only the admission check changes.)

### 5. What dies

- The dock's ensure-create-on-view, and with it the 1–2ms `create` telemetry
  noise (create count ≠ mount count today — a dashboard trap).
- The forced-mount scroll-back: fat threads page from pg lazily instead of
  hydrating whole at mount.
- The sub-90s floor on `idleTimeout`: with viewing free, the window is purely
  conversational; 60–90s becomes reasonable (measured rebuild 60–150ms).

---

## Part II — Deferred materialization (no row until first send)

### 6. Drafts are client-side

A "new chat" is a client-local draft: the client mints the sessionId (already
legal — ids are client-suppliable) and renders an empty timeline WITHOUT any
server call. No record, no registry row, no mount. `list_sessions` on another
device does not show it — correct: it does not exist yet.

### 7. First send creates

`session/send` gains **create-on-miss**: find live → resume from record →
**create** when neither exists. The open-or-rehydrate philosophy completes:
send is the one existence-creating verb.

The one real design problem: a nonexistent id resolves to NO app. Options:
(a) `SendParams.appId?` — required only for the miss case; the dock knows its
app id (it already names it in `app/create_session` today).
(b) A single-app-gateway default (ernesto's actual topology) — miss resolves
to the only app; multi-app gateways REQUIRE (a).
**Decision: both** — (b) as the zero-config path, (a) as the explicit one;
ambiguous miss on a multi-app gateway is a loud typed error, never a guess.

Authz: creation-by-send stamps the caller's principal exactly as
`app/create_session` does today (same door-side identity plumbing — the wire
dispatch gate already resolves it).

### 8. What this cleans up (the "hack" acknowledged)

- Blank/Untitled rows: the record is written on the first REAL status
  transition of a real turn — the runtime's lazy-persist design finally
  operates as designed, because no client pre-creates.
- `app/create_session` remains for hosts that genuinely want eager creation
  (imports, migrations, programmatic setup). It stops being the dock's view
  path.
- The create-door detection gap becomes marginal for the dock: sends into
  existing-but-cold sessions take the RESUME door (detection + telemetry fire
  where designed). The framework-side door unification (#311:
  `SessionRuntime.hydrate` capture) is STILL built — for in-process adopters —
  but after this, since this decides which door production uses.

---

## 9. Rollout

**Framework (slices, each gated on the full root suite):**

1. Cold-read registration arm + timeline's `history` cold handler + wire
   live-first/cold-fallback resolution + per-harness conformance section
   (family obligation rides the existing conformance vehicles).
2. Subscription admission by record.
3. `session/send` create-on-miss (+ `appId` param + single-app default +
   typed ambiguity error).
4. knobs/state cold values reads (when the dock actually needs them cold —
   NOT speculatively; three-consumers rule).

**knowify (after the framework publish):** 5. ernesto-client: thread-open flow drops ensure-create (history read +
subscribe only); new-chat becomes a local draft; first send carries appId. 6. Dock: render status from the `list_sessions` row it already holds; knob UI
defers until live. 7. Delete the ensure-create hack + verify: `create` telemetry only on real
creations, `resume` events appear, blank rows stop.

**Follow-through:** re-measure the idle window (expect 60–90s viable);
re-run the residency-debug observation session; then the door unification.

## 10. Testing (every claim pinned)

- Per-harness cold-read conformance: cold result ≡ live result post-flush
  (the equivalence IS the contract).
- Wire: history on a hibernated session returns the page and does NOT mount
  (registry asserted empty after); subscribe-non-live admits + stays quiet +
  flows after a send mounts.
- Send-create-on-miss: fresh id → session exists + turn runs + record written
  once (no blank row before; single-app default; multi-app ambiguity error).
- Regression: viewing N threads leaves registry size 0 (the anti-14-mounts
  pin).

## 11. Open questions (decide at build, not silently)

1. Cold-read handler typing: the registration is generic (`unknown` store) —
   per-package typed wrappers keep adopter surfaces typed; is the internal
   `unknown` acceptable (matches the defaults-arm precedent) or does the
   registry gain a generic parameter?
2. Does `timeline/history`'s cold path need principal-scoped page limits
   (a hostile client paging entire fat logs)? The live path inherits guard
   seams; the cold path needs its own quota decision.
3. Draft-id collisions: client-minted id already existing (another device's
   session) — first send would RESUME it. Correct-by-accident or does the
   dock need create-intent (`expectNew: true` → typed conflict error)?

# ADR 93 — Namespace definitions: `defineX`, the genesis seam, and the client read doors

**Status:** DRAFT (converged in design conversation with Ryan, 2026-07-26)
**Builds on:** ADR 42 (dichotomy — definitions are its declarative arm, named),
ADR 49 (stores-not-snapshots — store stays the port; genesis authority moves),
ADR 66/91 (ctx facets — `ctx.store` is a boundary facet), ADR 90/92 (reads are
commands — the client door), the data-layer plan (§2.7 bounded projection,
Phase-2 journal seam — `hydrate` is its adopter door)

## The law

> A store-bearing namespace is configured by a **definition**:
> `defineX({ store?, hydrate?, ...policy seams })`.
> The **store** is the durability/query port (unchanged: certifiable,
> decoratable, ecosystem-facing). **`hydrate(ctx)`** is the genesis seam —
> an async function of the derived ctx returning the namespace's initial
> state; `ctx.store` is the definition's own store as a typed facet; each
> namespace names a default hydrator (timeline: `hydrateFromStore()`;
> skills/prompts: none). Remaining seams are that namespace's shaping
> verbs (timeline: `compact(entries, ctx)`). Genesis output is SEED, never
> re-appended to the store. One definition object is consumed by both
> `createApp({ x })` and `withX(...)`, and is what the file grammar's
> namespace files will default-export.

Signature grammar (uniform with every ADR 91 seam): `(subject, ctx)` —
the subject positional, reality + facets on ctx. `hydrate` has no
subject: `hydrate(ctx)`.

`defineXStore({...})` is the port's typed inline constructor (minimal
verbs; optional verbs defaulted), certified by the existing
`runXStoreConformance` suites.

## The layer stack (nothing moves; one layer is added)

ops (hooks/guards/journal — ADR 92) → **definition seams (genesis +
shaping policy — THIS ADR)** → store decoration (adopter-composed
wrapping) → the port (mechanism). Stores do NOT get hooks — interception
is the op layer; write mediation is decoration.

## Per-namespace map

| Namespace | Definition | Genesis default | Notes |
| --- | --- | --- | --- |
| timeline | `defineTimeline({ store?, hydrate?, compact?, writePolicy? })` | `hydrateFromStore()` (ADR 49 open-or-rehydrate preserved) | proving instance; §2.7 bounded projection rides along so a bounded hydrator really loads N |
| skills | `defineSkills({ store?, hydrate? })` | none (explicit) | UNIFIES sources: directory/URL/literal become named hydrators (`hydrateFromDirectory`, `composeHydrators`); tiered catalogs are hydrators reading `ctx.principal` |
| prompts | `definePrompts({ store?, hydrate? })` | none | kills the withPrompts-lacks-store asymmetry |
| tasks | `defineTasks({ store?, executor?, hydrate? })` | none | `hydrate` = pending-task reload on resume (currently undefined semantics → adopter policy) |
| sessions (registry) | `defineSessions({ store?, evict? })` | n/a | `evict(ctx) ⇒ verdict` turns the idle-eviction sweep into a seam (pairs with ADR 92 Slice B) |
| knobs / state / credentials | `defineKnobs/State/Credentials({ store? })` | store-backed | thin members; conforming costs nothing |
| resources | `defineResources({ hydrate? })` | none | tree-mounted declarations stay tree concerns; per-URI resolvers stay subject seams |

| sandbox | `defineSandbox({ provider, bootstrap?, hooks?, guards? })` | `bootstrap(ctx)` — imperative | the ENVIRONMENT-namespace genesis verb: no store slot (not store-bearing), no hydrate; `ctx.sandbox` is the live handle (eve's bootstrap idiom, landed). Fork semantics (re-bootstrap vs provider clone) = open D-phase question. |

**The genesis seam has two verbs, by namespace nature:** DATA
namespaces `hydrate(ctx) ⇒ records` (source-agnostic catch-up);
ENVIRONMENT namespaces `bootstrap(ctx) ⇒ void` (imperative setup
against the live capability). One slot family, two named verbs —
forcing either through the other's shape is false symmetry.

**Non-members (do not force):** gates (tree/loop concern, no store),
model/executors/compiler (first-class slots, no storage semantics).

## Definition-level hooks (amendment, Ryan 2026-07-26)

Definitions also accept the namespace's hook/guard seams as properties —
pure colocation sugar over harness-scoped command middleware (no new
mechanism):

- **Placement (Ryan correction): hooks live under a `hooks:` bag at
  BOTH sites** — `createApp({ hooks: {...} })` and
  `defineX({ hooks: {...} })`. The bag is not a wrapper (the
  flat-options rule targets semantically empty envelopes): it is the
  cascade's own boundary — hook bags merge down the inheritance chain —
  and it keeps the definition's top level for structural slots
  (store/hydrate/compact) instead of 2×N verb keys.
- **Naming:** inside a definition's bag the layer segment DROPS
  (`hooks: { onBeforeAppend }`); the app-level bag keeps the full
  discriminated name (`onBeforeTimelineAppend`). Both desugar to the
  same command-scoped middleware on the same op.
- **Ordering:** broader scope wraps narrower (chain of responsibility) —
  app-level before-hooks run FIRST, definition-level run inside them,
  then the op body; afters unwind in reverse. Same law for guards:
  app-level verdicts outrank definition-level. Rationale: governance
  outranks local policy — an app guard must veto before layer-local
  logic runs.

## Composition ruling — withX(definition) (amendment, Ryan 2026-07-26)

**The definition IS the options**: for store-bearing namespaces,
`withX(definition | inlineOptions | liveInstance)` — the inline bag is
the SAME TYPE as `defineX`'s parameter (`defineX` = identity + brand,
valued for portability: grammar files default-export it, tests import
prod definitions and override slots). `createApp({ x })` is the
metapackage's sugar over the same extension (ADR 27 — built-ins are
bundled, not privileged). **Timing law: definitions are INERT until install.** `defineX(...)`
evaluates to pure branded data — no harness constructed, no store
opened, no hydrator run. Construction is PER-SESSION at install
(`withX(definition)` captures the plan; each session's install builds
its own harness from it), and genesis (`hydrate(ctx)`) runs at
session-open with that session's reality. `defineX` = plan;
`createX`/`new XHarness` = live thing. The live-instance form is the
BYO/single-session escape hatch precisely because its timing differs —
the adopter owns its lifecycle. REJECTED: `provideX` (foreign DI semantics;
withX is house vocabulary); `withX({ x: defineX() })` nesting (the
config-wrapper the flat-options rule kills — the escape hatch is the
dichotomy's LIVE-INSTANCE form, not a nested slot). Scope: this
one-size rule holds exactly where the definition surface is closed;
third-party extensions whose config is not a namespace definition take
whatever their domain needs (defineX becomes guidance, not law).

## Guards on configs + the completeness matrix (amendment, Ryan 2026-07-26)

**`guards:` is a sibling bag of `hooks:`** at both sites — guards are a
distinct KIND (verdict seam: proceed/veto/replace/defer), never folded
into hooks. Drop-layer keys in definitions (`guards: { append }`),
discriminated at app level (`guards: { timelineAppend }`); desugars to
guard-kind interceptors, which the runner already orders
GUARD-OUTERMOST. Total order: app guards → definition guards → app
before-hooks → definition before-hooks → body → afters unwinding
narrow-to-broad.

**Definition surface — complete and closed** (candidates judged, not
accumulated): `store` · `hydrate` · namespace shaping seams (`compact`,
`writePolicy`, `evict`, `executor`) · `hooks:` · `guards:`. Judged OUT:
`use:` raw-middleware bag (hooks+guards cover config cases; third form
= duplicate seam; imperative `.use` remains — three-consumers holds the
door); wire-exposure grants (`expose:`) — REAL requirement, WRONG home:
a grant is deployment posture, not namespace nature; grants stay at the
gateway (wire constraints at the wire), D2 ships the recipe; telemetry
namespace (trunk field, ADR 91 P3); channels (the bus); error/validation
seams (typed errors + hook replace/veto).

## D1 spec (tight) — deliverables + gates

Deliverables: `defineTimeline` + `defineTimelineStore`;
`hydrate(ctx)`/`compact(entries, ctx)` with typed `ctx.store` facet
(generic inference from the store slot); `hydrateFromStore()` +
`hydrateTail(n)`; `hooks:`/`guards:` bags with drop-layer naming +
cascade wiring; `AppOptions.timeline` slot (flat, replaces
`session.timeline`); DELETIONS: `WithTimelineOptions.initial`,
`rehydrateStrategy` + importSnapshot-as-resume path; §2.7 bounded
projection (in-memory persisted tier dropped; `readPersisted()`
becomes a store read); interceptor-cascade totalization (landmine 11 —
installer threads the handle so app bags wrap every namespace);
fork-no-genesis law.

Gates (all must pass, judged first-hand): full workspace suite;
kill/resume acceptance; **bounded-memory proof** (N-entry store +
`hydrateTail(k)` ⇒ only `history` with limit k is called — assert
`read` is NOT); **fork-no-hydrate** test (fork inherits image, hydrator
not invoked); **seed-not-append** conformance (genesis entries never
hit `append`); **cascade-order** test (app guard vetoes before
definition guard runs; app before wraps definition before; afters
unwind reverse); ctx.store type-test file (inference + `Derived`
interplay, `@ts-expect-error` style); example/v2-* packages compile
against the new `AppOptions`; consumer canary = the Knowify bump slice
verifies `buildErnestoAppConfig` downstream.

The filesystem's role in resources is the SOURCE, not the store:
`resourcesFromDirectory(dir)` is a named hydrator+resolver pair
(directory → declarations; file resolver → content on read), the
namespace's flagship source — parallel to skills'
`hydrateFromDirectory`. The declaration store defaults to memory like
every namespace (persisting the catalog ≠ serving files).

## Substrate alignment

- **Journal:** untouched on the write path (appends journal as ops,
  layered records per ADR 92). COMPLETED on the read path: `hydrate` is
  the adopter door to the data-layer Phase-2 dream — an event-sourced
  namespace is a hydrator folding `ctx.journalReader`. Event sourcing
  becomes something an adopter writes, not something the framework
  promises.
- **ADR 42:** definitions ARE the declarative form; live-instance form
  unchanged; no third form.
- **ADR 48/51:** genesis runs with the session's derived ctx — principal
  and identity are simply *there* (the Knowify tiered catalog is the
  proof case).

## The client read doors (client hydration ≠ agent hydration)

Agent genesis shapes MODEL reality; client hydration shapes UI reality.
Same store, different doors, no shared seam:

1. **Standard reads are wire-exposable commands** (ADR 90/92): the
   framework ships `timeline:history` (cursor paging → client
   scroll-back via the window's `prepend`), and per the
   enumeration-is-foundational rule every client-projected collection
   ships enumerate + added/removed (tasks, skills, prompts). Wire
   exposure is GRANT-gated (deny by default); tenancy is a GUARD
   reading the caller's identity; retention is journal policy
   (bus-only). The client SDK grows the typed consuming faces.
2. **Bespoke reads are adopter commands**: a custom projection for a UI
   is one declared command whose handler reads the adopter's store
   (typed, guard-gated, same grammar). NO generic client→store query
   passthrough — arbitrary client queries against store shape are an
   injection surface and a coupling trap; the command is the
   attenuation point.
3. **The bright line holds:** the framework owns no client cache; the
   client window remains a fold over the event stream plus explicit
   paged reads.

## Rendered moot (deletions, no shims)

1. `WithTimelineOptions.initial` → `hydrate: () => entries`.
2. `importSnapshot`-as-resume + `rehydrateStrategy` (timeline) → the
   store+hydrate path is THE resume story; rehydrate shaping folds into
   `hydrate`/`compact`.
3. Skills' parallel source-config vocabulary → named hydrators.
4. The prompts/skills store-option asymmetry.

## Rollout

- **D1 — timeline (proving instance):** `defineTimeline` +
  `defineTimelineStore`, `hydrate`/`compact` seams with `ctx.store`
  facet + named hydrators, §2.7 bounded projection, the moot-list
  deletions, `AppOptions.timeline` slot. Gate: full suite + kill/resume
  + a bounded-hydration proof (N-entry store, tail-k hydrator, memory
  holds k).
- **D2 — timeline client completion:** `timeline:history` wire grant +
  client scroll-back face (`history` → `prepend`), guard recipe for
  principal scoping documented.
- **D3 — skills + prompts:** source unification; the Knowify tiered
  hydrator lands in the follow-up slice as the consumer proof.
- **D4 — the rest as touched:** tasks (with resume semantics), sessions
  (`evict` seam, pairs with ADR 92 Slice B), knobs/state/credentials.
  Store-DX docs (contract tables, project-don't-translate guide,
  teaching conformance failures) ride the README fan-out.

## Landmines (named, each with its defusal)

1. **Fork/spawn double-genesis.** `hydrate` must NOT run for forks
   (a fork inherits the parent's image; re-running genesis duplicates
   or diverges). Law: hydrate runs on CREATE and RESUME, never on
   FORK/SPAWN-inherit. Test in D1.
2. **Genesis/restore ordering.** hydrate runs before first render,
   after identity stamping, before the write pump starts; a hydrator
   throwing = session creation fails typed (no half-genesis session).
   Define once in D1, conformance-case it.
3. **Seed-not-write discipline.** The #1 adopter footgun (duplicating
   hydrators). Stated in the definition contract + a conformance case
   asserting genesis entries don't hit `append`.
4. **§2.7 memory-shape change.** Dropping the in-memory persisted tier
   changes `readPersisted()` semantics (becomes a store read / bounded
   view). Touches the client window seed and kill/resume suites —
   the churny part of D1; sequence it inside D1, not across slices.
5. **`AppOptions` reshape.** `timeline:` top-level (flat-options rule)
   breaks `session.timeline` consumers — Ernesto's
   `buildErnestoAppConfig` updates in the same window as D1's publish.
6. **TS inference through the definition.** `ctx.store` typing flows
   from the `store` slot via generics; interplay with the `Derived`
   brand needs a type-test file (the `@ts-expect-error` pattern from
   ADR 91).
7. **Wire-read tenancy defaults.** Exposing `timeline:history` without
   a guard is a cross-tenant read hole. The grant recipe ships WITH the
   principal-scoping guard example; the same-principal target rule
   (ADR 48) covers session-scoped reads — verify in D2's gate.
8. **Skills directory-source migration.** `hydrateFromDirectory` must
   preserve SKILL.md semantics exactly (the file grammar depends on
   it); delete the old source options only in the same commit that
   proves parity.
9. **Slice collisions.** D1 touches timeline/store/spec while ADR 92
   Slice B (session close/evict) and Family 3 (tasks submit) are
   queued — sequence: Slice B → D1 → D2 → D3; tasks' definition (D4)
   lands WITH Family 3's async submit, not before.
10. **No big bang.** Namespaces convert as touched; two conventions
    coexisting mid-rollout is acceptable ONLY because pre-cut; the cut
    requires the sweep complete (add to the cut checklist).
11. **The interceptor-inheritance gap must close in D1.** The app
    installer does not expose the interceptor handle, so app-level
    hooks/guards do not wrap every namespace today (subscription fires
    escaped `app.guard` — the ADR-92 TODO at the subscriptions
    extension). Once definitions ship `hooks:` bags, adopters will
    assume the app bag wraps them all — make the cascade total before
    the sugar advertises it.

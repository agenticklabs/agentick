---
"@agentick/timeline": minor
---

ADR 93 D1 — the namespace-definition proving instance. `defineTimeline`
(identity + non-enumerable brand; the definition IS the options, inert
until per-session install) and `defineTimelineStore` (the port's typed
inline constructor with a derived query/mutate seam and loud failure on
un-answerable cursor queries). The genesis seam: `hydrate(ctx)` with a
typed `ctx.store` facet; named hydrators `hydrateFromStore()` (default —
ADR 49 open-or-rehydrate preserved) and `hydrateTail(n)`; the genesis
laws enforced and tested — seed-never-append, fork/spawn never re-runs
genesis, a throwing hydrator fails session creation typed.
`compact(entries, ctx)` definition sugar over CompactStrategy.
`hooks:`/`guards:` bags with drop-layer naming; the interceptor cascade
is now TOTAL at every host tier (app + gateway + session installers
thread the handle — app-level guards wrap every namespace).
`createApp({ timeline })` top-level slot via augmentation + side-effect
slot registration. Deleted: `WithTimelineOptions.initial`,
`rehydrateStrategy`/importSnapshot-as-resume. §2.7: the in-memory
persisted tier is gone — bounded hydration really loads N.

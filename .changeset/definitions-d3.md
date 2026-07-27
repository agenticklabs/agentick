---
"@agentick/skills": minor
"@agentick/prompts": minor
"@agentick/spec": minor
"@agentick/runtime": minor
---

ADR 93 D3 — skills + prompts join the definition grammar.
`defineSkills({ store?, hydrate?, hooks?, guards? })` and
`definePrompts({ ... })` — identity + brand, inert until per-session
install, the D1 pattern verbatim. Source unification: the parallel
source-config vocabulary is DELETED (moot #3) in favor of named
hydrators — `hydrateFromDirectory(dir)`, `composeHydrators(...)`, and
literal seeding — with the node-only directory loader split onto its
own subpath so browser bundles stay clean; the package `./loaders`
subpath is renamed `./hydrators`. Prompts gains `store?` (moot #4 — the
withPrompts-lacks-store asymmetry dies). Genesis default for both is
none/explicit; the three genesis laws are enforced and tested
(seed-never-append, fork/spawn never re-runs genesis, a throwing
hydrator fails session creation with typed `SkillsHydrateFailed` /
`PromptsHydrateFailed`). `hydrate(ctx)` carries the typed store facet
and trunk identity — `ctx.principal` is readable, the tiered-catalog
seam. `createApp({ skills, prompts })` top-level slots land via the
same augmentation + side-effect slot registration as timeline.

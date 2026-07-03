# Verb-coverage matrix (#140) — the ADR 51 exposure decisions

**Status:** RATIFIED 2026-07-03 (Ryan, commit-comment on a7358fa2) — with
the caveat that `state:*` and some `timeline:*` calls get re-evaluated
later; grants remain the runtime control either way. Everything else is enumerated from source
(`harness.commands()` declarations as of `8d6ca9b2`).
**Feeds:** #141 (slice 5 — the dynamic resolver projects exactly the
`wire? = yes` rows), ADR 34 (scope labels are the grant vocabulary).

Conventions: every verb is req-resp over the inbox ask contract; the
authz **scope label = the verb string**; the default **target rule is
same-principal** (ADR 48 fusion rule — caller's principal must equal the
target session's; elevation via granted scopes). `exposure` today is
`addressable` for every row (trusted domains: in-process + cluster);
`wire? = yes` additionally sets `exposure: "wire"` on the declaration.

Payload classes: **data** (pure serializable input), **advisory**
(data the resident config may honor/ignore), **signal** (no payload —
bare verb resolved by construction-bound config).

## Session-scoped harnesses

| Verb | Payload class | wire? (proposed) | Rationale / notes |
| --- | --- | --- | --- |
| `timeline:compact` | signal + advisory (`instructions?`) | **yes** | The flagship signal form; safe by construction (strategy is resident). |
| `timeline:append` | data | no | Bypasses the loop + pending queue; admin/import tooling can earn it later with a dedicated scope. |
| `timeline:queue` | data | no | Client input belongs on the `session/send` porcelain (which drains); a second input path invites ordering confusion. |
| `timeline:drain` | signal | no | Execution-lifecycle internal; the loop owns drain timing. |
| `timeline:replaceProjection` | data | no | Arbitrary projection overwrite — powerful; offline-curation tooling can earn a scope later. |
| `timeline:resetProjection` | signal | no | Pairs with replaceProjection; same posture. |
| `state:set` / `state:delete` | data | no | Session-internal K/V; not a client surface. Adopters project explicitly if they want it. |
| `knobs:set` | data | **yes** | Knobs are the user-facing config surface — a client flipping a knob is the designed UX (v1 precedent: set_knob + UI). |
| `knobs:register` | data (optional `validate` fn degrades) | no | Declaration is the tree's/app's job. |
| `knobs:dispatch` | data | no | The model-tool path (set_knob semantics); clients use `knobs:set`. |
| `skills:register` / `skills:update` / `skills:remove` | data | **yes** | Skill-library management from an admin UI is a designed surface (Knowify memory/knowledge tools); grants gate who. |
| `prompts:register` / `prompts:update` / `prompts:remove` | data (optional `render` fn degrades) | **yes** | Same admin rationale; addressable form carries `template` data. |
| `prompts:get` | data | **yes** | Read surface (MCP `prompts/get` analog). |
| `prompts:invoke` | data | **yes** | Queues rendered messages onto the timeline — the prompt-driven-input UX; same-principal rule applies. |
| `sandbox:*` (all 7) | data | **no — hard hold** | `exec`/`write-file`/`edit-file` are code-execution/file-mutation primitives. Never `wire` before slice 6 (DispatchPolicy) AND a per-verb grant story reviewed together. `stat`/`readdir`/`read-file` could earn read scopes later; deferred as a set for coherence. |

## MCP client harness (per-connection, principal-bound)

| Verb | Payload class | wire? (proposed) | Rationale / notes |
| --- | --- | --- | --- |
| `mcp:list-tools` | signal | **yes** | Read/discovery — the #279 (legacy) client-projection intent; the generic lane supersedes bespoke porcelain here. |
| `mcp:list-tasks` / `mcp:get-task` / `mcp:get-task-result` | data | **yes** | Status surfaces; enumeration-is-foundational. |
| `mcp:cancel-task` | data | **yes** | Paired verb of task status; same-principal. |
| `mcp:call-tool` | data | no | Client-invoked server tools bypass the model loop AND the capability-policy gate; earn later with an explicit scope + policy story. |
| `mcp:call-tool-as-task` | data | no | Same posture as `call-tool`. |

## Meta-verbs

| Verb | wire? | Notes |
| --- | --- | --- |
| `<surface>:commands` (×7) | **yes** | Discovery — required by `commands/list`; returns wire-safe `CommandInfo` only. |

## Candidates not yet declared (listed for completeness; decisions deferred)

| Verb | Status |
| --- | --- |
| `session:dispatch` | Easy first session declaration (#142); when declared: **wire yes** (it's the `session/dispatch` porcelain's semantics; capability policy applies at tool dispatch regardless of origin). |
| `session:send` (signal form) | Needs the designed serializable form (#142); when declared: **wire yes** (supersedes-or-backs the porcelain). |
| `app:close-app` / `gateway:close-gateway` | Declarable (no input); **wire no** for v2.0 — remote shutdown stays ops-tooling over trusted domains (addressable) only. |

## Tally of the proposal

- **wire yes: 17** (1 timeline + 1 knobs + 3 skills + 5 prompts + 5 mcp + 7 meta-verbs... counting meta-verbs as one row: 15 + 7 = 22 method names on the wire).
- **wire no: 16**, of which sandbox's 7 are a hard hold.
- Every `yes` still requires a **grant** (deny-by-default): shipping slice 5 exposes nothing to any principal until `staticAuthorizer({ grants })` says so. The `wire?` column decides what is *grantable*, not what is *granted*.

## Sign-off

- [x] Ryan: `wire?` column ratified (⛔ #140, 2026-07-03) — #141 implements exactly these rows.
  Caveat recorded: re-evaluate `state:*` + some `timeline:*` post-slice-5.

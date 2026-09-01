# ADR 108 — Canonical tool identity: `(fullName, group path)`, every surface a projection

**Status:** DRAFT 2026-09-01 (Fable, for Ryan). Written the same day the idea was
briefly IMPLEMENTED at the registry and then deliberately reverted to
renderer-only (same-day, versions next.189–.191): the consequences are
migration-class, and a patch is the wrong vehicle for them. This document is the
careful study the revert bought time for.
**Builds on:** the tool-groups capability as shipped in next.184–.190
(`ToolGroupInfo` / `GroupInfo` in spec, `toolExecutor.groups` with `list(root?)`,
`RenderContext.toolGroups`, installer `registerToolGroups`, the MCP
`agentick/toolGroups` list-result manifest, the `[serverId]` default for
unannotated proxied tools, alias-aware `tools.subscribe`).
**Relates to:** SEP-993 (namespaces via `__` in names — superseded), SEP-1300
(groups/tags + `groups/list` — draft, labeled rejected), WebMCP #255 (collections
— active strawman, inverse ownership). All three converge on per-group prose
declarations; none converged on a membership convention.

## TL;DR

1. **The proposal:** a tool's identity is the pair `(fullName, group path)`,
   `__` the namespace separator, and a declaration may author either half —
   the registry completes the other:
   - `name: "some__named__tool"`, no `group` → derive `group: ["some","named"]`.
   - `name: "tool"` + `group: ["some","named"]` → register as
     `some__named__tool`, short name preserved as a dispatch alias.
   - Both authored, disagreeing (`knowify__query` + `["knowify-read"]`) →
     verbatim: the name is identity, the group is filing.
2. **Every surface becomes a projection of that one identity:** the prompt
   catalog (nested tree + declared prose — shipped), the wire name, and
   `execute_code` bindings as dot-namespaces
   (`tools.knowify.service_job.create(...)`, with the flat
   `tools.knowify__service_job_create` kept as an alias).
3. **What ships today instead:** renderer-side derivation only — a `__`-bearing
   name with no `group` files into the prompt tree (`impliedGroup`, in the
   adopter's renderer), and nothing rewrites either half of any declaration.

## Why the registry implementation was reverted

The derivation direction (name → group) is nearly dormant in practice — every
first-party tool declares a group, and the MCP client stamps `[serverId]`
before registration — but it is still a semantic change to the identity layer
of a foundational registry, made ambiently. The qualification direction
(group → name) RENAMES the model-visible fleet: `render_chart` becomes
`artifacts__render_chart` in one deploy. Aliases keep `dispatch`/`get`/`has`
resolving (verified: name-then-alias is the registry's existing resolution
path), and the two doors that did NOT honor aliases were fixed and kept —
`tools.subscribe` resolves the subscribed name before filtering (next.190),
and the standing-grants policy checks the canonical name plus every alias
(adopter-side). But three consequence classes remain unstudied:

1. **Persisted timelines** replay `functionCall`s under old names while the
   live tool list carries new ones. Providers tolerate unknown names in
   HISTORY (the fc/fr pairing that must agree is within one request), but the
   model reads two names for one capability across a rename boundary, and no
   measurement exists for how much that costs.
2. **Model habit + prompt-cache identity.** Names appear in cached prefixes,
   few-shot fragments, skills, and the model's own priors from earlier turns.
   A rename invalidates all of it at once.
3. **Cross-adopter blast.** The lane has one adopter today. The always-on
   derivation changes any future adopter's `__`-named ungrouped tools
   silently; identity changes should never be ambient defaults.

## The decision this ADR must actually make

Not "is the model elegant" (it is) but **where canonicalization is allowed to
happen**:

- **A. Renderer-only (status quo after the revert).** Names never change;
  filing may be derived for display. Zero migration surface. tool_search
  indexes the live registry so it can never show a non-resolving name;
  `tool_docs`/`tool_dispatch` resolve name-then-alias regardless.
- **B. Registry derivation, opt-in qualification (the reverted shape).**
  Requires: the alias-aware doors (done), a grant-rekey story (done,
  adopter-side), a subscription story (done), a timeline-cost measurement
  (not done), an explicit adopter migration guide (not done).
- **C. Full canonicalization by default.** Requires B plus a fleet-rename
  migration for every existing adopter. Not proposable until B has soaked.

## execute_code dot-namespaces (deliberately unshipped)

The third projection: bindings built from canonical identity as nested
objects — `tools.knowify.service_job.create(...)` — with flat `__` bindings
kept as aliases. Consequences to study before building:

- The binding surface is a MODEL-FACING API: programs in persisted timelines
  reference the flat names; replayed or re-derived programs must keep running
  (flat aliases cover this, but forever?).
- Name collisions between a namespace object and a flat tool
  (`tools.svc` the namespace vs a tool literally named `svc`).
- The TypeScript declaration surface `declareBindings` hands the model — the
  dotted form needs generated nested types or the model writes against `any`.
- Whether the namespace tree should be the GROUP tree or the NAME tree — they
  differ exactly where a declaration authors both halves (`knowify__query`
  filed under `knowify-read`): the code surface should almost certainly follow
  the NAME (it is the identity), which means `tools.knowify.query`, not
  `tools.knowify_read.query`.

## Migration sketch, if B is ever accepted

1. Flip `qualifyToolNames` per family, not fleet-wide; each family's short
   names ride `aliases` indefinitely.
2. Measure a renamed family's replay cost on real threads (the sentinel
   playbook from the Vertex cutover applies: old identity preserved,
   migrations run once per environment).
3. Grant rows self-heal (alias-aware read; canonical writes), subscriptions
   self-heal (alias-aware filter). Nothing else in the framework stores names.

## What this does not solve

Group prose for namespaces derived from names alone (a derived
`["some","named"]` has no declaration; it renders raw-key by design — the nag
is the feature). Resource/prompt/skill groups (same `GroupInfo` shape, their
own registries and wire keys) are additive and orthogonal.

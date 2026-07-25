# ADR 42 — Harness-slot trichotomy (instance | config | shorthand)

**Status:** Proposed — 2026-06-29.
**Touches:** every package whose adopter-facing options surface a slot
backed by a harness — initial set: `@agentick/mcp/server`
(`prompts`, future `tools` / `tasks` / `elicit` / `sample`),
`@agentick/app` (`tools`, `skills`, `prompts`),
`@agentick/eval` (`app`), `@agentick/gateway`
(`mcpServers` and its inner slots). Cross-references ADR 26
(harness API shape) and ADR 27 (modular built-ins).
**Driver:** During #171d.1b, the prompts slot leaked the word
"harness" into adopter code (`prompts: { harness: somePromptsHarness }`).
Renaming alone fixes one slot; without a convention every future slot
re-invents the shape and the framework's adopter-facing vocabulary
drifts. This ADR codifies the convention + an audit checklist so
existing slots can be lined up and future slots fall out automatically.

---

## TL;DR

1. **Every harness-backed adopter slot accepts an `Instance | Config`
   union, structurally discriminated.** "Instance" is a pre-built
   harness; "Config" is an object literal describing what the parent
   should build (and any per-connection / per-call extras).

2. **An optional THIRD union case — a "primary declaration" shorthand
   `readonly Decl[]`** — applies when the harness has one obvious
   dominant collection (prompts → `PromptDeclaration[]`,
   skills → `SkillDeclaration[]`). Not every harness has it
   (tools has registry + resolveHandler — no single array). When it
   does apply, it's the most adopter-friendly form and should be
   advertised first in docs.

3. **"Harness" is framework vocabulary.** Adopter-visible types use a
   noun alias: `Prompts = PromptsHarnessProtocol`,
   `Tools = ToolExecutorProtocol`, `Skills = SkillsHarnessProtocol`,
   etc. The slot, the read getter, the escape-hatch field — none of
   them carry "Harness".

4. **Escape-hatch field name is `use`.** When a Config carries a
   pre-built instance instead of declarations, the field is `use:`
   ("use this prompts source"). Never `harness`, `instance`, `source`,
   `from`. One word, reads naturally in adopter code.

5. **Per-connection visibility filter field name is `filter`.** Single
   noun, signature `(decl, ctx) => boolean`. Symmetric for tools,
   prompts, resources, etc.

6. **Lifecycle ownership follows construction.** If the parent built
   the instance (from declarations / loaders / config), the parent
   closes it during `parent.close()`. If the adopter supplied the
   instance (via top-level shorthand or `use:`), the parent never
   touches its lifecycle — adopter retains ownership.

7. **Resolved instance exposed via `parent.<slotName>: Instance | null`.**
   One read surface for runtime mutation (register/update/remove)
   regardless of which construction form the adopter chose.

8. **The Config shape is harness-specific** — no one-size-fits-all
   generic type. Prompts has `{ declarations?, use?, filter? }`; tools
   has `{ registry, resolveHandler, filter?, transforms? }`; skills has
   `{ loaders, ... }`. The CONVENTION codifies naming + structure; the
   per-harness Config type composes the fields that fit.

---

## Context

### Why this comes up now

The 2026-06-29 reshape of the MCP server's `prompts` slot exposed the
problem in concrete form. The original shape was:

```ts
// BEFORE — leaks "harness" into adopter vocabulary
prompts: {
  harness: somePromptsHarness,
  filter: (decl, ctx) => ...,
}
```

That requires the adopter to:

1. Construct a `PromptsHarness` themselves (with substrate plumbing —
   `scopeId, journal, bus, inbox`).
2. Register prompts onto it.
3. Pass it through a wrapper object whose field name is framework
   vocabulary.

Each leak is independently fixable; together they made the slot feel
ceremonial. The fix collapsed all three to:

```ts
// AFTER — declarative shorthand, no "harness" anywhere
prompts: [
  { name: "summarize", description: "...", render: ({ text }) => [...] },
]
```

…with two longer forms (`Instance` shorthand + `Config` object) as
fallbacks for the cases where the adopter genuinely needs more control.

### Why a generic type doesn't work

The first draft of this codification proposed a parameterized type:

```ts
type HarnessSlot<TDecl, TSource, TFilter> =
  | readonly TDecl[]
  | TSource
  | { declarations: readonly TDecl[]; filter?: TFilter }
  | { use: TSource; filter?: TFilter };
```

The pushback during review was correct: this type is too tight.

- **Some harnesses don't have a "primary declaration" array.** Tools
  carries a `registry` AND a `resolveHandler` (handlers live separately
  from the declarations because v2 keeps handler bodies out of the
  serializable surface). There's no single array shorthand.

- **Some harnesses have multiple collections.** A future
  `ResourcesHarness` will project resources keyed by URI, with
  separate file-loader and dynamic-template surfaces.

- **Some harnesses need extras beyond `filter`.** Tools has
  `transforms`; prompts may grow `loaders` later; sampling will need
  `defaults`.

Forcing every harness through the same parametric type would either
inflate the generic with optional fields nobody uses, or force the
common case (prompts) to look like the complex case (tools). Both fail.

The right codification is **a convention** — naming rules + structural
checklist — that each harness's bespoke Config type satisfies. The
pseudocode `Instance | Config` captures the shape; the rest is per-
harness ergonomic design under the convention.

---

## Decision

### 1. The trichotomy (pseudocode)

```ts
// The pattern at the spec level
type HarnessSlot<Instance, Config> = Instance | Config;

// When the harness has a single dominant declaration type, add a third case
type HarnessSlotWithShorthand<Instance, Config, Decl> =
  | Instance
  | Config
  | readonly Decl[];
```

Treat these as illustration only — DO NOT export a load-bearing generic
type with this name from spec. Each harness defines its own slot type
ad-hoc, satisfying the convention.

### 2. Naming rules (load-bearing)

| Concept | Rule | Example |
| --- | --- | --- |
| Public type for the harness | Noun. No "Harness", no "Protocol", no "Impl". | `Prompts`, `Tools`, `Skills`, `Tasks` |
| Slot name on parent options | Noun, plural if the harness manages a collection. | `prompts:`, `tools:`, `skills:`, `mcpServers:` |
| Pre-built escape-hatch field in Config | `use:` | `{ declarations: [...], use: existing, filter: ... }` — but never both |
| Per-connection visibility filter | `filter:` | `filter: (decl, ctx) => boolean` |
| Transforms (when applicable) | `transforms:` | `transforms: readonly Transform<Ctx>[]` |
| Runtime read getter on parent | `parent.<slotName>: Instance \| null` | `server.prompts`, `app.tools` |
| Type alias for adopter-facing protocols | `export type Prompts = PromptsHarnessProtocol;` | Lives in `spec-next/protocol/<surface>.ts` |

**Why these specific words?**

- **"Harness" is framework vocabulary.** Adopters reading the API
  shouldn't need the mental model of "harness as an addressable actor
  with substrate" to wire a prompt. They want to register a prompt;
  the framework owns the rest.
- **`use:`** beats `harness:` / `instance:` / `from:` because it
  describes intent ("use this prompts source") rather than mechanism.
  It's also one syllable and zero-collision-risk with any harness's
  primary declaration name.
- **`filter:`** is universally understood — every collection API in JS
  has a `.filter`. Adopter pattern-matches immediately.

### 3. Lifecycle ownership

```
Parent constructed the instance (from declarations/loaders/config-only)
  → parent.close() closes the instance
  → instance.id is namespaced under parent's scope, e.g. `${parent.id}:prompts`

Adopter supplied the instance (top-level Instance shorthand OR Config.use)
  → parent.close() does NOT touch the instance
  → adopter remains responsible for instance.close()
  → multiple parents may share one adopter-owned instance
```

This is the standard "you built it, you own it" pattern. The
trichotomy makes it explicit at the call site: writing
`prompts: somePrompts` or `prompts: { use: somePrompts }` is a visible
signal that the adopter is taking ownership.

### 4. Read surface

Every parent harness with a wired slot exposes:

```ts
readonly <slotName>: Instance | null;
```

Returns the resolved instance regardless of which form constructed it.
`null` only when the slot wasn't wired. Adopters use this for runtime
mutation:

```ts
await server.prompts!.register({ declaration: { ... } });
```

The protocol surface (e.g. `McpServerHarnessProtocol`) declares the
field; the concrete class exposes the resolved instance. Conformance
suites assert the field is present when the slot is wired.

### 5. Discrimination is structural

At the type-narrowing layer:

- `Array.isArray(option)` → shorthand declarations
- Has `register` (and other required Instance methods) → Instance form
- Otherwise (plain object) → Config form

Each parent harness ships a `resolve<Slot>Option(option)` helper that
normalizes any of the three shapes into a single internal `Resolved`
shape. The helper lives in the parent's `config.ts` and is also
exported for advanced adopters / testing.

### 6. The convention applies to `withX(...)` extensions too

`withX(XConfig | XInstance | XPrimary[]?)` is exactly the slot
trichotomy applied at the extension-factory level. `withPrompts` /
`withSkills` / `withTasks` / `withMCP` are all single-argument
factories whose argument is the union. Same naming rules, same
lifecycle, same audit checklist.

```ts
// All three accepted, structurally discriminated:
withPrompts([{ name: "summarize", ... }])               // shorthand
withPrompts(somePromptsInstance)                         // instance
withPrompts({ declarations: [...], filter: ..., ... })   // config
```

A `withX` factory MUST satisfy all seven checklist rows of §"Audit
checklist" with the same naming rules; the receiver of the union is
the factory itself rather than a parent's options field.

### 7. Sugar-only slots (boolean opt-out)

Some slots wire pure SUGAR — no harness-backed source, no instance,
no declarations, no registry. They route per-request through a
fixed transport (e.g. `mcp-next/server`'s `elicit:` flows through
`sdkServer.request("elicitation/create")` on every call; there is no
persistent server-side elicit instance to manage).

These slots DO NOT follow the trichotomy. They are boolean opt-OUT
slots — ON by default whenever the underlying transport is available;
adopters set `slot: false` only when they have a specific reason to
forbid the surface entirely. Shape:

```ts
slot?: boolean | { readonly enabled: boolean };
```

Rules:
- **Default to ON.** The real gate is downstream (in MCP elicit's
  case, the connected client's capability advertisement). An off-by-
  default flag would hide the API without preventing anything that
  isn't already prevented at the protocol layer.
- **Opt-OUT is explicit.** `slot: false` (or `{ enabled: false }`)
  disables the surface. Useful for audit / security postures with
  hard rules against server-initiated work.
- **Trichotomy rows that don't apply:** rows 1-3 (array shorthand,
  instance shorthand, `use:` escape) — there's no source to wrap.
- **Rows that still apply:** row 4 (`Noun` alias for whatever sugar
  the slot exposes — `Elicit` for elicit, etc.), row 5 (lifecycle
  docs — though there's no lifecycle to manage, the policy default
  must be documented), row 6 (read getter — but as a boolean policy
  flag like `server.elicitEnabled`, NOT a resolved instance), row 7
  (test coverage — the default behavior AND the opt-out path).

The MCP server's `elicit:` slot is the canonical example. Future
sugar-only slots (e.g. `sample:` when sampling lands) follow the same
shape.

### 8. Validation

- The Config form is rejected if it sets BOTH `declarations` and `use`
  (the two are mutually exclusive).
- The Config form is rejected if it sets NEITHER (one must be set).
- Wrong-typed `use:` (not an Instance-shaped object) is rejected
  structurally with a helpful error path.

Validation errors are typed (`McpServerConfigInvalid`, etc.) per
ADR 41 — never POJO `_tag`.

---

## Audit checklist

For any existing or new harness-backed slot, score the following.
**Each row is binary** — present or missing; partial credit is a sign
the slot needs revisiting.

1. ☐ **Array shorthand.** When the harness has a primary declaration
   type, the slot accepts `readonly Decl[]` as a top-level form
   (not just inside a Config object).
2. ☐ **Instance shorthand.** The slot accepts a pre-built instance
   directly (no wrapper object).
3. ☐ **Config form with `use:` escape hatch.** The Config form's
   pre-built-instance field is named `use:`. Not `harness:`, not
   `instance:`, not `source:`, not `from:`.
4. ☐ **Public Instance type alias.** A `<Noun>` type exists alongside
   `<Noun>HarnessProtocol`. The slot's signature references the
   alias, not the protocol.
5. ☐ **Lifecycle ownership documented.** Per-form ownership
   (parent-built vs adopter-supplied) is documented in the slot's
   doc-comment and the package README.
6. ☐ **Read getter on parent.** `parent.<slotName>: Instance | null`
   exposes the resolved instance for runtime mutation. The protocol
   surface declares it.
7. ☐ **Test coverage for all three forms.** The slot's spec exercises
   each of: shorthand-declarations, shorthand-instance, config-with-
   declarations, config-with-use, plus the two rejection paths
   (both-set / neither-set).

A passing slot has 7/7. Anything less ships a follow-up task per gap.

---

## Initial audit (2026-06-29 snapshot)

This is the first pass against existing slots. Items marked ⚠ are
the gaps that should generate follow-up tasks; items marked ✅ already
satisfy the convention.

### `@agentick/mcp/server` → `prompts` slot
- 1. Array shorthand: ✅ (lands with #171d.1b)
- 2. Instance shorthand: ✅
- 3. `use:` escape hatch: ✅
- 4. `Prompts` alias: ✅
- 5. Lifecycle docs: ✅
- 6. `server.prompts` getter: ✅
- 7. Test coverage: ✅

### `@agentick/mcp/server` → `tools` slot — landed via Slice 2 (#265)
- 1. Array shorthand: ✅ — `tools: CreatedTool[]` is the 90% case.
     The two-collection problem (declarations + handlers) is solved
     by `CreatedTool` carrying both: server splits `t.declaration`
     into the registry and `t.handlerRef → t.handler` into a
     default resolver.
- 2. Instance shorthand: ⚠ DEFERRED — a `Tools`
     (`ToolExecutorProtocol`) instance can't be plugged in without
     spec evolution: `ToolExecutor.dispatch` builds its OWN
     `ToolHandlerCtx` and would clobber the MCP-server
     `transport: "mcp"` + `mcp.*` discriminator fields. Lands when
     `DispatchInput.ctxOverride` ships. Adopters with an existing
     executor can project its registry today via the low-level
     `{registry, resolveHandler}` escape hatch.
- 3. `use:` escape hatch: ⚠ DEFERRED with item 2 (same blocker).
- 4. `Tools` alias: ✅ — `export type Tools = ToolExecutorProtocol`
     added to spec-next; `isToolsInstance` structural guard alongside.
- 5. Lifecycle docs: ✅ — config.ts JSDoc + README cover both
     authoring patterns; the low-level form documents adopter-owned
     handler lifetimes explicitly.
- 6. `server.tools` getter: ⚠ MISSING — pending the same spec
     evolution as item 2 (without a uniform `Tools` instance, there's
     no consistent runtime read shape).
- 7. Test coverage: ✅ — `tools-slot.spec.ts` covers both authoring
     patterns + the xor-discrimination boundary cases.

### `@agentick/skills` → `withSkills` — landed via Slice 3 (#266)
- 1. Array shorthand: ✅ — `withSkills([{ name, description, content }, ...])`
     is sugar for `{ initial: [...] }`. The earlier note about
     "loader-driven harnesses exempt from the shorthand" was
     superseded — `SkillsRegisterInput[]` is the natural declarative
     form; loaders remain available as a sibling option.
- 2. Instance shorthand: ✅ — `withSkills(mySkillsInstance)` collapses
     to `{ use: ... }`. Adopter owns lifecycle.
- 3. `use:` escape hatch: ✅ — `WithSkillsOptions.use: Skills`.
     Mutually exclusive with `initial`/`loaders`.
- 4. `Skills` alias: ✅ — `export type Skills = SkillsHarnessProtocol`
     + `isSkillsInstance` structural guard in spec-next.
- 5. Lifecycle docs: ✅ — README §"The withSkills slot — three
     accepted shapes" + extension.ts JSDoc cover Form A/B/C lifecycle
     ownership explicitly.
- 6. `session.skills` getter: still typed as `SkillsHarnessProtocol`
     via SessionHarnessProtocol augment — leaks "Harness". Renaming
     the augment slot type to `Skills` is a downstream cleanup
     (cross-cuts session-next augments; out of scope for this slice).
- 7. Test coverage: ✅ — `slot-trichotomy.spec.ts` (10 tests) +
     `loaders.spec.ts` end-to-end still green.

### `@agentick/prompts` → `withPrompts` — landed via Slice 3 (#266)
- 1. Array shorthand: ✅ — `withPrompts([{ declaration }, ...])` →
     `{ initial: [...] }`.
- 2. Instance shorthand: ✅ — `withPrompts(myPromptsInstance)` →
     `{ use: ... }`.
- 3. `use:` escape hatch: ✅. Mutually exclusive with
     `initial`/`loaders`/`renderers` (the adopter's instance brings
     its own renderer set).
- 4. `Prompts` alias: ✅ — already existed; `isPromptsInstance`
     structural guard added to spec-next (replaces the local copy in
     mcp/server/config.ts).
- 5. Lifecycle docs: ✅ — README §"The withPrompts slot — three
     accepted shapes" + extension.ts JSDoc.
- 6. `session.prompts` getter: same caveat as skills — leaks "Harness".
- 7. Test coverage: ✅ — `slot-trichotomy.spec.ts` (11 tests).

### `@agentick/tasks` → `withTasks` — alias-only, slot deferred (#266)
- 1-3. Trichotomy: ⚠ INTENTIONALLY EXEMPT — per ADR 42 §"What this
     ADR does NOT decide", the per-session `TasksHarness` is owned by
     the parent `AppHarness` via the single-construction-site pattern
     (#159), not by `withTasks`. The only slot today is
     `registerModelTools` (boolean opt-out for the auto-registered
     `session_tasks_*` tools). Documented in the package README.
- 4. `Tasks` alias: ✅ — `export type Tasks = TasksHarnessProtocol`
     + `isTasksInstance` structural guard in spec-next. The alias
     exists for downstream code that takes a `Tasks` reference
     directly (cross-harness wiring, custom bridges).
- 5. Lifecycle docs: ✅ — README §"About the trichotomy" calls out
     the exemption + reason.
- 6. `session.tasks` getter: present; types still leak "Harness"
     (same downstream cleanup as skills/prompts).
- 7. Test coverage: existing TasksHarness suite covers the
     instance contract; no slot-trichotomy tests since the slot
     doesn't apply.

### `@agentick/eval` → `app` slot
- Differs from harness slots — it accepts a factory thunk, not a
  harness instance. Out of scope for this ADR; the thunk form is
  documented in ADR 37.

### `@agentick/gateway` → `mcpServers` slot
- Already accepts an array of `McpServerOptions` — the shorthand form
  matches the convention. Each entry's INTERIOR (tools, prompts, ...)
  is what gets audited via the rows above.

---

## Migration plan

### Slice 1 — Codify (this ADR)
Lands the convention. No code changes; documentation only. Future
slices reference this ADR.

### Slice 2 — Refresh `Tools` alias + slot — ✅ LANDED (#265)
Added `export type Tools = ToolExecutorProtocol;` + `isToolsInstance`
to spec. Refactored the mcp-server `tools` slot to accept the array
shorthand (`CreatedTool[]`) plus a config object that supports either
inline `tools: CreatedTool[]` OR the low-level
`{ registry, resolveHandler }` escape hatch. Filter + transforms are
optional on both authoring patterns. Form B (`Tools` instance via
`use:`) and `server.tools` getter remain deferred — both blocked on
`DispatchInput.ctxOverride` spec evolution (the executor builds its
own `ToolHandlerCtx` and would clobber the MCP `transport`/`mcp.*`
discriminator fields). See audit row above + `tools-slot.spec.ts`.

### Slice 3 — Refresh `Skills` + `Prompts` + `Tasks` aliases + their parent slots — ✅ LANDED (#266)
spec-next exports `Skills` / `Tasks` adopter aliases (Prompts already
existed) + matching `isSkillsInstance` / `isPromptsInstance` /
`isTasksInstance` structural guards. Lifted `isPromptsInstance` out
of `mcp/server/config.ts` (was a local duplicate) — single canonical
guard now.

`withSkills` and `withPrompts` accept the trichotomy: array
shorthand → `{ initial }`; instance shorthand → `{ use }`;
config-object form with `use:` mutually exclusive against
`initial`/`loaders`/`renderers`. `resolveSlot` exported per package
for adopter inspection + test access. Per-package
`slot-trichotomy.spec.ts` suites (10 skills, 11 prompts) verify every
form + every xor-discrimination boundary.

`withTasks` is **intentionally exempt** from the trichotomy — the
per-session `TasksHarness` is owned by `AppHarness`
(single-construction-site #159); constructing another via this
extension would collide on the inbox address. README §"About the
trichotomy" calls out the exemption.

### Slice 4 — Update reusable conformance fixtures
Add a `runHarnessSlotConformance` helper to `spec-conformance-next`
that adopters can run against their own slots to verify the seven
checklist items pass. Becomes the executable form of this ADR. ETA: ~1 day.

### Slice 5 — Sweep adopter examples + READMEs
Every example in `example/`, every adopter-facing snippet in every
README, uses the new shapes (preferring the array shorthand where it
applies). ETA: ~1 day.

---

## What this ADR does NOT decide

- **The specific shape of any per-harness Config type.** That's
  per-harness ergonomic design under the convention. Some harnesses
  (tools) may need a custom Config shape that doesn't have a
  `declarations` field at all.
- **Whether to ship a shared `resolve*Option` helper module.** Each
  harness owns its own resolution today; if duplication grows, the
  helpers consolidate later.
- **What `withMcpServer` looks like.** The slot convention applies
  inside it; the extension's outer shape is ADR 32 + 40 territory.
- **Module-augmentation requirement on optionality.** ADR 27 settled
  that built-ins are optional at the protocol level. Augments that
  declare slots MUST mark them optional unless ALL workspace
  implementers honor them — discovered the hard way during #171d.1b
  when `prompts-next/augment.ts` declared `SessionHarnessProtocol.prompts`
  as required but `SessionHarness` didn't implement it. Augments are
  documented as "additive type info, optional unless universally
  implemented" in ADR 27 — this ADR cross-references that rule.

---

## See also

- ADR 26 — Harness API shape (the BaseHarness contract these slots
  ultimately compose)
- ADR 27 — Modular built-ins (built-ins are bundled, not privileged —
  applies to the augments referenced in §"What this ADR does NOT decide")
- ADR 40 — MCP server harness shape (first concrete application of
  this ADR's convention)
- ADR 41 — AgentickError class hierarchy (validation errors raised by
  `resolve*Option` helpers MUST be AgentickError subclasses, never
  POJO `_tag` unions)
- v2 STATUS.md decision-log entry 2026-06-29 (records #171d.1b as the
  motivating refactor)

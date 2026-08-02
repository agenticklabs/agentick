# ADR 94 — Sections are content: container decides role, position decides order

**Status:** accepted (design), implementation pending
**Decided:** 2026-08-01/02, workshop with Ryan (v2 of this ADR — the first
draft's "leading run folds to system" rule is superseded by the uniform
container rule below; that draft's adapter table, formatter ownership, and
deletions all survive)
**Supersedes:** the silent section-hoisting behavior of `buildMessages`;
`SectionEntry` as an IR kind; `SectionMetadata.priority`; the next.17
section-in-message silent drop

## The defect

The IR is position-faithful — "tree order is canonical," the compiler MUST
NOT reorder — but `buildMessages`
(`packages/model/src/canonical-projection.ts`) throws position away: it
filters EVERY `kind: "section"` entry, wherever it sits, into one leading
`role: "system"` message. A `<Section>` below `<Timeline />` is hoisted to
the top of the system prompt. Rendered JSX ≠ compiled model input, in the
one framework whose pitch is "the tree IS the context surface."

Two adjacent defects fall in the same stroke:

- a `<section>` nested in a `<message>` is SILENTLY DROPPED by the
  compiler (the next.17 limitation ernesto documents and routes around);
- `role: "event"` reaches adapters through an unchecked cast into a role
  union it is not a member of.

## The law

**A model call is system instructions + ordered messages. Nothing else
exists at the wire, so nothing else exists in the IR.**

> **Container decides role. Position decides order.**

1. **A section renders into its containing message's content — whatever
   the role.** `<System>` is not special: it is just the message whose
   content becomes the provider's system param. A `<Section>` inside
   `<User>` folds into that user message's text as the same structure it
   would produce anywhere. Want sections in your system prompt? Define
   them there — inside `<System>`. The next.17 silent drop becomes the
   load-bearing mechanism, fixed for every message role.

2. **A free-floating section IS a message** — the anonymous box rule
   (CSS): content appearing where its kind doesn't belong is wrapped in an
   anonymous container of the right kind. A bare `<Section>` at entry
   level compiles to an anonymous message with semantic role `"grounding"`
   at exactly its position, whose content is the same section structure as
   case 1. `{entries.map(...)}` with sections dropped between mapped
   messages yields grounding turns exactly where they were placed.

3. **There is no third case.** `SectionEntry` leaves the IR:
   `ContextEntry = MessageEntry` only. The IR is what the wire is — an
   ordered list of role-bearing messages.

4. **No implicit system prompt.** A tree with no `<System>` sends no
   system instructions. Leading `<System>` messages merge in order into
   the provider system param; a `<System>` at or after the first
   non-system message is a compile DIAGNOSTIC — "never mid-stream system"
   enforced at compile time, not by silent folding.

5. **Headline consequence, as a test:** a `<Section>` below `<Timeline />`
   is the LAST message the model receives.

## What SectionEntry carried, and where it goes

All three survive, one level down, all at content level:

- **Per-section cache boundaries** (#185): part-level `cache` hints inside
  the containing message — parts already carry them; the system message
  keeps one part per cache-hinted section.
- **Stable `id`** (provenance, recompile diffing): block/part metadata on
  the section's content within its message. `provenance.ts` reads origins
  from those parts instead of from top-level section entries.
- **Formatter lowering**: applied within message content, where the
  formatters already lower structure.

## Rendering: the formatter owns section text

`sectionText`'s hardcoded `# ${title}` is a formatter bypass. The section
lowering is written ONCE and used by both cases:

- **markdown (default):** `# Title` heading + blocks — today's output.
- **xml:** the section `title` becomes the TAG NAME (slug rule: lowercase,
  spaces/punctuation → underscore; `"Current User"` → `<current_user>`;
  untitled → `<section id="…">`). The XML formatter already preserves
  custom block tags and attrs; this is the same rule reaching sections.

## Semantic roles: one mapping seam, two tenants

`MessageRole` already carries agentick-semantic roles; mapping to provider
vocabulary is the executor's job — the fold gains the table the doc always
promised, and the `entry.role as …` cast dies:

| semantic role | Anthropic / Google         | OpenAI                     |
| ------------- | -------------------------- | -------------------------- |
| `grounding`   | `user`, content in wrapper | `developer`                |
| `event`       | `user`, content in wrapper | `user`, content in wrapper |

- The **wrapper** is the section lowering itself — the model sees
  structure, not an impersonated human turn. That is what keeps a
  grounding/event message distinguishable from conversational user input
  on providers with no role for it.
- **OpenAI `developer`** is that provider's sanctioned non-user
  instruction channel, legal mid-stream. Events stay user-wrapped
  everywhere: an event is a record, not an instruction.
- `<Grounding>` (compiler-react) is the explicit authoring surface for the
  role; a free-floating `<Section>` folds AS IF wrapped in it.
- The split is architectural: the CANONICAL fold applies wrappers and
  keeps semantic roles; each ADAPTER lowers semantic role → its provider
  vocabulary at its own boundary (wire constraints live at the wire). An
  unknown role at an adapter is a diagnostic, never a coercion.

## Deletions

- `SectionEntry` and `ContextEntry` as a union — `ContextSpec.entries` is
  `readonly MessageEntry[]`.
- `SectionMetadata.priority` — the reorder hint contradicts position
  fidelity. No alias.
- The unchecked `entry.role as LanguageModelMessage["role"]` cast.
- The next.17 "section in message is dropped" behavior — replaced by the
  fold, not worked around.

## Migration notes

- **The break, stated plainly:** `<Section>rules</Section><Timeline />`
  no longer produces a system prompt. The fix is mechanical — wrap in
  `<System>` — and the compile diagnostic for a bare leading section
  SHOULD say exactly that while the ecosystem migrates (a hint, not a
  compatibility shim).
- **ernesto:** identity sections already live inside `<System>` —
  unchanged bytes. `UserContext` / `ThreadContext` are free-floating
  between `<System>` and `<Timeline>` — they become grounding turns
  between system and history, which is what that tree visually claimed.
  `RagContext`'s hand-rolled `<User>` turn can become a plain mid-stream
  `<Section>` at leisure.

## Verified by (to be written with the implementation)

- Section inside `<System>` → system param content, markdown lowering
  byte-compatible with today's `sectionText` for the title+text case;
  cache-hinted sections keep per-part boundaries.
- Section inside `<User>` → that message's content, same structure.
- Free-floating section between two messages → grounding message at its
  position; below `<Timeline />` → the LAST message the executor
  receives (e2e).
- Adapter lowerings per table; `role: "event"` never cast.
- XML formatter title→tag slug rule; markdown unchanged.
- Bare-leading-section diagnostic names the `<System>` fix.
- Unfiltered grep: no `SectionEntry`, no `priority` references.

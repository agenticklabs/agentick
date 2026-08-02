# ADR 94 — Positional sections: JSX order is wire order

**Status:** accepted (design), implementation pending
**Decided:** 2026-08-01, workshop with Ryan
**Supersedes:** the silent section-hoisting behavior of `buildMessages`; `SectionMetadata.priority`

## The defect

The IR is position-faithful — `ContextEntry` is an ordered union of
`MessageEntry | SectionEntry`, "tree order is canonical," and the compiler
MUST NOT reorder. But `buildMessages`
(`packages/model/src/canonical-projection.ts`) throws that position away:
it filters EVERY `kind: "section"` entry — wherever it sits — into one
leading `role: "system"` message, then walks the stream again for message
entries. A `<Section>` placed below `<Timeline />` is hoisted to the top
of the system prompt. Rendered JSX ≠ compiled model input, positionally,
and the one framework whose pitch is "the tree IS the context surface"
silently reorders the tree.

Adopters already route around it: ernesto's `RagContext` grounds retrieved
material in a hand-rolled `<User>` turn precisely because a section cannot
sit next to the question that pulled it. The workaround is the missing
semantics.

## The law

**A model call is system instructions + ordered messages. Nothing else
exists at the wire.** Every IR entry therefore folds to one of those two,
and it folds AT ITS POSITION:

1. **The leading run.** Sections before the first `MessageEntry` fold into
   the system message — position-faithful (they are first) AND
   provider-canonical. Cache-hinted sections keep one part per section
   (#185 boundaries preserved); provenance keeps building origins from
   them.

2. **Mid-stream sections.** A section at or after the first `MessageEntry`
   compiles to a message AT ITS POSITION with the semantic role
   `"grounding"`. **Never mid-stream system** — Anthropic takes one system
   param, and a portability lie is worse than a wrapper.

3. **Headline consequence, as a test:** a `<Section>` below `<Timeline />`
   is the LAST message the model receives.

## Rendering: the formatter owns section text

`sectionText`'s hardcoded `# ${title}` is a formatter bypass. Section
rendering goes through the formatter harness like all other content:

- **markdown (default):** `# Title` heading + blocks, exactly today's
  output.
- **xml:** the section's `title` becomes the TAG NAME (slugified:
  `"Current User"` → `<current_user>…</current_user>`; untitled sections
  get `<section id="…">`). Not a novelty — the XML formatter already
  preserves custom block tags and attrs; this is the same rule applied to
  sections. One grammar, two lowerings, selected by the formatter the
  session already carries (`renderedWith` rides the entry as ever).

## Semantic roles: one mapping seam, two tenants

`MessageRole` already carries agentick-semantic roles (`"event"`), and the
spec has always said mapping to provider vocabulary is the executor's job —
but `buildMessages` CASTS `entry.role` into the provider union today, so
`role: "event"` reaches adapters as an unchecked lie. The fold gains the
mapping table the doc promised:

| semantic role | Anthropic / Google         | OpenAI                     |
| ------------- | -------------------------- | -------------------------- |
| `grounding`   | `user`, content in wrapper | `developer`                |
| `event`       | `user`, content in wrapper | `user`, content in wrapper |

- The **wrapper** is what keeps a grounding/event message distinguishable
  from conversational user input where the provider has no role for it: the
  formatter wraps the payload in its section lowering (markdown: a titled
  block; xml: the title-tag). The model sees structure, not an
  impersonated human turn.
- **OpenAI `developer`** is that provider's sanctioned non-user instruction
  channel and is legal mid-stream — grounding maps onto it instead of
  wearing a user costume. Events stay user-wrapped everywhere: an event is
  a record of something that happened, not an instruction.
- `<Grounding>` (compiler-react) becomes the authoring surface for the
  role, and a mid-stream `<Section>` folds AS IF wrapped in it.

## Deletions

- `SectionMetadata.priority` ("hint to executors that may reorder") — a v1
  relic that contradicts position fidelity. Removed, no alias.
- The unchecked `entry.role as LanguageModelMessage["role"]` cast — replaced
  by the mapping table; an unknown semantic role is a diagnostic, not a
  coercion.

## Migration notes

- **ernesto:** `UserContext` / `ThreadContext` sections sit after
  `<System>` and before `<Timeline>`; they become grounding turns between
  the system message and history instead of being hoisted into it. This is
  the standard grounding-turn pattern and matches what the tree visually
  says — an upgrade, but a byte-level change to the compiled context.
  `RagContext`'s hand-rolled `<User>` turn can migrate to a plain
  mid-stream `<Section>` (or `<Grounding>`) at leisure.
- Anything depending on hoisting (a section BELOW messages expected to land
  in system) must move the section above the first message — the tree now
  means what it says.

## Verified by (to be written with the implementation)

- Leading sections → system, byte-identical for the all-leading case
  (conservation pin for every existing adopter tree).
- Section below `<Timeline />` → last message, role `user` (Anthropic) /
  `developer` (OpenAI), wrapped.
- Cache-hinted leading sections keep per-part boundaries.
- `role: "event"` reaches every adapter as `user` + wrapper, never as a
  cast.
- XML formatter: title → tag name; markdown unchanged.

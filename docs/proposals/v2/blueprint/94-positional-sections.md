# ADR 94 — Sections are content: container decides role, position decides order

**Status:** accepted, IMPLEMENTED (2026-08-02)
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

   **The role prop is the escape hatch on the default.** A free-standing
   section's anonymous message is `grounding` because that is what
   non-conversational context is — but a section that IS a turn says so:
   `<Section role="user">` compiles to a plain user message whose content
   is still the section structure, and the role rides the same adapter
   lowering table as any other. On a section NESTED in a message the prop
   is a compile DIAGNOSTIC rather than a silent no-op: the container has
   already decided the role, and honouring it would mean breaking the
   section out of its parent — the hoisting this ADR removes. A
   silently-dropped prop reads as a bug in the framework instead of one in
   the tree.

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

**No tag-override prop.** The tag derives from `slug(title)` and nothing
else. The reason is that markdown renders the title's words as a heading
and XML renders the SAME words as a tag — one section, one name, two
dialects telling the same story. An independent `tag` prop would let the
two diverge, so a tree could read `# Current User` in markdown and
`<ctx7>` in XML and both would be "correct." Authors who need an exact tag
already have one: the custom-block mechanism, whose tag and attrs the XML
formatter preserves verbatim.

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

## Status: implemented, fully load-bearing

Landed on `feat/v2`. The first cut shipped one deliberate deviation —
the compile path applied the MARKDOWN lowering unconditionally, even
under an `<XML>` scope — marked in code as
`TODO(section-formatter-thread)`. That is now closed, and every claim
above is enforced.

The thread-through was not "resolve the live formatter during the collect
walk," which is what the deviation note guessed at. It was to stop
lowering during the walk at all. Collect emits the section's STRUCTURE as
a `sectionNode` sidecar — the same carrier shape `semanticNode` already
used for JSX semantic HTML, and for the same reason: a block that is not
text yet. The formatter pass lowers it, in the dialect that pass is
running, by rendering the section's BODY first and framing the result
afterwards. Body-then-frame is what makes the two escaping problems
disappear together: the tag never reaches the escaper and the body
reaches it exactly once.

Three consequences fell out of moving the lowering, all of them wanted:

- **A semantic-HTML section is ONE block.** Lowering used to run before
  the sidecar had any text in it, so a `<Section>` whose body was
  `<Paragraph>` produced a title block plus a separate body block. One
  lowering, one block.
- **`renderedWith` means what it says.** The ref was always stamped from
  `ctx.formatter("section")`; now it names the dialect that actually ran.
- **`formatTree` stopped re-running the block pass.** A `RenderedTree`
  has already been through its compiler's formatter pass, so formatting
  it again escaped what was escaped once already
  (`TODO(double-format-in-render-to-string)`, previously invisible
  because markdown is idempotent on plain text). With a section frame in
  the output it stopped being invisible, so it was fixed here.

## Addendum (2026-08-02) — the dialect law, and where the join lives

> **The container decides role and dialect; the nearest DECLARED scope
> overrides the dialect; position decides order.**

Three changes, one sentence.

**Dialect follows the same law as role.** The first cut said a section
nested in a message simply reads in the MESSAGE's dialect, full stop —
which made `<FormatScope purpose="section">` a knob that resolved a ref,
stamped it, and ignored it. The law above keeps the default (the
container's) and honours the override: `SectionNode` carries the ref
resolved at its own tree position, and the formatter pass compares it
against the dialect it is running. When they differ the section is an
ISLAND, lowered by its own formatter and framed by its own dialect's
rule. Free-standing sections are unaffected — their entry carries the
ref, exactly as before.

**Islands embed VERBATIM.** An island's bytes are spliced into the
containing message untouched; the outer formatter never runs over them.
The alternative — escaping an island in the outer transport when the
dialects differ — fails on the case the feature exists for. The
ubiquitous hand-written prompt is markdown prose with literal XML tag
blocks in it; escaping the island emits `&lt;current_user&gt;`, a
rendering OF an island rather than an island, produced precisely when an
author took the trouble to declare another dialect. The mirror argues the
same: a markdown island inside an XML message keeps its `#` and its raw
`&`. That `&` is not well-formed XML and it does not matter — prompt
"xml" is a convention no provider parses, and buying validity nobody
checks by corrupting an author's bytes is a bad trade. Well-formedness
across a dialect boundary is the author's concern, which is the whole
reason the boundary is something they declare. Capability, firmly: the
island is the mechanism, verbatim is the default, and there is no
conditional escaping to reason about.

**The adjacent-section merge is gone; the join moved to the wire.** The
lowering briefly merged two adjacent sections into one block so a
provider concatenating text parts could not weld `# B`'s heading onto
`# A`'s last line. That is a TRANSPORT fact, so the join belongs at
projection: `buildMessages` joins ADJACENT TEXT PARTS of one message with
`\n\n` and stops at any part carrying `cache` or provider knobs — a hint
IS a boundary, the #185 rule restated one level down. Nothing about the
defect was section-specific; one level down it also covers a text run
followed by a fenced code block, which the section-shaped rule never did.
It also agrees with the string exit by construction, since `blocksToText`
has always joined blocks with `\n\n`. Bytes for every existing section
tree are unchanged.

What comes back is per-section identity: two adjacent sections are two
blocks with two ids, end to end. The merged block could carry only ONE
id, so the second section's id reached nothing downstream — which is why
`prefix-stability.spec.tsx` had its fixture ordered around the merge, and
why that ordering is now gone.

**A design call DISSOLVED rather than being decided.** "Which id should a
merged block keep?" was open. Removing the mechanism removed the
question: no block is merged, so no block has to choose an id. The
projection's joined PART is named by the block it starts at, which is not
a choice between ids but a statement about where a part begins.

## Verified by

- `packages/compiler-react/src/__tests__/positional-sections.spec.tsx` —
  the law: conservation pins (semantic-HTML system byte-identical; a
  title+text section's markdown bytes identical to the old `sectionText`;
  two sections in one message rendering the way the old system blob
  joined them, now as two blocks the STRING exit joins — and each of them
  separately attributable, which the merge made impossible), section
  inside `<System>` / `<User>` / `<Assistant>`,
  cache-hinted section keeps its own block, free-floating section →
  grounding at its position, the `role` prop (default `grounding`,
  `role="user"` as a plain turn with the wrapper intact, a non-provider
  role carried for the adapter, `role="system"` answering the
  never-mid-stream rule), `<Grounding>` ≡ bare section, and all three
  diagnostics including `SECTION_ROLE_IN_MESSAGE` on a nested section.
  Plus the dialect thread-through: the title as an xml TAG, framed and
  escaped exactly once; a section inside `<System>` under `<XML>`; the
  heading marker dropped under `<PlainText>`; `renderedWith` naming the
  formatter that actually lowered the section; a semantic-HTML body
  collapsing into ONE block; and a nested section lowering in its
  parent's dialect. Plus the islands: an xml island inside a markdown
  `<System>` and a markdown island inside an xml one, both embedded
  verbatim with `&` escaped exactly once by the island's own dialect;
  same-dialect nesting unchanged; and `<FormatScope purpose="section">`
  taking effect on a nested section, which it never did before.
- `packages/app/src/__tests__/positional-sections-e2e.spec.tsx` — the
  headline consequence at the altitude an adopter sees it: a `<Section>`
  below `<Timeline />` is the LAST `LanguageModelMessage` the executor is
  handed, and the system prompt contains only what `<System>` contained.
- `packages/formatters/src/__tests__/section-lowering.spec.ts` — the one
  lowering: markdown bytes, the xml title→tag slug rule (including the
  leading-digit and no-surviving-characters cases), what rides the
  produced blocks, and no-silent-drop around non-text and
  semantic-sidecar blocks. And the carrier path: the body rendered before
  the frame is applied (tag unescaped, `&` escaped once), one carrier
  lowered two ways by two dialects, two adjacent sections staying two
  blocks with two ids while `blocksToText` puts the blank line between
  them, and a cache hint staying on its own block. And the island rules:
  both embedding directions with `&` in the body, same-dialect nesting,
  nested islands, an unserved ref falling back to the container, and no
  islands at all without a resolver.
- `packages/model/src/__tests__/semantic-roles.spec.ts` — the role seam:
  the fold narrows and keeps `grounding` / `event`, an unknown role
  throws instead of being cast, the three adapter tables, and system
  having no position while everything else keeps its own.
- `packages/model/src/__tests__/cache-hints.spec.ts` — a block-level
  cache hint reaches the projected part (#185, one level down). And the
  join at the wire: two sections producing the exact bytes the formatter
  merge produced, the refusal across a cache hint and across per-part
  provider knobs in either direction, a media part breaking the run, and
  a message with nothing to join coming back untouched.
- `packages/model/src/__tests__/provenance.spec.ts` — the provenance walk
  still mirrors the fold part-for-part, a system part now names the
  SECTION's stable id, two adjacent sections are each attributable once a
  boundary makes them two parts, and a joined part is named by the block
  it starts at.
- `packages/app/src/__tests__/prefix-stability.spec.tsx` — sections
  inside `<System>` keep the prompt-cache prefix byte-stable across
  renders and across mounts, with the fixture back in its natural order
  now that no merge swallows the auto-id section's id.

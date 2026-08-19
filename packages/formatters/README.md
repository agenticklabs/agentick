# @agentick/formatters

The IR → string pass. A formatter turns the compiler's semantic content blocks into wire-ready blocks for the model, and it owns the framing too — how a message is labelled, how a list of blocks becomes one string, and how a `<Section>` becomes text. That framing is the formatter's business, not the compiler's, which is why markdown emits `# Instructions` and XML emits `<instructions>` from the identical section.

Pure functions over plain data. This package depends on [@agentick/spec](../spec) for shapes and [@agentick/utils](../utils) for one helper — no substrate, no harness, no runtime.

## Install

```bash
npm install @agentick/formatters
```

Markdown is already wired as the default, so most adopters never install this directly — they install it to swap the default, register a custom formatter, or format an IR tree they are holding themselves.

## Quick start

Same tree, two formatters, two entirely different documents:

```ts
import { formatTree, markdownFormatter, xmlFormatter } from "@agentick/formatters";
import { SPEC_VERSION, type RenderedTree } from "@agentick/spec";

const tree: RenderedTree = {
  specVersion: SPEC_VERSION,
  context: {
    entries: [
      { kind: "message", role: "system", content: [{ type: "text", text: "Be terse." }] },
      { kind: "message", role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
  },
};

formatTree(tree, markdownFormatter);
// **system:** Be terse.
//
// **user:** Hello

formatTree(tree, xmlFormatter);
// <message role="system">
// Be terse.
// </message>
//
// <message role="user">
// Hello
// </message>
```

Nothing about the entries changed. The wrapping, the label, the separator — all of it came from the formatter.

## Sections

A `<Section>` never reaches `formatTree`, because a section is not an entry — it is content inside a message (ADR 94). The compiler emits the section's STRUCTURE as a `sectionNode` sidecar (`sectionBlock`); the formatter lowers it. Every formatter built with `createFormatter` does this before its own `render` runs, so the dialect in scope is the dialect the section reads in:

```ts
import { markdownFormatter, sectionBlock, xmlFormatter } from "@agentick/formatters";

const section = sectionBlock({
  id: "current-user",
  title: "Current User",
  content: [{ type: "text", text: "Ryan" }],
});

markdownFormatter([section]);
// [{ type: "text", text: "# Current User\nRyan", id: "current-user", … }]

xmlFormatter([section]);
// [{ type: "text", text: "<current_user>\nRyan\n</current_user>", … }]
```

Order matters and is the reason lowering waits for the formatter: the section's BODY is rendered first, then framed. An xml section therefore emits its tag around an already-escaped body — the tag never reaches the escaper (`<current_user>`, not `&lt;current_user&gt;`) and the body reaches it exactly once (`&amp;`, not `&amp;amp;`). Lowering during the compile walk could not have both.

`lowerSection(section, ref)` is the rule itself, exported for anyone assembling blocks by hand; `expandSections` is the pass that finds carriers and applies it.

Markdown makes the title a heading. XML makes it the **tag name**, via a slug rule: lowercase, every run of non-alphanumerics collapsed to one underscore, edges trimmed (`"Current User"` → `current_user`; a leading digit gets an underscore prefix so `"2 Factor Auth"` and `"Factor Auth"` stay distinct). An untitled section falls back to `<section id="…">`.

Text runs coalesce into ONE block, because one block is one projected message part and providers do not agree on how they join parts — a section decides its own internal layout rather than leaving it to whichever adapter runs. A non-text block breaks the run and passes through untouched. The section's `id` rides every block it produced; `cache` and `providerMetadata` ride the last one, which is the block a prompt-cache breakpoint should close over.

Two adjacent sections in one message stay TWO blocks, each carrying its own id. The blank line between them is not put in here — that a provider may concatenate a message's text parts with no separator of its own is a transport fact, so the join belongs at the exits: [@agentick/model](../model)'s `joinTextParts` joins adjacent text parts at projection, and `blocksToText` has always joined blocks with `\n\n` on the string path. Both exits stop at a part carrying `cache` or provider knobs — that hint IS the boundary. Nothing about the defect was ever section-specific, and applying the join one level down covers a text run followed by a fenced code block too, which the section-shaped rule never did.

### Islands — a section can declare its own dialect

`<FormatScope>` (and its `<XML>` / `<Markdown>` / `<PlainText>` sugar) around a section INSIDE a message makes that section an island: it is lowered by the formatter it named, framed by that dialect's rule, and its bytes are spliced into the containing message **verbatim** — the outer formatter never runs over them.

```tsx
<System>
  Follow the rules.
  <XML>
    <Section title="Current User">Ryan &amp; Bob</Section>
  </XML>
</System>
// → "Follow the rules.<current_user>\nRyan &amp; Bob\n</current_user>"
```

Verbatim is the decision, not an accident. Escaping the island in the container's transport would emit `&lt;current_user&gt;` — a rendering OF an island rather than an island, produced exactly when an author took the trouble to ask for another dialect. The mirror case argues the same way: a markdown island inside an XML message keeps its `#` and its raw `&`, and that `&` is not well-formed XML. It does not matter — prompt "xml" is a convention no provider parses, and buying validity nobody checks by corrupting an author's markdown is a bad trade. Well-formedness across a declared boundary is the author's call, which is why the boundary is something they declare.

A ref no registry serves is not an island; the container's dialect renders it, and the compiler harness reports the unresolved ref separately. A pinned formatter (`renderToString({ formatter })`) has no islands at all — pinning means one dialect renders everything.

## What a formatter owns

`createFormatter` takes one required callback and two optional ones. The required one is the block-level contract; the optional two are the framing rules.

| Callback       | Signature                                    | Owns                                        |
| -------------- | -------------------------------------------- | ------------------------------------------- |
| `render`       | `(SemanticContentBlock[]) => ContentBlock[]` | Block-level serialization. **Required.**    |
| `blocksToText` | `(ContentBlock[]) => string`                 | How your own output collapses to one string |
| `frameMessage` | `(MessageEntry, body: string) => string`     | The wrapper around a message's body         |

`render` is the pass that runs on the model-facing path: the compiler hands it the collected blocks — `TextBlock`s carrying optional `semanticNode` sidecars from JSX semantic HTML (`<strong>`, `<h1>`, `<ul>`, `<table>`) — and takes back wire-shape `ContentBlock[]`. `sectionNode` carriers are handled for you before `render` sees them. Media, tool-use, and tool-result blocks normally pass through untouched so the provider still receives them natively.

The other two only run when something asks for a string. `formatTree` reads them off the formatter; when a formatter omits one, it falls back to a markdown-flavored default.

> [!IMPORTANT]
> Supply all three, or none. A formatter that emits XML at the block level but inherits markdown's `## title` framing produces a document in two syntaxes — which is the exact failure the framing callbacks exist to prevent. All three bundled formatters supply all three.

## The bundled formatters

```ts
import { markdownFormatter, textFormatter, xmlFormatter } from "@agentick/formatters";
import type { SemanticContentBlock } from "@agentick/spec";

const blocks: readonly SemanticContentBlock[] = [
  {
    type: "text",
    text: "",
    semanticNode: {
      semantic: "paragraph",
      children: [{ text: "Use " }, { semantic: "strong", children: [{ text: "care" }] }],
    },
  },
  { type: "code", text: "rm -rf /", language: "bash" },
];

markdownFormatter(blocks);
// → "Use **care**\n\n"                    and the command inside a bash fence
xmlFormatter(blocks);
// → "<p>Use <strong>care</strong></p>"    and '<code language="bash">rm -rf /</code>'
textFormatter(blocks);
// → "Use care\n\n"                        and the bare command, unfenced
```

| Formatter           | `format`   | Semantic markup                                              | Framing                       |
| ------------------- | ---------- | ------------------------------------------------------------ | ----------------------------- |
| `markdownFormatter` | `markdown` | `**bold**`, `# heading`, `- item`, `[text](href)`, fences    | `## title` · `**role:** body` |
| `xmlFormatter`      | `xml`      | `<strong>`, `<h1>`, `<ul><li>`, `<a href>`, escaped text     | `<message role>`              |
| `textFormatter`     | `text`     | stripped — `text (href)` for links, `[image: src]` for media | `title\nbody` · `role: body`  |

All three cover the full semantic-node vocabulary the compiler can emit, including tables, blockquotes, and the generic structural (`block`) and inline (`inline`) containers. `markdownFormatter` is the default.

### `custom` — the same tag in every dialect

```ts
{ type: "custom", tag: "memory-kind", attrs: { kind: "episodic" }, content: "recall" }
// every formatter → '<memory-kind kind="episodic">recall</memory-kind>'
```

A custom block's whole purpose is "render this under my own tag", so **no dialect
drops it** — markdown included. Markdown used to, on the reasoning that it "has
no tag syntax"; that was never true (CommonMark specifies raw HTML blocks, and
this formatter already emits `<kbd>` and `<var>`), and while it held, the escape
hatch was unreachable in the only dialect most trees render with.

Attribute values are escaped in all dialects — a quote there would end the
attribute. Content is escaped in XML and left **verbatim** in markdown, where
escaping `<` would break every other construct.

`selfClosing: true` emits `<tag … />`. Nested custom nodes carry their
attributes too — the node and block paths share one `renderAttrs`, after a long
run of the two disagreeing (one fix aligned them on the tag and left the node
path silently dropping `attrs`).

### Application-defined tags — a hyphen makes it yours

You rarely write `{ type: "custom" }` by hand. In JSX, **any lowercase tag
containing a hyphen is an application-defined tag** — the web platform's
custom-elements rule, imported:

```tsx
<relevant-context source="rag" limit={3}>
  <about-user name="ryan">prefers terse answers</about-user>
</relevant-context>
```

typechecks with zero declaration and renders — in every dialect — as:

```
<relevant-context source="rag" limit="3">
  <about-user name="ryan">prefers terse answers</about-user>
</relevant-context>
```

The rules:

- **A hyphen makes it yours.** Hyphenated names can never collide with a
  framework intrinsic (which are single words, or registered explicitly), so
  your tags are forward-compatible by construction.
- **Single-word tags stay reserved.** `<about>` is a type error and an unknown
  single-word tag at runtime is transparent passthrough (its children pool
  upward, the tag contributes nothing) — this is what keeps `<mesage>` a
  compile error instead of a silent prompt bug.
- **Attrs are the primitive props, stringified.** `limit={3}` → `limit="3"`;
  object and function props are ignored.
- **Children render normally, then get wrapped.** Text, nested custom tags,
  and semantic HTML (`<strong>`, lists, headings) all keep their usual
  rendering inside the tag. Native content blocks (`<image>`, `<code>`) are
  the current boundary: they do not embed inside a custom tag's subtree —
  place them as siblings.

### Event blocks — structure in, text out

```ts
{ type: "system_event", event: "compaction", source: "timeline",
  data: { summary: "Discussed the store substrate.", entriesBefore: 42 } }
```

```xml
<system_event event="compaction" source="timeline">
<summary>Discussed the store substrate.</summary>
<entriesBefore>42</entriesBefore>
</system_event>
```

The three event blocks — `system_event`, `user_action`, `state_change` — carry
**structure**, and the durable timeline stores that structure rather than a
rendering of it. Identifying fields become attributes; the payload becomes child
elements. An event authored in JSX and the same event replayed from a store a
year later reach the model identically, because both go through this function.

`text`, when present, replaces the derived body; the attributes still render.
Use it to override a rendering, not to supply one — a hand-written `text` is a
rendering frozen into storage, and it stops tracking the formatter.

The text dialect uses no markup: `[system_event event=compaction]` followed by
`key: value` lines. Non-scalar values serialize as JSON in every dialect.

Writing your own formatter? `renderEventTag(block, escapers)` and
`renderEventPlain(block)` are exported — reuse them, or ignore them and lay the
same fields out your own way.

## Choosing a formatter per subtree

Selection is data. Every IR entry carries an optional `renderedWith: FormatterRef` — `{ id, format?, version? }` — and the compiler stamps it from the nearest formatter scope in the tree. [@agentick/compiler-react](../compiler-react) ships the scope providers:

```tsx
import { Markdown, Message, PlainText, Section, XML } from "@agentick/compiler-react";

export function Agent() {
  return (
    <>
      <XML>
        <Section id="instructions" title="Instructions">
          Answer with <strong>structured</strong> output.
        </Section>
        <Markdown>
          {/* A nested scope wins for its own descendants. */}
          <Section id="notes" title="Notes">
            Free-form prose is easier to read as markdown.
          </Section>
        </Markdown>
      </XML>
      <PlainText purpose="message">
        {/* Only messages go plain here — sections keep the ambient formatter. */}
        <Message role="user">No decoration at all.</Message>
      </PlainText>
    </>
  );
}
```

`<Markdown>`, `<XML>`, and `<PlainText>` are one-line wrappers over `<FormatScope>`, which is the primitive — reach for it directly with any ref, including one for a formatter you wrote:

```tsx
import { FormatScope, Section } from "@agentick/compiler-react";
import { refOf, xmlFormatter } from "@agentick/formatters";

export function Grounding() {
  return (
    <FormatScope formatter={refOf(xmlFormatter)}>
      <Section id="evidence">…</Section>
    </FormatScope>
  );
}
```

A scope contributes no IR of its own — it only rebinds the formatter for its descendants, and a nested scope wins over an outer one. The optional `purpose` prop narrows the rebinding to a single slot: a section entry resolves its formatter with purpose `"section"` and a message entry with `"message"`, so `purpose="message"` leaves sections on whatever the ambient default is. The full slot set is `"context"`, `"message"`, `"section"`, `"free-root"`, `"resource"`, `"output"`.

Resolution of a `FormatterRef` against the registry, in order:

1. exact `id` match,
2. otherwise the first registered formatter whose `format` matches the ref's `format`,
3. otherwise the configured default.

That second step is why `<Markdown>` works: its ref is `{ id: "markdown", format: "markdown" }`, which misses the bundled id `formatter.markdown` and lands on the format hint.

## Wiring the registry

`builtInFormatters()` is the reference set as a `ReadonlyMap` keyed by id. The compiler installs it by default; pass your own map to add a formatter or change the default:

```tsx
import { createApp } from "@agentick/app/react";
import { reactCompiler } from "@agentick/compiler-react";
import { builtInFormatters, xmlFormatter, type DefinedFormatter } from "@agentick/formatters";

declare const yamlFormatter: DefinedFormatter; // see "Writing your own", below

const formatters = new Map<string, DefinedFormatter>([
  ...builtInFormatters(),
  [yamlFormatter.__identity.id, yamlFormatter],
]);

const app = await createApp(<Agent />, {
  model,
  compiler: reactCompiler({
    formatters,
    defaultFormatterId: xmlFormatter.__identity.id, // what an unpinned entry gets
  }),
});
```

For a one-shot render with no session, `renderTemplate` takes the formatter directly:

```tsx
import { renderTemplate } from "@agentick/compiler-react";
import { xmlFormatter } from "@agentick/formatters";

const { output } = await renderTemplate(<Agent />, { formatter: xmlFormatter });
```

## Content reduction

Where markdown / XML / text change how blocks _serialize_, these change _which blocks survive_. Same `Formatter` signature, same registry, so they compose identically — a connector applies one to outbound assistant content so a chat surface shows prose instead of raw tool-call JSON.

```ts
import { createSummarizedFormatter, createToolSummarizer } from "@agentick/formatters";
import type { SemanticContentBlock } from "@agentick/spec";

const blocks: readonly SemanticContentBlock[] = [
  { type: "text", text: "Cleaning up." },
  { type: "tool_use", toolUseId: "t1", name: "bash", input: { command: "rm -rf ./tmp" } },
  {
    type: "tool_result",
    toolUseId: "t1",
    name: "bash",
    content: [{ type: "text", text: "…4kB of output…" }],
  },
];

// summarizedFormatter (the bundled default instance) collapses each tool_use
// into a line and drops the tool_result:
//   [{ type: "text", text: "Cleaning up." }, { type: "text", text: "[Ran: rm -rf ./tmp]" }]

// Override the phrasing per tool name; unknown tools keep the `[Used <name>]` fallback.
const formatter = createSummarizedFormatter(
  createToolSummarizer({
    bash: (input) => `[shell] ${String(input.command ?? "")}`,
    deploy: () => "[deploying]",
  }),
);
formatter(blocks);
```

`textOnlyFormatter` is the blunter policy: keep text and media, drop `tool_use` and `tool_result` entirely.

> [!NOTE]
> Neither reduction formatter supplies framing callbacks — they are content policies, not output syntaxes, so a string produced through one gets markdown-flavored framing. Neither is in `builtInFormatters()`; register them if you want to reach them by ref.

## Writing your own

One complete formatter, all four callbacks — a YAML-flavored output where framing is the whole point:

```ts
import { createFormatter, formatTree, type DefinedFormatter } from "@agentick/formatters";
import type { ContentBlock, RenderedTree, SemanticNode } from "@agentick/spec";

const indent = (s: string) => s.replace(/^/gm, "  ");
const flatten = (node: SemanticNode): string =>
  node.text ?? (node.children ?? []).map(flatten).join("");

export const yamlFormatter: DefinedFormatter = createFormatter({
  id: "formatter.yaml",
  format: "yaml",
  version: "1.0.0",

  // Block level. Collapse semantic trees to their text; leave every other
  // block alone so media and tool blocks still reach the provider natively.
  render: (blocks) =>
    blocks.map((block) =>
      block.semanticNode
        ? ({ type: "text", text: flatten(block.semanticNode) } satisfies ContentBlock)
        : block,
    ),

  // Flatten: how this formatter's own output becomes one string.
  blocksToText: (blocks) =>
    blocks
      .map((b) => ("text" in b && typeof b.text === "string" ? b.text : `[${b.type}]`))
      .filter((s) => s.length > 0)
      .join("\n"),

  // Framing: block-level syntax and framing must agree, so both live here.
  frameMessage: (entry, body) => `${entry.role}: |\n${indent(body)}`,
});

declare const tree: RenderedTree; // the same tree as the quick start
formatTree(tree, yamlFormatter);
// system: |
//   Be terse.
//
// user: |
//   Hello
```

`createFormatter` returns the render function itself, decorated with `__identity` (`{ id, format, version? }`) plus whichever framing callbacks you supplied — so a `DefinedFormatter` is callable, and `refOf(yamlFormatter)` gives you the ref to point a `<FormatScope>` at. The verb is `create`, not `define`, because a formatter needs no substrate to construct.

## Composing formatters

A formatter is a function, so middleware is function composition. No plumbing, no `aroundFormat` seam.

```ts
import { markdownFormatter } from "@agentick/formatters";
import type { ContentBlock, Formatter } from "@agentick/spec";

const memoize = (next: Formatter): Formatter => {
  const cache = new Map<string, readonly ContentBlock[]>();
  return (blocks) => {
    const key = JSON.stringify(blocks);
    const hit = cache.get(key);
    if (hit) return hit;
    const out = next(blocks);
    cache.set(key, out);
    return out;
  };
};

const cachedMarkdown = memoize(markdownFormatter);
```

Wrapping this way returns a bare `Formatter`, not a `DefinedFormatter` — to register the result, pass the wrapped function as `render` to `createFormatter` and give it its own id.

## API

| Export                                     | Kind     | Purpose                                                                              |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `createFormatter(input)`                   | function | Decorate a render function with identity + optional framing callbacks                |
| `refOf(formatter)`                         | function | The formatter's `FormatterRef`, for a scope provider or a registry key               |
| `formatTree(tree, default, opts?)`         | function | `RenderedTree` → string; `opts.formatters` enables per-entry resolution              |
| `resolveFormatterRef(fmts, ref, fallback)` | function | The one shared lookup: `{ formatter, match: "id" \| "format" \| "fallback" }`        |
| `describeUnresolvedFormatter(ref, used)`   | function | Human-readable line for a ref that resolved by fallback — diagnostics text           |
| `builtInFormatters()`                      | function | `ReadonlyMap` of the three reference formatters, keyed by id                         |
| `markdownFormatter`                        | value    | The default — markdown blocks and markdown framing                                   |
| `xmlFormatter`                             | value    | XML tags, escaped text, `<message>` framing                                          |
| `textFormatter`                            | value    | Semantic markup stripped; bare `title` / `role:` framing                             |
| `textOnlyFormatter`                        | value    | Content policy: keep text + media, drop tool blocks                                  |
| `summarizedFormatter`                      | value    | Content policy: `tool_use` → one line, `tool_result` dropped                         |
| `createSummarizedFormatter(fn?)`           | function | The same policy with a custom `ToolSummarizer`                                       |
| `createToolSummarizer(overrides?)`         | function | Build a summarizer: overrides → built-in defaults → `[Used <name>]`                  |
| `CreateFormatterInput`                     | type     | `id` · `format` · `version?` · `render` · `blocksToText?` · `frameMessage?`          |
| `DefinedFormatter`                         | type     | A callable `Formatter` carrying `__identity` and its framing callbacks               |
| `FormatTreeOptions`                        | type     | `{ formatters?: ReadonlyMap<string, DefinedFormatter> }`                             |
| `ToolSummarizer`                           | type     | `(name, input) => string`                                                            |
| `sectionBlock(section)`                    | function | Wrap a `SectionNode` in the carrier block the compile walk emits                     |
| `expandSections(blocks, render, ref)`      | function | Replace every carrier with its lowering in `ref`'s dialect; run by `createFormatter` |
| `lowerSection`                             | function | The one section → `ContentBlock[]` rule (markdown default, xml title→tag)            |
| `sectionTagName`                           | function | Section title → XML tag slug; `undefined` when nothing survives                      |
| `SECTION_STAMP`                            | value    | Block-metadata key marking which section a block came from                           |

`Formatter`, `FormatterRef`, `FormatterIdentity`, `FormatPurpose`, `SectionNode`, `SemanticContentBlock`, `SemanticNode`, `MessageEntry`, and `RenderedTree` are owned by [@agentick/spec](../spec).

## Patterns

**In the compile pipeline.** [@agentick/compiler-react](../compiler-react) runs `render` over every entry on each tick — so `renderedWith` decides what the model sees, not just what a string dump looks like, and it decides how a section reads — and delegates framing and flattening to `formatTree` from both `renderToString` and `renderTemplate`.

**Reaching a formatter from elsewhere.** Any holder of a `RenderedTree` can call `formatTree` — a tree that arrived over the wire, one from `compileTemplate`, a doc generator, a snapshot test. `formatTree` frames and flattens; it does NOT re-run the block pass, because a `RenderedTree` has already been through its compiler's formatter pass and running a formatter over its own output escapes twice.

**Content policy at a delivery edge.** [@agentick/connector](../connector) is where `textOnlyFormatter` / `summarizedFormatter` earn their keep: reduce, then chunk with `splitMessage` from [@agentick/utils](../utils), then deliver.

## Roadmap & known gaps

- **No streaming formatter.** The model streams; the formatter does not. A partial-block contract waits on a use case that needs it.
- **The scope sugar's refs resolve by format hint, not id.** `<Markdown>` emits `{ id: "markdown" }` while `markdownFormatter.__identity.id` is `formatter.markdown`, so those bindings resolve through the `format` hint — intended, tested, and silent. A registry that can serve NEITHER the id nor the format no longer silently lands on the default: the compiler harness reports a `formatter-unresolved` warning naming the requested id/format and the formatter that actually ran. `formatTree` itself still degrades quietly — it is a pure serializer with no diagnostics channel.
- **A formatter cannot vary its output by purpose.** `purpose` selects _which_ formatter a slot resolves to, but the `Formatter` signature takes only blocks — nothing reaches the formatter to tell it whether it is framing a message or a resource. A formatter that wants both behaviors ships as two registered formatters.
- **A section's dialect is decided by the nearest DECLARED scope; the default is the container's.** A free-standing section's dialect rides the entry it becomes; a nested one rides the section itself and produces an island when it differs from the message's. What remains a gap is granularity: the declaration is per-section, so there is no way to say "render this run of text in another dialect" without wrapping it in a `<Section>`.
- **`FormatterCapabilities` is unused.** The spec declares a capability shape for formatters; nothing advertises or reads it, so there is no negotiation.
- **`version` is carried, never checked.** `FormatterRef.version` rides through resolution untouched — id, then format, and that is the whole chain.
- **`blocksToText` has no golden-output suite.** The block-level `render` output of all three bundled formatters is pinned here; their framing and flatten callbacks are covered through the compiler's string tests rather than directly.
- **No conformance suite.** A third-party formatter has no `runFormatterConformance` to certify against; the bar is golden-output tests you write yourself.

## Verified by

- `src/__tests__/formatters.spec.ts` — `createFormatter` identity metadata including the optional `version`; `markdownFormatter` passing text through, fencing code, compact-stringifying JSON, `<strong>` → `**`, a nested semantic tree, heading levels, unordered lists, and native image blocks passing through; `xmlFormatter` tag wrapping, special-character escaping, `h1`–`h6`, `<ol>`, and `<code language>`; `textFormatter` stripping markup, flattening code to bare text, and rendering links as `text (href)`; and `builtInFormatters()` keying all three by their `__identity.id`.
- `src/__tests__/section-lowering.spec.ts` — the markdown bytes (pinned against the projection code this replaced), text-run coalescing into one block, the untitled and empty cases, the xml title→tag rule with its id fallback and attribute escaping, the slug rule including the leading-digit prefix and the nothing-survives `undefined`, what rides the produced blocks (`id` on all, `cache` / `providerMetadata` on the last), and no-silent-drop around a non-text block and a block still carrying a semantic sidecar. The carrier path too: body-rendered-before-framed (tag unescaped, `&` escaped once), one carrier lowered two ways by two dialects, a semantic-HTML body collapsing into the section's own block, two adjacent sections staying two blocks with two ids while `blocksToText` puts the blank line between them, a cache hint staying on its own block, and non-carrier blocks passing through `render` untouched. And the islands: an xml island in a markdown message and a markdown island in an xml message (both with a body containing `&`, both embedded verbatim), same-dialect nesting doing nothing, islands nesting, an unserved ref falling back to the container, and no islands at all without a resolver.
- `src/__tests__/content-policy.spec.ts` — `textOnlyFormatter` keeping text and media while dropping `tool_use` and `tool_result`; `summarizedFormatter` collapsing a `tool_use` into a summary line and dropping the result; the built-in summaries for known file and shell tools; the generic fallback for an unknown tool; and `createToolSummarizer` overrides winning.
- Per-subtree selection is pinned in [@agentick/compiler-react](../compiler-react): `formatter-scope.spec.tsx` — `<FormatScope>` contributing no IR fragment of its own, and `<Markdown>` / `<XML>` / `<PlainText>` each stamping `renderedWith` on descendant entries while an outer scope keeps its own.
- Registry resolution is pinned in [@agentick/compiler-react](../compiler-react): `formatter-registry.spec.tsx` — a custom formatter map taking effect, the missing-id → matching-`format` fallback, and markdown as the default when nothing is supplied.
- The string path is pinned in [@agentick/compiler-react](../compiler-react): `render-to-string.spec.tsx` — markdown section and message framing, blank-line joins between entries, XML tags and escaping from an in-scope XML formatter, a per-call formatter override beating `renderedWith`, and code / image / JSON block serialization; `template.spec.tsx` covers the same path through `renderTemplate`.

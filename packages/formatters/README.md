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

A `<Section>` never reaches `formatTree`, because a section is not an entry — it is content inside a message (ADR 94). `lowerSection` is where a section becomes blocks, and it is the one place that rule is written:

```ts
import { lowerSection } from "@agentick/formatters";

const section = {
  id: "current-user",
  title: "Current User",
  content: [{ type: "text", text: "Ryan" }],
};

lowerSection(section);
// [{ type: "text", text: "# Current User\nRyan", id: "current-user", … }]

lowerSection(section, { id: "formatter.xml", format: "xml" });
// [{ type: "text", text: "<current_user>\nRyan\n</current_user>", … }]
```

Markdown makes the title a heading. XML makes it the **tag name**, via a slug rule: lowercase, every run of non-alphanumerics collapsed to one underscore, edges trimmed (`"Current User"` → `current_user`; a leading digit gets an underscore prefix so `"2 Factor Auth"` and `"Factor Auth"` stay distinct). An untitled section falls back to `<section id="…">`.

Text runs coalesce into ONE block, because one block is one projected message part and providers do not agree on how they join parts — a section decides its own internal layout rather than leaving it to whichever adapter runs. A non-text block breaks the run and passes through untouched. The section's `id` rides every block it produced; `cache` and `providerMetadata` ride the last one, which is the block a prompt-cache breakpoint should close over.

**Known gap** — `TODO(section-formatter-thread)`: the compiler applies the markdown lowering unconditionally, even under an `<XML>` scope. The xml rule above works and is tested, but the compiler harness's formatter pass runs after the collect walk and would escape a frame produced during it, so choosing the dialect correctly needs the live formatter threaded into that walk.

## What a formatter owns

`createFormatter` takes one required callback and two optional ones. The required one is the block-level contract; the optional two are the framing rules.

| Callback       | Signature                                    | Owns                                        |
| -------------- | -------------------------------------------- | ------------------------------------------- |
| `render`       | `(SemanticContentBlock[]) => ContentBlock[]` | Block-level serialization. **Required.**    |
| `blocksToText` | `(ContentBlock[]) => string`                 | How your own output collapses to one string |
| `frameMessage` | `(MessageEntry, body: string) => string`     | The wrapper around a message's body         |

`render` is the pass that runs on the model-facing path: the compiler hands it the collected blocks — `TextBlock`s carrying optional `semanticNode` sidecars from JSX semantic HTML (`<strong>`, `<h1>`, `<ul>`, `<table>`) — and takes back wire-shape `ContentBlock[]`. Media, tool-use, and tool-result blocks normally pass through untouched so the provider still receives them natively.

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

| Export                                     | Kind     | Purpose                                                                                 |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------- |
| `createFormatter(input)`                   | function | Decorate a render function with identity + optional framing callbacks                   |
| `refOf(formatter)`                         | function | The formatter's `FormatterRef`, for a scope provider or a registry key                  |
| `formatTree(tree, default, opts?)`         | function | `RenderedTree` → string; `opts.formatters` enables per-entry resolution                 |
| `resolveFormatterRef(fmts, ref, fallback)` | function | The one shared lookup: `{ formatter, match: "id" \| "format" \| "fallback" }`           |
| `describeUnresolvedFormatter(ref, used)`   | function | Human-readable line for a ref that resolved by fallback — diagnostics text              |
| `builtInFormatters()`                      | function | `ReadonlyMap` of the three reference formatters, keyed by id                            |
| `markdownFormatter`                        | value    | The default — markdown blocks and markdown framing                                      |
| `xmlFormatter`                             | value    | XML tags, escaped text, `<message>` framing                                             |
| `textFormatter`                            | value    | Semantic markup stripped; bare `title` / `role:` framing                                |
| `textOnlyFormatter`                        | value    | Content policy: keep text + media, drop tool blocks                                     |
| `summarizedFormatter`                      | value    | Content policy: `tool_use` → one line, `tool_result` dropped                            |
| `createSummarizedFormatter(fn?)`           | function | The same policy with a custom `ToolSummarizer`                                          |
| `createToolSummarizer(overrides?)`         | function | Build a summarizer: overrides → built-in defaults → `[Used <name>]`                     |
| `CreateFormatterInput`                     | type     | `id` · `format` · `version?` · `render` · `blocksToText?` · `frameMessage?`             |
| `DefinedFormatter`                         | type     | A callable `Formatter` carrying `__identity` and its framing callbacks                  |
| `FormatTreeOptions`                        | type     | `{ formatters?: ReadonlyMap<string, DefinedFormatter> }`                                |
| `ToolSummarizer`                           | type     | `(name, input) => string`                                                               |
| `lowerSection`                             | function | The one section → `ContentBlock[]` rule (markdown default, xml title→tag)               |
| `sectionTagName`                           | function | Section title → XML tag slug; `undefined` when nothing survives                         |
| `SECTION_STAMP`                            | value    | Block-metadata key marking which section a block came from                              |
| `SectionSource`                            | type     | `lowerSection`'s argument: `id` · `title?` · `content` · `cache?` · `providerMetadata?` |

`Formatter`, `FormatterRef`, `FormatterIdentity`, `FormatPurpose`, `SemanticContentBlock`, `SemanticNode`, `MessageEntry`, and `RenderedTree` are owned by [@agentick/spec](../spec).

## Patterns

**In the compile pipeline.** [@agentick/compiler-react](../compiler-react) runs `render` over every entry on each tick — so `renderedWith` decides what the model sees, not just what a string dump looks like — and delegates the whole string path to `formatTree` from both `renderToString` and `renderTemplate`.

**Reaching a formatter from elsewhere.** Any holder of a `RenderedTree` can call `formatTree` — a tree that arrived over the wire, one from `compileTemplate`, a doc generator, a snapshot test.

**Content policy at a delivery edge.** [@agentick/connector](../connector) is where `textOnlyFormatter` / `summarizedFormatter` earn their keep: reduce, then chunk with `splitMessage` from [@agentick/utils](../utils), then deliver.

## Roadmap & known gaps

- **No streaming formatter.** The model streams; the formatter does not. A partial-block contract waits on a use case that needs it.
- **The scope sugar's refs resolve by format hint, not id.** `<Markdown>` emits `{ id: "markdown" }` while `markdownFormatter.__identity.id` is `formatter.markdown`, so those bindings resolve through the `format` hint — intended, tested, and silent. A registry that can serve NEITHER the id nor the format no longer silently lands on the default: the compiler harness reports a `formatter-unresolved` warning naming the requested id/format and the formatter that actually ran. `formatTree` itself still degrades quietly — it is a pure serializer with no diagnostics channel.
- **A formatter cannot vary its output by purpose.** `purpose` selects _which_ formatter a slot resolves to, but the `Formatter` signature takes only blocks — nothing reaches the formatter to tell it whether it is framing a message or a resource. A formatter that wants both behaviors ships as two registered formatters.
- **`lowerSection` is not reached by the compiler with a dialect** (`TODO(section-formatter-thread)`). The compile path always applies markdown, so a tree under `<XML>` gets `# Title` rather than `<title>`. The xml rule is implemented and tested here; wiring it needs the live formatter resolved during the collect walk, because the harness formatter pass runs after collect and would escape a frame emitted during it.
- **`FormatterCapabilities` is unused.** The spec declares a capability shape for formatters; nothing advertises or reads it, so there is no negotiation.
- **`version` is carried, never checked.** `FormatterRef.version` rides through resolution untouched — id, then format, and that is the whole chain.
- **`blocksToText` has no golden-output suite.** The block-level `render` output of all three bundled formatters is pinned here; their framing and flatten callbacks are covered through the compiler's string tests rather than directly.
- **No conformance suite.** A third-party formatter has no `runFormatterConformance` to certify against; the bar is golden-output tests you write yourself.

## Verified by

- `src/__tests__/formatters.spec.ts` — `createFormatter` identity metadata including the optional `version`; `markdownFormatter` passing text through, fencing code, compact-stringifying JSON, `<strong>` → `**`, a nested semantic tree, heading levels, unordered lists, and native image blocks passing through; `xmlFormatter` tag wrapping, special-character escaping, `h1`–`h6`, `<ol>`, and `<code language>`; `textFormatter` stripping markup, flattening code to bare text, and rendering links as `text (href)`; and `builtInFormatters()` keying all three by their `__identity.id`.
- `src/__tests__/section-lowering.spec.ts` — the markdown bytes (pinned against the projection code this replaced), text-run coalescing into one block, the untitled and empty cases, the xml title→tag rule with its id fallback and attribute escaping, the slug rule including the leading-digit prefix and the nothing-survives `undefined`, what rides the produced blocks (`id` on all, `cache` / `providerMetadata` on the last), and no-silent-drop around a non-text block and a block still carrying a semantic sidecar.
- `src/__tests__/content-policy.spec.ts` — `textOnlyFormatter` keeping text and media while dropping `tool_use` and `tool_result`; `summarizedFormatter` collapsing a `tool_use` into a summary line and dropping the result; the built-in summaries for known file and shell tools; the generic fallback for an unknown tool; and `createToolSummarizer` overrides winning.
- Per-subtree selection is pinned in [@agentick/compiler-react](../compiler-react): `formatter-scope.spec.tsx` — `<FormatScope>` contributing no IR fragment of its own, and `<Markdown>` / `<XML>` / `<PlainText>` each stamping `renderedWith` on descendant entries while an outer scope keeps its own.
- Registry resolution is pinned in [@agentick/compiler-react](../compiler-react): `formatter-registry.spec.tsx` — a custom formatter map taking effect, the missing-id → matching-`format` fallback, and markdown as the default when nothing is supplied.
- The string path is pinned in [@agentick/compiler-react](../compiler-react): `render-to-string.spec.tsx` — markdown section and message framing, blank-line joins between entries, XML tags and escaping from an in-scope XML formatter, a per-call formatter override beating `renderedWith`, and code / image / JSON block serialization; `template.spec.tsx` covers the same path through `renderTemplate`.

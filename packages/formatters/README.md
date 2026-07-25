# @agentick/formatters

Pure-function content formatters for Agentick v2. Ships the
`createFormatter` builder plus markdown / xml / text reference
formatters. The compiler harness dispatches by `FormatterRef` to
turn semantic content into wire-ready prompts for the model.

**Spec firewall:** This package depends only on `@agentick/spec`. No
substrate, no runtime, no harness machinery.

**Design:** [ADR 22](../../docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md) ·
[Blueprint §04](../../docs/proposals/v2/blueprint/04-formatters.md)

## Quick start

```ts
import { createApp } from "@agentick/app";
import { openai } from "@agentick/model-openai";

// Markdown is the default — no formatter wiring needed.
const app = await createApp(<Agent />, {
  model: openai("gpt-5"),
});
```

To pick a different default:

```ts
import { xmlFormatter, builtInFormatters } from "@agentick/formatters";

const app = await createApp(<Agent />, {
  model: openai("gpt-5"),
  compiler: {
    formatters: builtInFormatters(),
    defaultFormatterId: xmlFormatter.__identity.id,
  },
});
```

To switch formatters inside the JSX tree:

```tsx
import { Markdown, XML, PlainText } from "@agentick/compiler-react";

<Agent>
  <XML>
    <section id="instructions">
      Use <strong>structured</strong> output.
    </section>
  </XML>
  <Markdown>
    <message role="user">Hello, world!</message>
  </Markdown>
</Agent>;
```

## API

### `Formatter`

```ts
type Formatter = (blocks: readonly SemanticContentBlock[]) => readonly ContentBlock[];
```

Pure function. Input may carry `semanticNode` sidecars on `TextBlock`s
(from JSX semantic HTML — `<strong>`, `<h1>`, `<ul>`, etc.). Output is
wire-shape `ContentBlock[]` ready for the executor's projection to
provider format.

Imported from `@agentick/spec`.

### `createFormatter(spec)`

Decorate a render function with identity metadata so the compiler's
registry can dispatch by `FormatterRef`. Per [ADR
36](../../docs/proposals/v2/blueprint/36-define-vs-create-convention.md):
formatters need no parent-substrate to construct, so the verb is
`create`, not `define`.

```ts
import { createFormatter } from "@agentick/formatters";

const upperCaseFormatter = createFormatter({
  id: "demo.uppercase",
  format: "markdown",
  version: "1.0.0",
  render: (blocks) =>
    blocks.map((b) => (b.type === "text" ? { ...b, text: b.text.toUpperCase() } : b)),
});
```

The returned `DefinedFormatter` has a non-enumerable `__identity`
property carrying `{ id, format, version? }`. (The return-type name
`DefinedFormatter` stays — ADR 36 covers function names, not type names.)

#### Tree-level serialization (optional)

Beyond the block-level `render` callback, a formatter can OWN its
own serialization of a full `RenderedTree` to a string by supplying
three additional callbacks:

```ts
createFormatter({
  id: "demo.yaml",
  format: "yaml",
  render: (blocks) => blocks.map(/* block-level pass */),

  // How a SectionEntry's formatted body becomes a string
  frameSection: (entry, body) => `${entry.title ?? entry.id}:\n  ${body.replace(/\n/g, "\n  ")}`,

  // How a MessageEntry's formatted body becomes a string
  frameMessage: (entry, body) => `${entry.role}: |\n  ${body.replace(/\n/g, "\n  ")}`,

  // How the formatter's ContentBlock[] output becomes a single string
  blocksToText: (blocks) =>
    blocks.map((b) => ("text" in b ? (b.text ?? "") : `[${b.type}]`)).join("\n"),
});
```

`formatTree` (below) reads these methods. The three built-in
formatters (`markdownFormatter`, `xmlFormatter`, `textFormatter`)
all supply them. 3rd-party formatters that omit them fall back to
markdown-flavored defaults in `formatTree`. **Custom formatters
SHOULD supply all three** to get full control over their output
shape; otherwise the framing your callers see won't match the
syntax you produced at the block level.

### `markdownFormatter` · `xmlFormatter` · `textFormatter`

Reference formatters. Each is itself the result of a `createFormatter`
call.

| Formatter           | Semantic input                                                                           | Output style |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| `markdownFormatter` | `<strong>` → `**...**`, `<h1>` → `# ...`, `<ul>`/`<li>` → `- ...`, `<a>` → `[...](href)` | Markdown     |
| `xmlFormatter`      | `<strong>` → `<strong>...</strong>`, `<h1>` → `<h1>...</h1>`, etc.                       | XML tags     |
| `textFormatter`     | Strips all semantic markup                                                               | Plain text   |

Each handles the full `SemanticType` set defined in
`@agentick/spec/data/semantic.ts`.

### `builtInFormatters()`

Returns a `ReadonlyMap<string, DefinedFormatter>` pre-loaded with the
three reference formatters, keyed by `__identity.id` (`formatter.markdown`,
`formatter.xml`, `formatter.text`). Pass it into
`CompilerHarnessOptions.formatters` to enable the reference set; the
compiler does this by default.

### `refOf(formatter)`

Extract the `FormatterRef` from a `DefinedFormatter`.

```ts
const ref = refOf(markdownFormatter);
// → { id: "formatter.markdown", format: "markdown" }
```

### `formatTree(tree, defaultFormatter, opts?)`

Tree-level IR → final string. The single entry point for "I have a
`RenderedTree`, give me the formatted output." Used by:

- `CompilerHarness.renderToString` (full reactive harness path)
- `renderTemplate` in `@agentick/compiler-react` (one-shot
  static template path)
- adopters who hold the IR (e.g., from `compileTemplate` or from a
  `RenderedTree` shipped over the wire) and want the string

```ts
import {
  formatTree,
  markdownFormatter,
  xmlFormatter,
  builtInFormatters,
} from "@agentick/formatters";

// Simple — single formatter for everything; ignores entry.renderedWith.
const md = formatTree(tree, markdownFormatter);

// Per-entry resolution — honors `entry.renderedWith` set by
// in-template `<format>` scope providers. Each entry resolved
// against the map by id, then by format hint; defaultFormatter
// applies when no match.
const out = formatTree(tree, markdownFormatter, {
  formatters: builtInFormatters(),
});
```

The function delegates ALL serialization work to the formatter:

1. **Block-level pass**: `formatter(entry.content)` — the existing
   `Formatter` contract (`SemanticContentBlock[] → ContentBlock[]`).
2. **Block-to-text flatten**: `formatter.blocksToText(blocks)` — the
   formatter's own block-to-string rules.
3. **Section / message framing**: `formatter.frameSection(entry, body)`
   / `formatter.frameMessage(entry, body)`.

When a formatter omits any of those tree-level methods, `formatTree`
falls back to markdown-flavored defaults. 3rd-party formatters that
want full output control supply all three.

## Patterns

### Composing formatters (middleware via functions)

No harness, no `aroundFormat` plumbing — plain function composition:

```ts
type FormatterMiddleware = (next: Formatter) => Formatter;

const withCache: FormatterMiddleware = (next) => {
  const cache = new Map<string, readonly ContentBlock[]>();
  return (blocks) => {
    const key = JSON.stringify(blocks);
    return cache.get(key) ?? cache.set(key, next(blocks)).get(key)!;
  };
};

const cachedMarkdown = withCache(markdownFormatter);
```

### Provider-specific formatter

```ts
import { markdownFormatter } from "@agentick/formatters";

export const anthropicCacheFormatter = createFormatter({
  id: "formatter.anthropic-cache",
  format: "markdown",
  render: (blocks) => {
    const out: ContentBlock[] = [];
    for (const block of blocks) {
      out.push(...markdownFormatter([block]));
      // Insert cache-control markers between blocks
      out.push({ type: "text", text: "<!-- @anthropic-cache -->" });
    }
    return out;
  },
});
```

## What's not here

- **Streaming formatters.** The model streams; the formatter doesn't.
  Defer until a real use case demands it.
- **`renderToText` / `renderResource` / `inspectCapabilities` commands.**
  Dropped — these were `FormatterHarnessProtocol` methods with no
  consumers. `renderToText` is just `textFormatter`.
- **Per-format conformance suite.** Replaced by golden-output tests on
  each formatter. See `src/__tests__/formatters.spec.ts`.

## See also

- [`@agentick/spec`](../spec) — `Formatter`, `SemanticContentBlock`,
  `FormatterRef`, `SemanticNode` types.
- [`@agentick/compiler-react`](../compiler-react) — the compiler
  that dispatches formatters during its fold pass.
- [Blueprint §04 — Formatters](../../docs/proposals/v2/blueprint/04-formatters.md)

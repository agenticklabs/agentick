# @agentick/formatters-next

Pure-function content formatters for Agentick v2. Ships the
`createFormatter` builder plus markdown / xml / text reference
formatters. The reconciler harness dispatches by `FormatterRef` to
turn semantic content into wire-ready prompts for the model.

**Spec firewall:** This package depends only on `@agentick/spec-next`. No
substrate, no runtime, no harness machinery.

**Design:** [ADR 22](../../docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md) ·
[Blueprint §04](../../docs/proposals/v2/blueprint/04-formatters.md)

## Quick start

```ts
import { createApp } from "@agentick/app-next";
import { openai } from "@agentick/executor-openai-next";

// Markdown is the default — no formatter wiring needed.
const app = createApp(<Agent />, {
  model: openai("gpt-5"),
});
```

To pick a different default:

```ts
import { xmlFormatter, builtInFormatters } from "@agentick/formatters-next";

const app = createApp(<Agent />, {
  model: openai("gpt-5"),
  reconciler: {
    formatters: builtInFormatters(),
    defaultFormatterId: xmlFormatter.__identity.id,
  },
});
```

To switch formatters inside the JSX tree:

```tsx
import { Markdown, XML, PlainText } from "@agentick/reconciler-react-next";

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

Imported from `@agentick/spec-next`.

### `createFormatter(spec)`

Decorate a render function with identity metadata so the reconciler's
registry can dispatch by `FormatterRef`. Per [ADR
36](../../docs/proposals/v2/blueprint/36-define-vs-create-convention.md):
formatters need no parent-substrate to construct, so the verb is
`create`, not `define`.

```ts
import { createFormatter } from "@agentick/formatters-next";

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

### `markdownFormatter` · `xmlFormatter` · `textFormatter`

Reference formatters. Each is itself the result of a `createFormatter`
call.

| Formatter           | Semantic input                                                                           | Output style |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| `markdownFormatter` | `<strong>` → `**...**`, `<h1>` → `# ...`, `<ul>`/`<li>` → `- ...`, `<a>` → `[...](href)` | Markdown     |
| `xmlFormatter`      | `<strong>` → `<strong>...</strong>`, `<h1>` → `<h1>...</h1>`, etc.                       | XML tags     |
| `textFormatter`     | Strips all semantic markup                                                               | Plain text   |

Each handles the full `SemanticType` set defined in
`@agentick/spec-next/data/semantic.ts`.

### `builtInFormatters()`

Returns a `ReadonlyMap<string, DefinedFormatter>` pre-loaded with the
three reference formatters, keyed by `__identity.id` (`formatter.markdown`,
`formatter.xml`, `formatter.text`). Pass it into
`ReconcilerHarnessOptions.formatters` to enable the reference set; the
reconciler does this by default.

### `refOf(formatter)`

Extract the `FormatterRef` from a `DefinedFormatter`.

```ts
const ref = refOf(markdownFormatter);
// → { id: "formatter.markdown", format: "markdown" }
```

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
import { markdownFormatter } from "@agentick/formatters-next";

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

- [`@agentick/spec-next`](../spec) — `Formatter`, `SemanticContentBlock`,
  `FormatterRef`, `SemanticNode` types.
- [`@agentick/reconciler-react-next`](../reconciler-react) — the reconciler
  that dispatches formatters during its fold pass.
- [Blueprint §04 — Formatters](../../docs/proposals/v2/blueprint/04-formatters.md)

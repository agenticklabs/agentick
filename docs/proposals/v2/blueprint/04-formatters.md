# 04 — Formatters

**Status:** Accepted — 2026-05-19. Supersedes the original
`04-formatter-harness.md` after [ADR 22](./22-state-formatters-reconciler-shape.md).

Formatters turn semantic content (the `SemanticContentBlock[]` produced
by the reconciler's collect walker) into wire-ready `ContentBlock[]` for
the model. They are **pure functions**, not harnesses.

## Why functions, not a harness

The original blueprint specced a full `FormatterHarnessProtocol` with
commands, events, middleware, lifecycle hooks. ADR 22 walks that back.
Speaking in the voice of framework / API design experts who reviewed
the call:

> A formatter is a projection from one IR to another. Projections are
> pure functions. State-bearing services pretend to be projections,
> then leak. The model context boundary is structurally identical to
> a server-component → HTML projection — we ship that as a render
> function, not a class hierarchy. There is no future version of this
> transform that justifies the wrapper.

A formatter has **none** of the load-bearing properties that justify
the harness model in v2:

| Property | Justifies harness? | Formatter |
|---|---|---|
| Stateful between calls | yes | no — deterministic input → output |
| Lifecycle (mount/unmount) | yes | no |
| Substrate-bound (journal/bus/inbox) | yes | no — nothing to journal |
| Receives inbox messages from peers | yes | no |
| Streams progressive output | maybe | no — model needs complete prompt |
| Around-style middleware | yes | covered by function composition |

The wire-level audience is the LLM. The output is a complete prompt
the model consumes atomically. No streaming. No reactive updates. No
peer messaging. The harness wrapping was bureaucracy.

`[V1-INHERITED, VERBATIM]` — v1's `Formatter` shape in
`packages/core/src/renderers/base.ts` works as-is. v2 preserves it.

## Shape

```ts
// In @agentick/spec/data/formatter.ts
type Formatter = (
  blocks: readonly SemanticContentBlock[],
) => readonly ContentBlock[];

interface FormatterIdentity {
  readonly id: string;
  readonly format: "markdown" | "xml" | "text" | "json" | (string & {});
  readonly version?: string;
}

// In @agentick/spec/data/semantic.ts — the sidecar pattern
type SemanticContentBlock = ContentBlock & {
  readonly semanticNode?: SemanticNode;
};

interface SemanticNode {
  readonly text?: string;
  readonly semantic?: SemanticType;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly SemanticNode[];
  readonly rendererRef?: FormatterRef;  // nested formatter switching
}
```

The input is **`SemanticContentBlock[]`** — wire-shape `ContentBlock`s
with an optional `semanticNode` sidecar carrying structured prose. The
output is **`ContentBlock[]`** — wire-shape only, no sidecars, ready
for the executor's projection to provider format.

Behavior:

- **Sidecar present** → walk the `SemanticNode` tree, render to a
  format-specific string, emit a `TextBlock` with that string.
- **Sidecar absent** → pass through. `TextBlock { text: string }` from
  the model or from a tool flows verbatim; the formatter doesn't
  re-parse markdown the model already produced.
- **Format-specific framing of opaque content** — `CodeBlock` gets
  markdown fences in the markdown formatter, XML `<code>` tags in the
  xml formatter, bare text in the text formatter.
- **Native non-text blocks** (Image, Audio, Video, Document,
  ToolUse, ToolResult, etc.) pass through unchanged. The provider
  adapter handles their wire encoding.

## `defineFormatter`

Author entry point in `@agentick/formatters`:

```ts
const customFormatter = defineFormatter({
  id: "my.formatter",
  format: "markdown",
  version: "1.0.0",
  render: (blocks) => blocks.map(transformBlock),
});
```

Decorates the render function with `FormatterIdentity` so the
reconciler's registry can dispatch by `FormatterRef`.

## Where the formatter runs

Inside the reconciler harness's render pipeline, after the collect
walker produces a `RenderedTree` and **before** the tree is returned
to callers.

```
JSX
  ↓ react-reconciler
host tree
  ↓ collect walker
RenderedTree (intermediate — TextBlocks may have sidecars)
  ↓ formatter pass (per-entry, by entry.renderedWith)
RenderedTree (wire-shape — sidecars resolved to strings)
  ↓
session.timeline / executor / renderToString / wire
```

Adopters never see a `SemanticContentBlock` — sidecars live only
inside the reconciler's fold pipeline. Downstream consumers see
flat `ContentBlock[]` only.

## Where formatters live

```
@agentick/formatters
  defineFormatter
  refOf
  markdownFormatter          (default for the reconciler)
  xmlFormatter
  textFormatter
  builtInFormatters()        Map<id, Formatter>
```

One consolidated package. The original plan in `13-package-graph.md`
split this into `@agentick/formatter-markdown` / `-xml` / `-text` —
that split was reverted: each formatter is ~50–100 LOC, separately
exported, tree-shakeable. Three `package.json`s would be ceremony
without upside. Easy to split later if a real need emerges.

## Scope switching

`<XML>` / `<Markdown>` / `<PlainText>` JSX scope providers (in
`@agentick/reconciler-react/react/components/format-scope.tsx`) push a
new active formatter for their subtree. The reconciler walker tracks
the active formatter via the `HostScope` chain and stamps it on each
emitted entry as `MessageEntry.renderedWith` / `SectionEntry.renderedWith`.
The formatter pass dispatches by that ref.

Nested switching via `SemanticNode.rendererRef` lets a subtree inside
an otherwise-markdown run elect a different formatter. The formatter
walking the tree looks up the ref in the reconciler's registry and
recurses.

## Reconciler integration

```ts
new ReconcilerHarness(scopeId, journal, bus, inbox, {
  formatters: builtInFormatters(),         // optional, defaults to builtIn
  defaultFormatterId: "formatter.markdown", // optional, defaults to markdown
});
```

When an entry's `renderedWith` doesn't resolve:

1. Try exact id match on the registry.
2. Fall back to format match (any formatter whose
   `__identity.format === ref.format`).
3. Fall back to the configured `defaultFormatterId`.
4. Fall back to a structural no-op markdown formatter.

This means adopters can pass `FormatterRef { id: "xml", format: "xml" }`
without knowing the canonical id; the format-match arm catches it.

## Middleware via composition

The case for harness-style middleware (caching, golden capture,
logging) was the one real argument for keeping the harness wrapper.
Function composition handles it cleanly:

```ts
type FormatterMiddleware = (next: Formatter) => Formatter;

const withCache: FormatterMiddleware = (next) => {
  const cache = new Map<string, readonly ContentBlock[]>();
  return (blocks) => {
    const key = JSON.stringify(blocks);
    return cache.get(key) ?? cache.set(key, next(blocks)).get(key)!;
  };
};

const withGoldenCapture: FormatterMiddleware = (next) => (blocks) => {
  const result = next(blocks);
  if (process.env.GOLDEN) recordGolden(blocks, result);
  return result;
};

const fmt = compose(withCache, withGoldenCapture)(markdownFormatter);
```

15 lines. No spec change. No conformance suite. Adopters who want
middleware import `compose` from any FP utility library.

## Adopter recipes

### Custom formatter for a specific provider

```ts
// formatter-anthropic-cache.ts
export const anthropicCacheFormatter = defineFormatter({
  id: "formatter.anthropic-cache",
  format: "markdown",
  render: (blocks) => {
    const out: ContentBlock[] = [];
    for (const block of blocks) {
      out.push(...markdownFormatter([block]));
      // Insert Anthropic cache-control markers between blocks
      out.push(cacheBreakpointMarker());
    }
    return out;
  },
});
```

### Composing the default with overrides

```ts
const myFormatter: Formatter = (blocks) => {
  const intermediate = markdownFormatter(blocks);
  return intermediate.map((b) =>
    b.type === "text" ? { ...b, text: b.text.replaceAll("…", "...") } : b,
  );
};
```

### Plugging into an app

```ts
const app = createApp(<Agent />, {
  model: openai("gpt-5"),
  reconciler: {
    formatters: new Map([
      ["formatter.markdown", markdownFormatter],
      ["formatter.xml", xmlFormatter],
      ["my.custom", myFormatter],
    ]),
    defaultFormatterId: "my.custom",
  },
});
```

## Cross-references

- [ADR 22](./22-state-formatters-reconciler-shape.md) — the decision record.
- [03 — Reconciler Harness](./03-reconciler-harness.md) — the host of the formatter pass.
- [02 — Data Model](./02-data-model.md) — ContentBlock, SemanticNode, FormatterRef wire types.
- [13 — Package Graph](./13-package-graph.md) — `@agentick/formatters` package home.

## What's not here

- **`renderToText` / `renderResource` / `inspectCapabilities` commands.**
  Dropped with the harness. `renderToText` is just the text formatter.
  `renderResource` was over-specced — MCP resource bodies are content
  blocks; format them like anything else. `inspectCapabilities` had no
  caller — providers don't introspect formatter capabilities.
- **Streaming formatters.** Defer. The model streams; the formatter
  doesn't.
- **Per-renderer middleware events.** `formatter:format:requested` /
  `formatter:format:terminal` are gone. The renders are too fast and
  too pure to justify telemetry overhead per call. Middleware-driven
  observability if needed.

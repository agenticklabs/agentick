# 04 — Formatter Harness

**Status:** Synthesized
`[SOURCE: renderer-harness.md, compiler-harness.md, compiled-spec.md]`

The formatter harness turns structured Agentick content into concrete
representations: markdown, XML, plain text, JSON-like payloads, MCP resource
bodies. It is **first-class** in v2 — independent from React, runtime
execution, and provider projection.

```
                ┌──────────────────────────────────────┐
                │         Formatter harness             │
                │                                      │
   commands ──► │  render · renderToText               │ ──► events
                │  renderResource · inspectCapabilities│
   interceptors◄┤                                      │ ──► outcomes
                │      (renderer registry +            │
                │       per-renderer impls)            │
                └──────────────────────────────────────┘
```

## Why a separate harness

The renderer is meaningful enough to receive the full harness treatment
because:

1. It is used in **multiple contexts**: agent execution, MCP resource
   generation, prompt previews, tests, documentation generation, content
   transforms.
2. **Nested renderer providers** (`<Markdown>` inside `<XML>` inside
   `<Markdown>`) are real — they need protocol representation
   (`FormatScope`) and recursive evaluation.
3. **Renderer identity needs to cross the spec firewall as data**
   (`FormatterRef`), but rendering itself involves logic and capabilities
   (`FormatterCapabilities`). Splitting these along the harness boundary
   keeps the IR pure.
4. Rendering needs **interceptors** (golden-test substitution, format
   enforcement, capability checks) — events alone don't suffice.

`[V1-REPLACED]` of v1's `Renderer` abstract class
(`packages/core/src/renderers/base.ts`), which mixed:

- The semantic format function.
- The block-level formatter dispatch.
- Live formatter references inside compiled output.

v2 splits into:

- **Pure renderer logic** behind a harness with typed input/output.
- **Compile-time reduction** of renderer instances → `FormatterRef` before
  any compiled artifact crosses a boundary.
- **Runtime projection** (executors stringifying for providers) is a
  separate concern, not the renderer's job.

## What this harness manages

- A registry of `Formatter` implementations keyed by `FormatterRef.id`.
- Recursive rendering of nested `FormatScope` inputs.
- Capability inspection.
- Lifecycle hooks for tests and instrumentation.

It does NOT manage:

- React tree state (React harness).
- Provider/model projection (executor harness).
- Live `<Markdown>`/`<XML>` Context providers (those are React-side
  concerns; React reduces them to `FormatScope` before invoking the
  formatter harness).

## Commands in

```ts
interface FormatterHarnessProtocol {
  render(input: FormatInput):
    Effect<FormatResult, FormatError, RendererEnv>;

  renderToText(input: FormatInput):
    Effect<FormatResult, FormatError, RendererEnv>;

  renderResource(input: FormatInput):
    Effect<FormatResult, FormatError, RendererEnv>;

  inspectCapabilities(rendererRef?: FormatterRef):
    Effect<FormatterCapabilities, FormatError, RendererEnv>;
}
```

All use the `FormatInput`/`FormatResult` shapes from `02-data-model.md`.

### `render`

Generic content rendering. Takes `FormattableContent[]` plus a `purpose`
hint and returns `FormatResult`. The most common command, called by the
React harness during `renderTree` for each renderable scope.

### `renderToText`

`[PROPOSAL]` `[SOURCE: renderer-harness.md §Open Question 2]` — keep as a
distinct command. Reason: callers that explicitly want text output (logs,
prompt previews, terminal CLIs) shouldn't have to filter `FormatResult.text`
out of mixed structured content. Sign-off needed.

### `renderResource`

Render content scoped to a `ResourceDeclaration`. The result is a
self-contained resource body suitable for MCP `resources/read`.

### `inspectCapabilities`

Returns the merged capabilities of a renderer (or the default if no ref
given). Used at compile time to validate that a renderer can handle the
content it's about to receive.

## Events out

```
formatter:format:requested            formatter:format:before
formatter:format:delta                formatter:format:terminal

formatter:format-to-text:requested    formatter:format-to-text:terminal
formatter:format-resource:requested   formatter:format-resource:terminal
formatter:capabilities:inspect:terminal
```

Renderers MAY emit `delta` events for streaming/progressive rendering.
Simple renderers usually emit only `requested` and `terminal`.

## Lifecycle handlers + middleware

Per the five-surface model:

```ts
// Lifecycle handlers
renderer.onUnsupportedContent(handler: (info: { rendererId, blockType }) => void)
renderer.onFormatError(handler: (err: FormatError) => void)

// Middleware (around-style)
renderer.use({
  aroundRender: (input, next) => { ... },
  aroundRenderResource: (input, next) => { ... },
});
```

Common uses for middleware:

| Use case | How |
| --- | --- |
| Enforce allowed output formats | `aroundRender` checks `input.options.format`; throws if not in allow-list |
| Inject formatting options | `aroundRender` augments `input.options` before `next()` |
| Capture render snapshots for tests | `aroundRender` records before/after; calls `next()` |
| Replace render output in golden tests | `aroundRender` returns fixture without calling `next()` |

## Inbox

The formatter harness typically has no inbox messages — it's a pure
transformer. External callers reach it via the React harness or via
direct method calls (commands).

## Outcomes and failures

```
succeeded   with FormatResult
failed      with FormatError
canceled
vetoed
replaced    with FormatResult
```

```ts
type RendererHarnessError =
  | UnsupportedRendererError
  | UnsupportedContentError
  | FormatError
  | FormatCanceledError;

interface UnsupportedRendererError {
  _tag: "UnsupportedRendererError";
  rendererId: string;
  registry: string[];
}

interface UnsupportedContentError {
  _tag: "UnsupportedContentError";
  rendererId: string;
  blockType: string;
}

interface FormatError {
  _tag: "FormatError";
  rendererId: string;
  cause: unknown;
}

interface FormatCanceledError {
  _tag: "FormatCanceledError";
  reason?: string;
}
```

## The renderer interface

A renderer is a small, pure transformer:

```ts
interface Formatter {
  readonly ref: FormatterRef;
  readonly capabilities?: FormatterCapabilities;

  render(input: FormatInput):
    Promise<FormatResult> | FormatResult;
}
```

Rules (from `[SOURCE: renderer-harness.md §Invariants]`):

- Input is structured content, not React nodes.
- Nested `<Markdown>`/`<XML>` providers are reduced to nested
  `FormatScope` values by React **before** the formatter harness is invoked.
- Output is `ContentBlock[]` plus optional text/mimeType + metadata.
- Renderers MUST NOT mutate input content.
- Renderers MUST NOT mutate React, session, runtime, or executor state.
- Renderer instances MUST NOT appear in `RenderedTree`.
- Renderer identity crosses protocol boundaries as `FormatterRef` and
  optional `FormatTrace`.

Renderers MAY be async. The harness boundary returns `Effect<...>` which
absorbs both sync and Promise-returning implementations.

## Nested renderer scopes

The hardest invariant in the renderer model. The author writes:

```tsx
<Markdown>
  Intro
  <XML>
    <Section id="payload">
      <Json data={{ ok: true }} />
    </Section>
  </XML>
  Outro
</Markdown>
```

The React harness reconciles, then the collector sees nested renderer
context providers. It reduces them to a nested `FormatScope` tree:

```ts
{
  kind: "renderer-scope",
  renderer: { id: "markdown", format: "markdown" },
  content: [
    { type: "text", text: "Intro" },
    {
      kind: "renderer-scope",
      renderer: { id: "xml", format: "xml" },
      content: [
        { type: "json", data: { ok: true } }
      ]
    },
    { type: "text", text: "Outro" }
  ]
}
```

Rendering is recursive. The outer renderer decides how to incorporate the
already-rendered output of an inner renderer:

| Outer | Inner | Strategy |
| --- | --- | --- |
| markdown | xml | embed XML output as fenced code block, or as escaped text |
| xml | markdown | embed markdown as escaped text or a typed child element |
| markdown | markdown | flatten (or wrap if context dictates) |

Composition rules belong to renderer implementations and their declared
`FormatterCapabilities`. The formatter harness does not enforce a single
composition strategy — it just walks the scope tree.

This preserves arbitrary renderer nesting without putting renderer
instances, formatter functions, or React Context objects into
`RenderedTree`.

## Where the renderer is called from

```
React harness
  ── renderTree            (per content scope)
  ── renderToString            (free root render)
  ── renderResource            (resource body render)

Tests / prompt previews        (direct, no React tree)
Documentation generation       (direct)
MCP resource server            (direct)
Content transformation tools   (direct)
```

The executor harness does **not** call the formatter harness as a normal
projection step. It receives already-rendered `ContentBlock[]` in
`RenderedTree` and projects those blocks to provider input. If a
provider requires additional stringification, that stringification is
executor projection, not semantic rendering.

`[V1-REPLACED]` of v1's `StructureRenderer` (which fused content rendering
and compiled-structure application). The v2 split:

| Responsibility | Owned by |
| --- | --- |
| Content rendering: `FormattableContent[]` → `FormattedContent` | Formatter harness |
| Compiled structure projection to provider input | Executor harness |
| Adapter-specific stringification (e.g., XML wrapping for Anthropic) | Executor harness |

## Built-in renderers (v2 ships)

```
markdown    — GitHub-flavored markdown
xml         — XML output (similar to Anthropic's XML conventions)
text        — plain text (passthrough text blocks; minimal formatting)
json        — JSON-shaped pass-through (preserves structure)
```

`[V1-INHERITED]` `markdown` and `xml` from `packages/core/src/renderers/`.
`text` and `json` are minor extensions of the v1 set.

`[GAP]` `[SOURCE: renderer-harness.md §Open Question 1]` — package home for
built-in renderers. Blueprint position: ship in `@agentick/react` (see
`03-reconciler-harness.md` §Package shape). Sign-off needed.

## Renderer registry

```ts
interface FormatterRegistry {
  register(renderer: Renderer): void;
  resolve(ref: FormatterRef): Renderer | undefined;
  list(): FormatterRef[];
  capabilities(ref: FormatterRef): FormatterCapabilities | undefined;
}
```

The runtime and the React harness share a registry instance. Custom
renderers are registered at app boot (`createApp(..., { renderers: [...]})`).

`[PLACEHOLDER]` registry shape — the source proposals don't enumerate it.

## Capabilities

```ts
interface FormatterCapabilities {
  contentTypes?: string[];        // ContentBlock["type"][] supported
  semanticTypes?: SemanticType[]; // SemanticNode types supported
  outputFormats?: string[];       // "markdown", "xml", ...
  streaming?: boolean;            // can emit delta events
}
```

Formatter harness uses this for early validation (`UnsupportedContentError`)
and for compile-time grammar checking (does the markdown renderer know
about a custom block type?).

`[V1-REFINED]` of v1's `getCustomPrimitives()` method on the renderer base
class. v2 makes capabilities a first-class declarative field.

## Streaming renderers

`[GAP]` `[SOURCE: renderer-harness.md §Open Question 3]` — whether v2
supports streaming renderers.

Blueprint position `[PROPOSAL]`: ship the protocol surface (`delta` phase
already in the envelope), but keep streaming optional. v2 built-in
renderers are non-streaming. Custom renderers MAY emit `delta` events if
their `FormatterCapabilities.streaming === true`.

## Renderer-specific options

`[GAP]` `[SOURCE: renderer-harness.md §Open Question 4]` — how renderer-specific
options are schema-declared and validated.

Blueprint position `[PROPOSAL]`: each renderer declares an optional
`optionsSchema` (Standard Schema) on its registration. The renderer
harness validates `FormatInput.options` against the schema before invoking
`render`. Validation errors become `FormatError` with structured details.

```ts
interface Formatter {
  readonly ref: FormatterRef;
  readonly capabilities?: FormatterCapabilities;
  readonly optionsSchema?: StandardSchemaV1<unknown, RendererOptions>;
  render(input: FormatInput): Promise<FormatResult> | FormatResult;
}
```

Sign-off needed.

## Tests and golden fixtures

The formatter harness's interceptor model makes golden testing trivial:

```ts
const fixtureInterceptor: Interceptor<"renderer:render"> = (input, next) =>
  effect.gen(function* () {
    if (input.purpose === "section" && input.source?.id === "policy") {
      return { kind: "replace", result: goldenFixture };
    }
    return { kind: "proceed" };
  });
```

Standard test pattern: register the interceptor, run the React harness
through `renderTree`, assert the resulting `RenderedTree`
contains the golden content.

## Composition with other harnesses

```
              React harness
                   │
          (per content scope)
                   ▼
            Formatter harness
                   │
    (recursive across FormatScope tree)
                   │
                   ▼
              ContentBlock[] in
              RenderedTree
                   │
                   ▼
              Loop executor
                   │
                   ▼
              Executor harness
                (project step)
```

The formatter harness is downstream of React (when called for compilation)
and upstream of the executor (which consumes already-rendered content).
It can also be used standalone (Level 1 use cases — see
`03-reconciler-harness.md` §Levels of usage).

## Decisions captured

- Renderer is its own first-class harness, not a React-internal helper.
- Renderer identity crosses boundaries as data (`FormatterRef`).
- Nested renderer providers reduce to nested `FormatScope` before crossing
  any harness boundary.
- Renderers are pure transformers; they do not mutate input or external
  state.
- Formatter harness is independent of React; React is one common caller.
- Executor harness does not call renderers.

## Open questions still open

- Package home for built-in renderers (lean: `@agentick/react`).
- `renderToText` separate command vs flag (lean: separate).
- Streaming renderers ship vs defer (lean: ship surface, no built-in).
- Renderer options schema mechanism (lean: per-renderer Standard Schema).

All four are sign-off items, not gating items for the v2 design.

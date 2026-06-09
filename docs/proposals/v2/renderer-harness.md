# Renderer Harness

## Status: Living Draft

Last updated: 2026-05-08

The renderer harness turns structured Agentick content into concrete
representations such as markdown, XML, plain text, JSON-like payloads, and MCP
resource bodies.

It is a first-class v2 harness. The React harness commonly drives it during
compilation and resource rendering, but renderer semantics are independent of
React, runtime execution, and provider projection.

## Role in the Architecture

Renderer sits between semantic content collection and protocol artifact
emission:

```ts
RenderScope -> RendererHarness -> RenderedContent
```

It is used by:

- the React harness during `compileContext`
- `renderToString` and `renderResource`
- tests and prompt previews
- documentation and MCP resource generation
- future content transformation utilities

It is not used by executors to project `CompiledStructure` to provider input.
Executors project already-rendered `ContentBlock[]` according to target-provider
rules.

## Commands In

- `render(input: RenderInput): RenderResult`
- `renderToText(input: RenderInput): RenderResult`
- `renderResource(input: RenderInput): RenderResult`
- `inspectCapabilities(rendererRef?: RendererRef): RendererCapabilities`

All commands follow the shared harness event phase model:

- `requested`
- `before`
- `delta`
- `terminal`

## Events Out

Canonical event names:

- `renderer:render`
- `renderer:render-to-text`
- `renderer:render-resource`
- `renderer:capabilities:inspect`

Renderers MAY emit `delta` events for streaming or progressive rendering. Simple
renderers usually emit only `requested`, optional `before`, and `terminal`.

## Interceptors

Renderer commands are interceptable. Interceptors may:

- proceed
- defer
- veto
- replace the render result

Common uses:

- enforce allowed output formats
- inject formatting options
- capture render snapshots for tests
- replace render output in golden tests
- reject unsupported semantic/content blocks early

## Outcomes and Failures

Successful render commands return `RenderResult`.

Failure types:

- `UnsupportedRendererError`
- `UnsupportedContentError`
- `RenderError`
- `RenderCanceledError`

Terminal outcomes use the shared harness vocabulary:

- `succeeded`
- `failed`
- `canceled`
- `vetoed`
- `replaced`

## Protocol Types

```ts
interface Renderer {
  readonly ref: RendererRef;
  readonly capabilities?: RendererCapabilities;
  render(input: RenderInput): Promise<RenderResult> | RenderResult;
}

interface RendererRef {
  id: string;
  format?: "markdown" | "xml" | "text" | "json" | string;
  version?: string;
}

interface RendererCapabilities {
  contentTypes?: string[];
  semanticTypes?: string[];
  outputFormats?: string[];
  streaming?: boolean;
}

interface RenderInput {
  content: RenderableContent[];
  purpose: "context" | "message" | "section" | "free-root" | "resource" | "output";
  source?: RenderSourceRef;
  options?: Record<string, unknown>;
}

type RenderableContent = RenderableBlock | RenderScope;

type RenderableBlock = ContentBlock & {
  semanticNode?: SemanticNode;
  semantic?: SemanticMetadata;
};

interface RenderScope {
  kind: "renderer-scope";
  renderer: RendererRef;
  content: RenderableContent[];
  source?: RenderSourceRef;
  options?: Record<string, unknown>;
}

interface RenderSourceRef {
  kind: "message" | "section" | "free-root" | "resource" | "output";
  id?: string;
}

interface RenderResult {
  content: ContentBlock[];
  text?: string;
  mimeType?: string;
  renderedWith: RendererRef;
  renderTrace?: RenderTrace[];
  diagnostics?: RenderDiagnostic[];
  metadata?: Record<string, unknown>;
}

interface RenderTrace {
  renderer: RendererRef;
  source?: RenderSourceRef;
  children?: RenderTrace[];
  metadata?: Record<string, unknown>;
}

interface RenderDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  code?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}
```

## Invariants

- Renderer input is structured content, not React nodes.
- Nested renderer providers are represented as nested `RenderScope` values before
  protocol emission.
- Renderer output is protocol data, not provider input.
- Renderers MUST NOT mutate input content.
- Renderers MUST NOT mutate React, session, runtime, or executor state.
- Renderer instances MUST NOT appear in `CompiledStructure`.
- Renderer identity crosses protocol boundaries as `RendererRef` and optional
  `RenderTrace`.
- `RenderedContent.content` is the structured output source of truth.
- `RenderedContent.text` is a convenience projection for string-oriented
  consumers.

## Nested Renderer Scopes

Renderer context providers such as `<Markdown>`, `<XML>`, or a generic
`<Renderer>` are meaningful at React render time. They establish renderer scopes
for their descendants.

The React harness MAY hold live renderer instances while reconciling and
collecting the tree. That is allowed because this is still inside the harness
implementation boundary. Before emitting protocol data, those live instances are
reduced to `RendererRef` values and nested `RenderScope` nodes.

Example:

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

The internal render tree keeps the nesting:

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
already-rendered output of an inner renderer. For example, markdown may embed
XML output as text or a code block; XML may embed markdown output as escaped text
or a typed child node. Those composition rules belong to renderer
implementations and renderer capabilities.

This preserves arbitrary renderer nesting without putting renderer instances,
formatter functions, or React context objects into `CompiledStructure`.

## Relationship to React Harness

The React harness resolves renderer selection from the React tree, builds nested
`RenderScope` values, then invokes the renderer harness for each renderable
scope.

During `compileContext`, renderer output is embedded into `CompiledStructure`:

- message render output becomes `MessageEntry.content`
- section render output becomes `SectionEntry.content`
- free root render output becomes top-level `content`
- free root text projection becomes top-level `text`
- render provenance may become `renderTrace` on the relevant message, section,
  or top-level free root output

For `renderToString` and `renderResource`, the React harness may skip
`CompiledStructure` emission and return `RenderedContent` directly.

## Relationship to Executor Harness

The executor harness does not call renderers as a normal projection step. It
receives rendered `ContentBlock[]` in `CompiledStructure` and projects those
blocks to provider input.

If a provider requires additional stringification, that stringification belongs
to executor projection, not semantic rendering. This keeps semantic rendering
and target/provider lossiness separate.

## Open Questions

1. Should renderer implementations live in `@agentick/react`, `@agentick/spec-next`,
   or a separate `@agentick/renderers` package?
2. Should `renderToText` be a separate command or a `render` mode?
3. Should streaming renderers be supported in v2, or reserved for later?
4. How should renderer-specific options be schema-declared and validated?

# React Harness

## Status: Living Draft

Last updated: 2026-05-08

The React harness (`@agentick/react`, package shape provisional) is the
producer-side harness for v2. It mounts a real React JSX tree as a living
application and can produce multiple rendered artifacts from it, including
[`CompiledStructure`](./compiled-spec.md), markdown/XML/text output, and
resource content.

In v2, "compiler" is one capability of the React harness, not the whole thing.
The mounted React tree owns component identity, hook state, effects,
subscriptions, providers, scoped declarations, and render-time dependency
capture.

## Role in the Architecture

The React harness sits on one side of the spec boundary:

- **React harness**: maintain a mounted React app and render artifacts
- **Renderer harness**: render semantic content into concrete content/text
- **Runtime harness**: orchestrate executions and session lifecycle
- **Executor harness**: project and run model/provider operations

The React harness is React-first, renderer-driven, and topology-agnostic.

## Design Principles

1. **Real React only.** Users author standard React components, hooks, and JSX.
2. **Living runtime, snapshot outputs.** React stays mounted; compilation is a
   snapshot command over living state.
3. **Compiled output is one contract.** The harness emits `CompiledStructure`
   directly for agent execution; no COM dual-shape intermediary.
4. **Renderer harness output is first-class.** The same semantic tree can render
   to markdown, XML, text, JSON-like content, or resource payloads.
5. **Compile until stable.** Iterative reconciliation converges before snapshot
   emission.
6. **Harness boundary clarity.** Runtime drives React through explicit commands
   and consumes explicit outputs.
7. **Effect-free package surface.** The React harness package remains
   browser-safe and runtime-substrate agnostic.
8. **Async-capable rendering.** Async components and data hooks remain
   first-class.

## React Harness Contract

The React harness implements the React harness protocol described in
[`spec-package.md`](./spec-package.md).

### Commands in

- `mount`
- `rerender`
- `compileContext`
- `renderToString`
- `renderResource`
- `unmount`
- `snapshot`
- `restore`

### Events out

- `mounted`
- `recompiled`
- `rendered`
- `suspended`
- `async-component-resolved`
- `react-runtime-error`

### Interceptors

- `before-mount`
- `after-mount`
- `before-rerender`
- `after-rerender`
- `before-render-resource`
- `after-render-resource`

### Errors

- `CompileError`
- `RendererError`
- `AsyncComponentError`
- `ReactRuntimeStateError`

## Levels of Usage

Agentick should be usable at multiple levels:

### Level 1: JSX to rendered content

Mount JSX and render semantic output through a renderer without running an agent
loop. This enables MCP resources, documentation generation, prompt previews, and
other string/content outputs.

Examples:

- JSX -> markdown resource
- JSX -> XML resource
- JSX -> text system prompt fragment
- JSX -> JSON-like content payload

### Level 2: JSX to `CompiledStructure`

Mount JSX and compile the current tree to a structured protocol artifact. The
caller may inspect it, test it, or pass it to any executor.

### Level 3: Session execution loop

Use the Agentick runtime to run executions. The loop executor calls the React
runtime for snapshots, passes snapshots to an executor, applies outputs back to
session state, and repeats while continuation policy allows.

Each level builds on the previous one. The agent loop is not required to use the
compiler/renderer.

## Compiler Grammar

The compiler should have an explicit grammar. It should not be an ad-hoc tree
walk where every node can mean anything.

### Structural components

Structural components create protocol structure or runtime declarations:

- `<System>` -> `MessageEntry`
- `<Message>`, `<User>`, `<Assistant>`, `<ToolResult>` -> `MessageEntry`
- `<Section>` -> `SectionEntry`
- `<Timeline>` -> zero or more `MessageEntry` values
- `<Tool>`, `createTool()` JSX usage -> `ToolDeclaration`
- `<Model>` -> `SpecConfig` / provider options
- `<MCP>` -> runtime declarations
- `<Output>` -> `OutputDeclaration`

Structural components create content scopes for their children where relevant
(`System`, `Message`, `Section`, etc.).

### Renderer provider components

Renderer provider components establish scoped renderer selection for their
descendants:

- `<Markdown>`
- `<XML>`
- generic `<Renderer renderer={...}>`
- user-defined renderer provider components

They do not create `ContextEntry` values by themselves. They shape how
descendant content scopes are rendered. Renderer providers MAY be nested
arbitrarily (`xml` inside `markdown` inside `xml`, etc.).

The React harness may hold live renderer instances while collecting the tree,
because that work is still inside the implementation boundary. Before emitting a
public protocol artifact, live renderer instances are reduced to `RendererRef`
values and internal `RenderScope` trees.

### Content components

Content components are only meaningful inside a content scope or at the free
root of a renderable JSX tree:

- `<Text>`
- `<Image>`
- `<Code>`
- `<Json>`
- `<Document>`
- `<Audio>`
- `<Video>`
- semantic components such as `<H1>`, `<Paragraph>`, `<List>`, `<Table>`

Loose text inside a content scope becomes an implicit `TextBlock`.

Loose text outside structural components is collected as free root content. It
does not automatically become model context.

## Output Channels

The compiler produces channels, not a single ambiguous blob:

- `context`: ordered structural model-input IR (`ContextEntry[]`)
- `declarations`: runtime registrations and execution hints
- `content`: free root rendered/collected `ContentBlock[]`
- `text`: renderer projection of free root content
- `diagnostics`: grammar, convergence, and rendering diagnostics

Consumers decide which channels are valid:

- Loop executor consumes `context` and `declarations`; it SHOULD warn or fail
  when free root `content`/`text` is present during agent execution.
- Resource rendering consumes `content` and/or `text`; it MAY ignore `context`
  and `declarations`.
- Tests and devtools may inspect all channels.

This keeps the compiler mode-light: it can compile the same mounted tree once,
then callers validate the channels they accept.

## Compile Pipeline

```
React JSX tree
  -> reconcile
  -> collect semantic output
  -> render content scopes
  -> build CompiledStructure
  -> structural equality check
  -> stable emit (or forced-stable policy)
```

The loop executor consumes the resulting `CompiledStructure` snapshot per tick.

## Renderer Harness

Renderer is meaningful enough to receive the full harness treatment. It has
commands, events, interceptors, outcomes, diagnostics, and mockable test
implementations. The default implementation may live next to the React harness,
but the boundary is independent.

See [`renderer-harness.md`](./renderer-harness.md) for the canonical renderer
harness contract. This section describes how the React harness uses it.

The renderer harness is commonly driven by the React harness, but it is not
owned by React and it is not an executor projection step. It is also not a live
object stored in `CompiledStructure`.

The React harness first reconciles the tree and collects content scopes plus
renderer scopes. A content scope is any place that can contain renderable
content:

- message entries
- section entries
- free root content
- resource output
- named output declarations when materialized

The React harness then calls the renderer harness to turn collected semantic
content into protocol content and textual projections. Nested renderer providers
become nested internal `RenderScope` values, so mixed rendering such as XML
inside markdown inside XML remains representable. The public
`CompiledStructure` returned by `compileContext` contains renderer output,
renderer references, and optional render traces, not renderer instances.

Existing v1 renderer concepts remain central:

- `Renderer` transforms `SemanticContentBlock[]` into `ContentBlock[]`.
- Markdown and XML are renderer implementations.
- `StructureRenderer` currently applies compiled structure and formats semantic
  blocks.

In v2 this becomes a first-class harness rather than an incidental part of
model input preparation.

In v2, `StructureRenderer` should split into two responsibilities:

- **content rendering**: `RenderableContent[] -> RenderedContent`
- **runtime projection/application**: handled by loop/runtime/executor harnesses

### Renderer harness contract

Commands in:

- `render`
- `renderToText`
- `renderResource`
- `inspectCapabilities`

Events out:

- `renderer:render:requested`
- `renderer:render:before`
- `renderer:render:delta`
- `renderer:render:terminal`

Interceptors:

- `render`
- `renderToText`
- `renderResource`

Typed outcomes:

- `succeeded` with `RenderResult`
- `failed` with `RenderError`
- `canceled`
- `vetoed`
- `replaced` with `RenderResult`

### Renderer interface

The renderer protocol is intentionally small and pure. It receives structured,
JSON-safe content and returns rendered content. It MUST NOT mutate React state,
runtime state, session state, or the input content.

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
  purpose:
    | "context"
    | "message"
    | "section"
    | "free-root"
    | "resource"
    | "output";
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

Renderer rules:

- Renderer input is structured content (`RenderableContent[]`).
- Renderer output is `ContentBlock[]`, optional text, and metadata describing
  the renderer used.
- Renderers run for structural content and free root content alike.
- Renderer selection is scoped. A subtree MAY choose a renderer, otherwise the
  React harness default renderer applies.
- Nested renderer providers are preserved before protocol emission as internal
  `RenderScope` values.
- `CompiledStructure` stores only `RendererRef`, never a renderer instance.
- During compilation, rendering happens inside React harness artifact
  production through calls to the renderer harness.
- Outside compilation, callers MAY use the renderer harness directly for tests,
  resource rendering, prompt previews, documentation, and content transforms.
- A caller that wants a different rendering format from a React tree calls the
  React harness again with a different renderer configuration, rather than
  reinterpreting executor input.

### Relationship to compilation

The compiler has an internal pre-protocol form: reconciled React output plus
collected content scopes and declarations. The React harness passes each
renderable scope to the renderer harness before the public artifact is
finalized.

For `compileContext`, renderer output is embedded into the returned
`CompiledStructure`:

- each `MessageEntry.content` is rendered content for that message
- each `SectionEntry.content` is rendered content for that section
- top-level `content` is rendered free root content
- top-level `text` is the renderer's textual projection of free root content

For `renderToString` and `renderResource`, the React harness may skip
`CompiledStructure` emission entirely and return `RenderedContent` produced by
the renderer harness.

Loop execution SHOULD treat top-level free root `content` or `text` as invalid
unless explicitly configured to accept it. That warning belongs to the loop
executor because the same React harness output is valid for MCP resources,
prompt previews, documentation, and tests.

## Compile-Until-Stable

A single pass is often insufficient due to async resolution and reactive state
updates. The compiler iterates until convergence.

### Triggers that can destabilize output

- async component resolution
- signal updates during render cycle
- data hook completion (`useData`)
- reactive registration changes

### Required result metadata

- iteration count
- stable vs forced-stable
- warnings for non-convergent patterns

## Hooks Model

The compiler supports two hook categories:

1. **React hooks** (`useState`, `useEffect`, etc.)
2. **Agentick hooks** (`useSignal`, `useKnob`, `useTimeline`, `useData`,
   `useResolved`, etc.)

Agentick hooks are still authored as React hooks but resolve runtime-backed
state through bridge interfaces supplied by the runtime harness.

## Component Taxonomy

### Registration components

Contribute declarations to compiled output or runtime integration metadata.

- `<Model>`
- `<Tool>`
- `<MCP>`
- other declarative registration primitives

### Provider components

Provide scoped context for descendants.

- `<Sandbox>`
- `<MCP>` providers
- user-defined context providers

### Output components

Produce entries/content in `CompiledStructure`.

- `<System>`
- `<User>`
- `<Assistant>`
- `<Event>`
- semantic/content blocks

## Long-Lived Primitives

Long-lived primitives remain two-stage:

1. **Compile-time declaration** (intent and identifiers)
2. **Runtime materialization** (resources, subscriptions, delivery)

Compiler responsibility:

- collect intent declarations
- validate identifiers where possible
- preserve enough metadata for runtime restoration

Runtime responsibility:

- materialize and supervise external resources
- route external activity back to runtime/session operations

## React Harness <-> Runtime Boundary

The runtime or loop executor drives React harness operations through protocol
calls. The React harness does not own execution orchestration and does not ingest
provider/tool results as an execution side effect. Runtime updates session state,
then asks the React harness to render the React tree against that state.

React harness guarantees:

- deterministic output for equivalent state
- stable compile semantics with explicit convergence policy
- renderer output through explicit renderer commands
- protocol-level snapshot/restore support

Runtime guarantees:

- proper lifecycle invocation (`mount`/`rerender`/`unmount`)
- ownership of model/tool feedback application to runtime session state
- ownership of execution context, cancellation, and persistence policies

## Package Shape

```
packages/react/
  src/
    jsx-runtime.ts
    reconciler/
    compiler/
    renderers/
    components/
    hooks/
```

The package depends on spec types and React, not on runtime substrate packages.

## Out of Scope

The React harness does **not** own:

- provider request projection logic
- model execution and streaming
- tool handler execution
- transport or gateway concerns
- cluster/sharding concerns

Those are runtime or executor concerns.

## Testing Strategy

React harness tests should cover:

- compile output correctness
- render-to-string/resource correctness
- convergence behavior and forced-stable policy
- async component handling
- hook bridge behavior via runtime test doubles
- renderer behavior (markdown/XML/text)
- compiler grammar validation
- free root content/text output
- protocol conformance

Protocol conformance suites should be reusable across future compiler
implementations, even if v2 ships React-only.

## Open Questions

1. **Forced-stable policy.** Hard fail vs soft warning defaults?
2. **Async cancellation semantics.** Exact behavior for suspended components
   interrupted by lifecycle transitions?
3. **Identifier validation.** Which checks are compile-time vs runtime-time?
4. **Hook bridge strictness.** How strongly typed should runtime-provided hook
   bridges be in protocol definitions?
5. **Renderer output contract.** Is renderer output always `RenderedContent`, or
   do some renderers return strings/resources directly?
6. **Agent execution strictness.** Should free root content during loop
   execution be a hard error by default or a warning with strict-mode failure?

## Decision Log

- **React harness is a living mounted application, not a pure one-shot
  compiler.** (2026-05-08)
- **Compilation is one command exposed by the React harness.**
  (2026-05-08)
- **Renderer output is a first-class capability.** (2026-05-08)
- **Compiler output has distinct channels: context, declarations, content,
  text, diagnostics.** (2026-05-08)
- **Compiler is permissive; consumers validate accepted output channels.**
  (2026-05-08)
- **No COM intermediate shape in v2 docs.** (2026-05-08)
- **Compile-until-stable remains core behavior.** (2026-05-08)
- **React harness package remains Effect-free and topology-agnostic.**
  (2026-05-08)
- **Long-lived primitive model stays two-stage (declare then materialize).**
  (2026-05-08)

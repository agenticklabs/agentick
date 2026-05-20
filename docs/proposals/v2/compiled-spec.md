# CompiledStructure Protocol

## Status: Living Draft

Last updated: 2026-05-08

This document defines the canonical intermediate representation (IR) produced by
the React runtime compiler and consumed by loop/executor harnesses.

It replaces the v1 dual-shape model (`CompiledStructure` vs `COMInput`) with one
versioned JSON-serializable shape. It is a protocol snapshot and IR: not a
runtime object model, not a React fiber tree, and not provider-specific model
input.

## Normative Language

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
used with their protocol meanings.

## Purpose

`CompiledStructure` answers two questions:

1. What context should the target model/executor receive on this tick?
2. What runtime declarations did the React tree contribute?
3. What free root content did the React tree render, if any?

Those are related but not identical. Model-input context belongs under
`context`. Runtime declarations belong under `declarations`. Free root rendered
content belongs under `content` and `text`. Executable code and live resource
instances MUST NOT appear in this protocol shape.

`CompiledStructure` deliberately stops before provider/model input. The selected
execution target determines how this IR is projected. A language-model executor
may project it to messages and tools; a future executor family may project it to
another input shape. Projection is executor responsibility.

## Core Shape

```ts
interface CompiledStructure {
  specVersion: string; // date version, example: "2026-05-01"
  features?: string[];
  context: ContextSpec;
  declarations?: RuntimeDeclarations;
  config?: SpecConfig;
  providerOptions?: ProviderOptions;
  content?: ContentBlock[];
  text?: string;
  mimeType?: string;
  renderedWith?: RendererRef;
  renderTrace?: RenderTrace[];
  diagnostics?: CompileDiagnostics;
  metadata?: Record<string, unknown>;
}

interface ContextSpec {
  entries: ContextEntry[];
}

type ContextEntry = MessageEntry | SectionEntry;

interface MessageEntry {
  kind: "message";
  role: string;
  content: ContentBlock[];
  renderedWith?: RendererRef;
  renderTrace?: RenderTrace[];
  id?: string;
  metadata?: MessageMetadata;
}

interface SectionEntry {
  kind: "section";
  id: string;
  title?: string;
  content: ContentBlock[];
  renderedWith?: RendererRef;
  renderTrace?: RenderTrace[];
  metadata?: SectionMetadata & {
    priority?: number;
    cache?: CacheHint;
  };
}

interface RuntimeDeclarations {
  tools?: ToolDeclaration[];
  resources?: ResourceDeclaration[];
  outputs?: OutputDeclaration[];
  mcp?: MCPDeclaration[];
}

interface RenderedContent {
  content: ContentBlock[];
  text?: string;
  mimeType?: string;
  renderedWith: RendererRef;
  renderTrace?: RenderTrace[];
  diagnostics?: RenderDiagnostic[];
  metadata?: Record<string, unknown>;
}

interface RendererRef {
  id: string;
  format?: "markdown" | "xml" | "text" | "json" | string;
  version?: string;
}

interface RenderTrace {
  renderer: RendererRef;
  source?: RenderSourceRef;
  children?: RenderTrace[];
  metadata?: Record<string, unknown>;
}

interface RenderSourceRef {
  kind: "message" | "section" | "free-root" | "resource" | "output";
  id?: string;
}

interface RenderDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  code?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}
```

## Required Invariants

Implementations MUST preserve these invariants:

- `context.entries` order is canonical and follows authored JSX tree order
  after React reconciliation.
- `context` MUST contain only model-input context intended for executor
  projection.
- `declarations` MUST contain runtime-facing registrations and intents.
- `content` MUST contain only free root content that was not captured by a
  structural component.
- `text`, when present, MUST be the renderer projection of `content`.
- `mimeType`, when present at the top level, describes the media type of
  top-level `text`.
- `renderedWith`, when present at the top level, describes the renderer that
  produced top-level free root `content` and `text`.
- entry-level `renderedWith`, when present, describes the renderer that produced
  that entry's `content`.
- `renderTrace`, when present, describes nested renderer composition that
  contributed to the final rendered output.
- Agent execution consumers SHOULD reject or warn when `content` or `text` is
  present unless explicitly configured to accept free root content.
- Executable functions, class instances, renderers, formatters, providers,
  transports, database handles, and other live references MUST NOT appear in the
  protocol artifact.
- Unknown object fields MUST be preserved on round trips when feasible.
- `specVersion` MUST identify the protocol contract, not the package version.

## Rendering Boundary

`CompiledStructure` contains renderer output and renderer provenance, not
renderer instances.

The React harness drives rendering during `compileContext`. It reconciles React
until stable, collects renderable content scopes, resolves nested renderer
providers into internal `RenderScope` trees, calls the renderer harness for each
scope, and only then emits the public protocol artifact.

The renderer boundary is:

```ts
RendererHarness.render(RenderInput) -> RenderedContent
```

The compiler embeds `RenderedContent.content` into the relevant protocol scope:

- `MessageEntry.content`
- `SectionEntry.content`
- top-level `content` for free root output

The compiler embeds `RenderedContent.text` only where text is a named output of
that scope. In the current protocol, only top-level free root output has a
dedicated `CompiledStructure.text` channel. Message and section textual
projection remains an executor projection concern: executors inspect and
serialize their `ContentBlock[]` according to target-provider rules.

Renderer identity is data:

- `MessageEntry.renderedWith` identifies the renderer used for a message.
- `SectionEntry.renderedWith` identifies the renderer used for a section.
- top-level `renderedWith` identifies the renderer used for free root
  `content`/`text`.
- `renderTrace`, when present, may describe nested renderer composition that
  contributed to the final output for that scope.

Renderer instances, formatter functions, callback closures, and runtime service
handles MUST NOT appear in `CompiledStructure`.

Applying a renderer to an already emitted `CompiledStructure` is not the normal
execution path. Callers that need a different output format SHOULD ask the
React harness to render or compile again with a different renderer. This avoids
double-rendering and keeps renderer scope resolution inside the React tree.

## Context Entries

`context.entries` is the ordered model-input context stream sent toward the
executor for projection.

The protocol intentionally does not assume every executor is a chat LLM.
Language-model executors may interpret entries as instructions and conversation
history. Other executors may project the same entries into other model input
forms such as conditioning, references, multimodal inputs, or generation
parameters.

### Message entries

Message entries represent role-bearing context.

```ts
interface MessageEntry {
  kind: "message";
  role: string;
  content: ContentBlock[];
  renderedWith?: RendererRef;
  renderTrace?: RenderTrace[];
  id?: string;
  metadata?: MessageMetadata;
}
```

Canonical roles SHOULD include:

- `user`
- `assistant`
- `tool`
- `system`

`MessageEntry.role` is an Agentick semantic role, not a provider role.
Mapping to provider role vocabulary (e.g., OpenAI `system`/`user`/
`assistant`/`tool`, Anthropic `system`/`user`/`assistant`) is the
executor's job during projection.

The role string remains open. Executors MAY map semantic roles to provider
roles, split entries, or merge entries when required by provider
constraints. Projection choices belong to executors, not the compiled
protocol.

## Projection Boundary

There is no universal `ModelInput` for all targets. The projection boundary is:

```ts
CompiledStructure + ExecutionTarget + ExecutorAdapter -> TargetInput
```

The inverse boundary is normalization:

```ts
TargetOutput + ExecutionTarget + ExecutorAdapter -> ExecutorTerminal
```

The compiler produces the IR. The executor adapter implements target-aware
projection and normalization. The loop executor coordinates when those happen.

### Section entries

Sections are first-class context entries. They are not a separate map and
not an authoring-only abstraction.

```ts
interface SectionEntry {
  kind: "section";
  id: string;
  title?: string;
  content: ContentBlock[];
  renderedWith?: RendererRef;
  renderTrace?: RenderTrace[];
  metadata?: SectionMetadata;
}
```

A section represents structured context such as policy, environment,
memory, retrieved documents, grounding, or tool-rendered state.

`id` is the stable identity of the section across recompiles and the cache
correlation key. `title` is an optional human-readable label.

Sections do not carry a closed `intent` enum. v2 intentionally drops that
field; if a future projection hint is needed, it will be added as a narrow,
well-scoped addition consumed explicitly by named executor families. Until
then, sections are sections — executors project them as content with stable
identity.

Sections MUST NOT carry `audience`. A compiled context is already
model-facing.

Sections MUST NOT carry `position`. Ordering is determined by location in
`context.entries`.

## Runtime Declarations

Runtime declarations describe things the runtime can materialize, route, or make
invokable. They are compiled from JSX registrations but are not themselves
model-input context.

### Tools

```ts
interface ToolDeclaration {
  id: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  exposure: ToolExposure[];
  handlerRef?: string;
  annotations?: ToolAnnotations;
  metadata?: Record<string, unknown>;
}

type ToolExposure = "model" | "dispatch" | "runtime";
```

Tool exposure semantics:

- `model`: executor MAY expose this tool to the model provider.
- `dispatch`: runtime MAY invoke this tool by direct command (for example
  `session.dispatch` or UI slash commands).
- `runtime`: runtime MAY use this declaration internally, but it is not directly
  model-visible or dispatch-visible.

This replaces the older model-facing `audience` concept. Tool visibility is a
property of the declaration, not of context entries.

`handlerRef` is an identifier resolved by the runtime/tool executor. It MUST NOT
be executable code.

Tool calls and tool results, once they occur, appear as content blocks in
conversation messages or runtime events, depending on whether they are part of
model conversation history.

### Resources

```ts
interface ResourceDeclaration {
  id: string;
  uri?: string;
  name?: string;
  description?: string;
  mimeType?: string;
  handlerRef?: string;
  metadata?: Record<string, unknown>;
}
```

Resources describe addressable runtime material. MCP resources, local resources,
and generated resources can all compile to resource declarations. Reading a
resource remains a runtime command, not model-input context unless a component
renders its contents into `context.entries`.

### Outputs

```ts
interface OutputDeclaration {
  id: string;
  schema?: JsonSchema;
  mode?: "text" | "json" | "json_schema";
  metadata?: Record<string, unknown>;
}
```

Outputs describe a runtime registration of a named, extractable output
shape. Executors project output declarations to provider structured-output
features where possible, and the runtime uses the declaration to extract
and bind the result on the consuming side.

`OutputDeclaration` is distinct from `SpecConfig.responseFormat`:

- `SpecConfig.responseFormat` is a generation-time directive on the model
  call (e.g., "respond as JSON conforming to this schema"). It is provider
  knob territory.
- `OutputDeclaration` is a runtime declaration of named outputs the
  application wants to extract from the result. It is binding territory.

A typical pattern uses both: `responseFormat` requests structured
generation; one or more `OutputDeclaration` entries describe how the
runtime extracts and routes the structured result.

## Deliberate Absences

These v1 concepts MUST NOT appear as top-level compiled protocol concepts:

- `system`: represented as ordered `MessageEntry` values with role `system`
- `timelineEntries`: represented as ordered `MessageEntry` values
- `sections` map: represented as ordered `SectionEntry` values
- `ephemeral`: ephemeral is a runtime persistence policy, not compiled wire data
- `position`: represented by entry order
- `audience`: context is model-facing; tool exposure lives on declarations
- root loose text: represented as free root `content`/`text`, not silently
  injected into `context.entries`
- executable references: represented by IDs and handler references only

## Content Blocks

`content` uses the shared content block taxonomy from `@agentick/spec`.

The protocol SHOULD remain richer than any single provider API. Executors are
responsible for lossy provider projection when providers cannot represent a
block directly.

## Free Root Content

Free root content is JSX content not captured by a structural component.
`content`, `text`, `mimeType`, and `renderedWith` together form a
`RenderedContent` view over that free root content.

Example:

```tsx
<>
  Hello <strong>world</strong>
  <Json data={{ ok: true }} />
</>
```

This produces no `context.entries`, but may produce:

````ts
{
  context: { entries: [] },
  content: [
    { type: "text", text: "Hello world" },
    { type: "json", data: { ok: true } }
  ],
  text: "Hello **world**\n\n```json\n{\"ok\":true}\n```"
}
````

The exact `text` value depends on the selected renderer.

Rules:

- Loose text inside structural component content becomes implicit `TextBlock`
  content for that structural component.
- Loose text outside structural components becomes free root content.
- Content block components outside structural components contribute to free root
  `content`.
- `text` is convenience output, not the source of truth. `content` remains the
  structured source.
- Consumers decide whether free root content is valid for their use case.

Free root content enables JSX-to-string/resource use cases such as MCP resources
and documentation generation without invoking the agent execution loop.

## Config and Provider Options

```ts
interface SpecConfig {
  model?: ModelSelection;
  responseFormat?: ResponseFormat;
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

type ProviderOptions = Record<string, Record<string, unknown>>;
```

Rules:

- Cross-provider semantics SHOULD live in `config`.
- Provider-specific escapes SHOULD live in `providerOptions`.
- Provider option keys SHOULD be provider namespaces such as `openai`,
  `anthropic`, `google`, or `ai-sdk`.

## Caching Intent

Caching is explicit intent in entry or declaration metadata. The compiler MUST
NOT reorder context solely to improve provider cache behavior.

Executors MAY map cache hints to provider mechanics such as Anthropic cache
control, OpenAI cache keys, or Gemini cached content references.

## Authoring Mapping

React authoring primitives map into the protocol as follows:

- `<System>`, `<User>`, `<Assistant>`, `<Message>`, `<Timeline>` output -> `MessageEntry`
- `<Section>` and tool `render()` output -> `SectionEntry`
- `<Tool>` and `createTool()` registration -> `ToolDeclaration`
- `<Output>` registration -> `OutputDeclaration`
- `<MCP>` resource/tool/prompt registration -> runtime declarations
- `<Model>` and generation hints -> `config` and/or `providerOptions`
- `responseFormat` props -> `SpecConfig.responseFormat`
- free root JSX text/content -> `content` and renderer-projected `text`
- `<Ephemeral>` -> compiler/runtime-only transient render input; no
  distinct compiled protocol kind

## Example

```json
{
  "specVersion": "2026-05-01",
  "features": ["sections", "tool-declarations"],
  "context": {
    "entries": [
      {
        "kind": "message",
        "role": "system",
        "content": [{ "type": "text", "text": "You are helpful." }]
      },
      {
        "kind": "section",
        "id": "workspace",
        "title": "Workspace",
        "content": [{ "type": "text", "text": "Current repo: agentick" }]
      },
      {
        "kind": "message",
        "role": "user",
        "content": [{ "type": "text", "text": "Say hi" }]
      },
      {
        "kind": "message",
        "role": "assistant",
        "content": [
          {
            "type": "tool_use",
            "id": "call_abc123",
            "name": "search",
            "input": { "query": "agentick" }
          }
        ]
      },
      {
        "kind": "message",
        "role": "tool",
        "content": [
          {
            "type": "tool_result",
            "toolUseId": "call_abc123",
            "content": [{ "type": "text", "text": "Found 12 results." }]
          }
        ]
      }
    ]
  },
  "declarations": {
    "tools": [
      {
        "id": "tool.search",
        "name": "search",
        "description": "Search the workspace",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": { "type": "string" }
          },
          "required": ["query"]
        },
        "exposure": ["model", "dispatch"],
        "handlerRef": "search"
      }
    ]
  }
}
```

## Invalid Examples

A compiled structure MUST NOT include executable handlers:

```ts
{
  declarations: {
    tools: [
      {
        name: "search",
        handler: async () => [], // invalid
      },
    ];
  }
}
```

A section MUST NOT encode placement metadata:

```ts
{
  kind: "section",
  id: "policy",
  position: "before-user" // invalid
}
```

## Validation and Publication

`@agentick/spec` publishes:

- TypeScript contract types
- JSON Schema artifacts
- structural guards
- conformance fixtures

Strict runtime validation is optional for consumers, but official protocol
boundary implementations SHOULD validate in development and tests.

## Compatibility and Evolution

Evolution rules:

- additive fields are preferred
- unknown fields MUST be preserved when feasible
- removals or semantic breaks require a new major spec version transition
- runtimes and executors SHOULD reject unsupported required features
- optional features SHOULD be represented in `features`

## Relationship to Harnesses

This protocol is data. Harness protocols define behavior:

- compiler protocol defines how `CompiledStructure` is produced
- runtime protocol defines when snapshots are compiled, persisted, and consumed
- executor protocol defines how model-input context is projected to providers
- executor protocol defines how provider/model output normalizes back to
  Agentick execution results
- tool executor protocol defines how tool declarations resolve to execution

## Open Questions

1. **Canonical role set.** Should `developer` be canonical or provider-mapped?
2. **Resource declaration scope.** Should prompts and MCP resources share one
   declaration family or remain separate?
3. **Output schema strategy.** JSON Schema-only vs Standard Schema-compatible
   authoring converted to JSON Schema?
4. **Feature registry governance.** How are `features[]` names reserved and
   versioned?
5. **Section projection requirements.** What minimum formatting must executors
   preserve for sections?

## Decision Log

- **Single compiled shape replaces dual v1 formats.** (2026-05-08)
- **Compiled output separates model-input context from runtime declarations.**
  (2026-05-08)
- **Free root content is represented separately as `content`/`text`.**
  (2026-05-08)
- **`text` is renderer projection of `content`; `content` is structured source.**
  (2026-05-08)
- **Loop executor should reject or warn on free root content by default.**
  (2026-05-08)
- **CompiledStructure is an intermediate representation, not provider input.**
  (2026-05-08)
- **Projection and normalization are executor responsibilities.**
  (2026-05-08)
- **Context entries remain ordered and executor-agnostic.** (2026-05-08)
- **Sections remain first-class context entries.** (2026-05-08)
- **Tree order remains canonical; no position metadata.** (2026-05-08)
- **No entry-level audience/visibility in model-input context.** (2026-05-08)
- **Tool visibility is declaration exposure (`model`, `dispatch`, `runtime`).**
  (2026-05-08)
- **Spec carries intent; adapters carry provider mechanics.** (2026-05-08)
- **Unknown-field preservation is required for forward compatibility.**
  (2026-05-08)
- **`SectionEntry.intent` is dropped from v2.** (2026-05-08) Reason: closed
  enum was vague and overlapped role semantics; section identity (`id`,
  `title`) plus content is enough. Future projection hints will be added
  narrowly if needed, not as a closed taxonomy.
- **`MessageEntry.role` is Agentick semantic role, not provider role.**
  (2026-05-08) Reason: provider role mapping belongs to executor
  projection; spec stays target-agnostic.
- **`SpecConfig.responseFormat` and `OutputDeclaration` are distinct.**
  (2026-05-08) Reason: `responseFormat` is a generation-time provider
  directive; `OutputDeclaration` is a runtime registration for named
  extractable outputs. Both can coexist in a single compiled structure.

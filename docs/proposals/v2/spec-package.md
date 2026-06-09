# @agentick/spec-next Package

## Status: Living Draft

Last updated: 2026-05-08

`@agentick/spec-next` is the canonical package for v2 contracts:

- wire data shapes crossing harness boundaries
- protocol interfaces for harness-to-harness integration
- JSON Schema artifacts for cross-language validation

It is the firewall between compiler, runtime, executor, and optional topology
wrappers.

## Why This Package Exists

v1 mixed protocol-shaping types with unrelated shared utilities. That made
versioning, validation, and external interoperability ambiguous.

The spec package fixes this by isolating contract concerns from implementation
concerns.

## Design Principles

1. **Single concern.** Contracts only: wire data + harness protocols.
2. **Versioned protocol discipline.** Date-versioned spec, additive evolution,
   explicit major cuts when removing fields.
3. **Implementation neutrality.** No runtime substrate assumptions in contract
   shapes.
4. **Forward compatibility.** Unknown fields are preserved, not dropped.
5. **Cross-language viability.** JSON Schema published with TypeScript types.
6. **Harness alignment.** Protocol sections mirror harness boundaries from
   [`harness-principle.md`](./harness-principle.md).

## Package Scope

### In scope

- `CompiledStructure`, model entries, declarations, content blocks
- stream/event envelope types crossing harness boundaries
- protocol interfaces for compiler/runtime/renderer/executor/tool
  executor/app/session harnesses
- schema constants and version constants
- schema artifacts and type guards

### Out of scope

- runtime implementation types
- provider SDK clients
- helper utilities (`extractText`, identity helpers, etc.)
- transport server implementations
- persistence/storage adapters

## Data Contracts

The data half defines what crosses boundaries as JSON-shaped values.

Key groups:

- `CompiledStructure` IR and nested types
- context types (`ContextSpec`, `ContextEntry`, `MessageEntry`,
  `SectionEntry`)
- render protocol and output types (`Renderer`, `RenderInput`,
  `RenderResult`, `RenderedContent`, `RendererRef`)
- content block taxonomy
- runtime declarations (`ToolDeclaration`, `ResourceDeclaration`,
  `OutputDeclaration`, MCP declarations)
- event envelopes and tagged metadata
- command/interceptor outcome payload shapes

See [`compiled-spec.md`](./compiled-spec.md) for the canonical structure design.

## V1 Type Sources

Many v2 protocol types should be promoted or refined from existing v1 wire-safe
types instead of reinvented.

| V2 area                   | V1 source                                                           | V2 treatment                                                                                                               |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Content blocks            | `packages/shared/src/blocks.ts`                                     | Promote to spec, replace loose `any` bags with `unknown` or named extension bags where possible.                           |
| Block and role names      | `packages/shared/src/block-types.ts`                                | Promote canonical discriminators and keep extension policy explicit.                                                       |
| Messages                  | `packages/shared/src/messages.ts`                                   | Refine into `MessageEntry` for compiled context.                                                                           |
| Response format and usage | `packages/shared/src/models.ts`                                     | Promote `ResponseFormat` and `UsageStats`; keep model execution input separate from compiled prompt.                       |
| Tool contracts            | `packages/shared/src/tools.ts` and `packages/core/src/tool/tool.ts` | Split wire-safe declaration fields from executable tool implementation. Replace v1 `audience` with declaration `exposure`. |
| Stream events             | `packages/shared/src/streaming.ts`                                  | Use as prior art for v2 `ProtocolEvent` and executor stream normalization, not as-is.                                      |
| Current compiler output   | `packages/core/src/compiler/types.ts`                               | Migration source only; not protocol-safe because it contains executable/runtime references.                                |
| Current COM input         | `packages/core/src/com/types.ts`                                    | Migration source only; replaced by `CompiledStructure` plus runtime state.                                                 |

New v2-only types include:

- `CompiledStructure`
- `ContextSpec`
- `ContextEntry`
- `SectionEntry`
- `RuntimeDeclarations`
- `Renderer` protocol
- `RenderInput`
- `RenderResult`
- `RenderedContent`
- `RendererRef`
- `RenderScope`
- `RenderTrace`
- `RendererCapabilities`
- `RenderDiagnostic`
- declaration exposure
- `ExecutionTarget` / `LanguageModelTarget`
- `ExecutionResult` (protocol-level success payload)
- `ExecutorTerminal` (terminal outcome envelope)
- `LanguageModelExecutionResult` (concrete v2 result type)
- `LanguageModelStopReason`
- `ToolCall` (normalized dispatch view)
- `ExecutorDelta` (streaming chunk shape)
- `EventEnvelope` / `ProtocolEvent`
- `EventQuery`
- command outcomes
- interceptor response types

## Protocol Contracts (Harness-Shaped)

Protocol interfaces are organized by harness boundary, not by package internals.

Core protocol surfaces:

- `ReactHarnessProtocol` (a.k.a. compiler/React runtime harness)
- `RendererHarnessProtocol`
- `LoopExecutorProtocol`
- `ExecutorProtocol` (family-neutral; v2 ships `LanguageModelExecutor`)
- `ToolExecutorProtocol`
- `SessionHarnessProtocol`
- `AppHarnessProtocol`

Each protocol should expose:

1. commands
2. event stream types
3. interceptor boundaries
4. typed outcomes and failure channels

This mirrors the harness principle directly.

### Protocol vs implementation naming

Public protocol vocabulary stays unqualified (e.g., `Executor`,
`ExecutionResult`). Family qualifiers attach to shipped implementations
and their concrete result types:

- `Executor` (protocol) -> `LanguageModelExecutor` (v2 implementation)
- `ExecutionResult` (success payload) -> `LanguageModelExecutionResult`
  (v2 success payload)
- `ExecutorTerminal` (terminal envelope) wraps succeeded/failed/canceled/vetoed
  executor outcomes

Future executor families ship under the same protocol with their own
qualified names (e.g., a hypothetical `ImageGenExecutor` returning
`ImageGenExecutionResult`).

### Shared event integration contracts

To keep events and interceptors on one substrate, spec should define:

- `EventEnvelope` base type
- `ProtocolEvent` event union type
- `EventQuery` selector type
- interceptor response types (`proceed|defer|veto|replace`)
- command outcome types (`succeeded|failed|canceled|vetoed|replaced|deferred`)
- handler registration scope metadata (`global|app|session`)

Public protocol event names should use `surface` rather than `harness` for the
event source dimension. Harness remains architecture vocabulary.

These contracts are consumed by runtime and wrapper packages so integration
behavior is consistent across local and distributed deployments.

## Versioning Strategy

Two version axes:

1. **Spec version (date string)** - protocol/wire contract version
2. **Package version (semver)** - npm release cadence

Rules:

- additive wire changes preserve compatibility
- removing or changing field semantics requires a new major spec version
- package versions may change without spec version changes

## Compatibility Posture

v2 docs assume architectural correctness over backward shims. Compatibility
bridges are migration tooling concerns, not contract-shaping concerns.

This keeps the spec honest and avoids long-lived dual-shape obligations.

## JSON Schema Strategy

Publish JSON Schemas alongside TypeScript types.

Recommended flow:

- TypeScript type definitions as authoring source
- generated schemas committed and versioned
- CI validates schema generation determinism

Validation libraries are optional consumers of the published schemas; they are
not required runtime dependencies for spec type consumers.

## Forward Compatibility Rules

Conformant implementations must:

- preserve unknown keys on round-trips when feasible
- ignore unknown optional fields they do not understand
- avoid destructive reserialization that strips extension metadata

Vendor extensions are allowed via reserved extension key strategy (for example
`x-*` or namespaced keys), finalized in `compiled-spec.md`.

## Package Layout (Proposed)

```
packages/spec/
  src/
    version.ts
    data/
      compiled-structure.ts
      entries.ts
      declarations.ts
      content-blocks.ts
      tools.ts
      execution-result.ts
      execution-target.ts
      events.ts
      outcomes.ts
    protocol/
      react-harness.ts
      loop-executor.ts
      executor.ts
      tool-executor.ts
      session-harness.ts
      app-harness.ts
    guards/
      ...
  schema/
    compiled.schema.json
    entry.schema.json
    content-block.schema.json
    ...
```

## Relationship to Other Docs

- [`harness-principle.md`](./harness-principle.md): abstraction and semantics
- [`compiled-spec.md`](./compiled-spec.md): canonical wire structure
- [`compiler-harness.md`](./compiler-harness.md): React runtime harness
  implementation, including compiler and renderer commands
- [`loop-executor.md`](./loop-executor.md): execution loop harness
- [`runtime.md`](./runtime.md): runtime harness implementation
- [`executor.md`](./executor.md): executor harness implementation
- [`cluster.md`](./cluster.md): optional topology wrapper over harnesses

## Testing and Conformance

Spec conformance should include:

- fixture validation against schema
- protocol contract compile-time checks
- compatibility fixtures across spec versions
- round-trip preservation tests for extension fields

Conformance suites should be reusable by official and third-party
implementations.

## Open Questions

1. **Extension key policy.** `x-*` vs namespaced keys?
2. **Protocol granularity.** One protocol per harness or grouped interfaces with
   clear sections?
3. **Guard strictness defaults.** Structural checks only vs strict schema
   validation defaults?
4. **Schema publication strategy.** npm-only vs hosted immutable URLs?
5. **Event envelope minimum fields.** Exact required causality/correlation
   metadata?

## Decision Log

- **Spec package remains the contract firewall.** (2026-05-08)
- **Public package name is `@agentick/spec-next`.** (2026-05-08)
- **Protocols are harness-shaped by design.** (2026-05-08)
- **Date-versioned spec with additive evolution.** (2026-05-08)
- **Forward compatibility requires unknown-field preservation.**
  (2026-05-08)
- **Compatibility shims are not first-class in v2 contract docs.**
  (2026-05-08)
- **Protocol names are unqualified; implementations carry family
  qualifiers.** (2026-05-08) Reason: keeps `Executor` /
  `ExecutionResult` family-neutral while letting `LanguageModelExecutor`
  / `LanguageModelExecutionResult` carry shipped-target specifics.
- **`ExecutionResult` is the protocol success payload; `ExecutorTerminal`
  carries terminal outcome.** (2026-05-08) Reason: result types cross harness
  boundaries (executor -> loop executor -> session), but failures and
  cancellation belong to the outcome envelope rather than optional result
  fields.

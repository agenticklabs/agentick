# Agentick Compiler

Transforms JSX component trees into `CompiledStructure` - the format-agnostic intermediate representation used by the engine.

## Overview

```
AgentickNode Tree → Collector → CompiledStructure → COM
```

The compiler:

- Traverses the reconciled node tree
- Extracts system prompts, messages, tools, and sections
- Produces `CompiledStructure` that the session applies to the COM

## Key Exports

| Export                  | Description                        |
| ----------------------- | ---------------------------------- |
| `FiberCompiler`         | Main compiler class                |
| `createFiberCompiler()` | Factory function                   |
| `collect()`             | Collect content from node tree     |
| `StructureRenderer`     | Render structure to formatted text |
| `CompiledStructure`     | Output type                        |

## CompiledStructure

The output of compilation:

```typescript
interface CompiledStructure {
  system: CompiledTimelineEntry[];      // System-level content
  timelineEntries: CompiledTimelineEntry[]; // Messages
  tools: CompiledTool[];                // Available tools
  ephemeral: CompiledEphemeral[];       // Temporary content
  sections: Map<string, CompiledSection>; // Named sections
}
```

## Usage

The compiler is used internally by the session. Direct usage:

```typescript
import { createFiberCompiler } from '@agentick/core/compiler';

const compiler = createFiberCompiler(ctx);

// Single-pass compile: reconcile + collect
const compiled = await compiler.compile(<MyApp />, tickState);

// Or separate steps for reactive updates:
await compiler.reconcile(<MyApp />, { tickState });
const compiled = compiler.collect();
```

## Token Annotation

The collector annotates every compiled entry with token estimates. When the COM has a token estimator (registered by the model adapter), `collect()` receives it and stamps `.tokens` on each section, timeline entry, and system entry. The structure gets a `.totalTokens` sum.

```
Model registers estimator with COM
  → FiberCompiler passes estimator to collect()
    → annotateTokens() walks all compiled entries
      → Each entry gets .tokens (content estimate + 4 overhead)
      → structure.totalTokens = sum of all entries
```

**Estimation rules:**

| Block type    | Estimation                                |
| ------------- | ----------------------------------------- |
| `text`        | `estimator(text)`                         |
| `code`        | `estimator(code)`                         |
| `json`        | `estimator(JSON.stringify(data))`         |
| `tool_use`    | `estimator(name + JSON.stringify(input))` |
| `tool_result` | Recursive on nested content               |
| `image`       | Fixed 85 tokens                           |
| Per entry     | +4 token overhead                         |

**Default estimator:** `Math.ceil(text.length / 4) + 4`. Model adapters can register a precise estimator (e.g., tiktoken) via `ModelMetadata.tokenEstimator`.

Token estimates are consumed downstream by Timeline's token budget compaction (see `<Timeline maxTokens={...}>`).

## Architecture

The compiler uses `react-reconciler` directly to build and manage a fiber tree from JSX:

- **Fiber tree**: Built by react-reconciler, represents component hierarchy with hooks state
- **Reconciliation**: React's diffing algorithm schedules updates
- **Collection**: Traverses the reconciled AgentickNode tree to extract content blocks
- **Token annotation**: Stamps token estimates on all compiled entries when an estimator is available
- **Lifecycle integration**: Notifies components of tick start/end events

See the [reconciler README](../reconciler/README.md) for details on the react-reconciler integration.

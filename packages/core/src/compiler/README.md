# Tentickle Compiler

Transforms JSX component trees into `CompiledStructure` - the format-agnostic intermediate representation used by the engine.

## Overview

```
TentickleNode Tree → Collector → CompiledStructure → COM
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
import { createFiberCompiler } from '@tentickle/core/compiler';

const compiler = createFiberCompiler(ctx);

// Single-pass compile: reconcile + collect
const compiled = await compiler.compile(<MyApp />, tickState);

// Or separate steps for reactive updates:
await compiler.reconcile(<MyApp />, { tickState });
const compiled = compiler.collect();
```

## Architecture

The compiler uses `react-reconciler` directly to build and manage a fiber tree from JSX:

- **Fiber tree**: Built by react-reconciler, represents component hierarchy with hooks state
- **Reconciliation**: React's diffing algorithm schedules updates
- **Collection**: Traverses the reconciled TentickleNode tree to extract content blocks
- **Lifecycle integration**: Notifies components of tick start/end events

See the [reconciler README](../reconciler/README.md) for details on the react-reconciler integration.

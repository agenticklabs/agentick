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

const compiler = createFiberCompiler({
  com,
  providers,
  onRecompileRequest: () => { /* handle */ },
});

// Compile JSX to structure
const { compiled } = await compiler.reconcile(<MyApp />, tickState);
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation on:

- Fiber architecture and reconciliation
- Component lifecycle integration
- Hooks system
- Content block registry

See [DESIGN.md](./DESIGN.md) for design philosophy and decisions.

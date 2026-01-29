# @tentickle/core Utils Architecture

> **Utility functions and services used across the core package**

The utils module provides essential utilities for JSX compilation, abort signal handling, and object manipulation. These utilities are used throughout the Engine and related packages.

---

## Table of Contents

1. [Overview](#overview)
2. [Module Structure](#module-structure)
3. [API Reference](#api-reference)
4. [Usage Examples](#usage-examples)
5. [Integration Points](#integration-points)

---

## Overview

### What This Module Provides

The utils module provides four categories of utilities:

- **JSX Compilation** - `Runtime` and `compileJSX` for compiling JSX elements into model input
- **Abort Handling** - `mergeAbortSignals` and `isAbortError` for cooperative cancellation
- **Object Utilities** - `mergeDeep` for recursive object merging
- **Schema Utilities** - Zod/Standard Schema detection and JSON Schema conversion

### Design Principles

- **Engine-aligned** - Utilities mirror Engine's compilation logic for consistency
- **Zero side effects** - Pure functions that don't modify global state
- **Type-safe** - Full TypeScript support with proper generics

---

## Module Structure

```
utils/
├── index.ts                  # Public exports
├── compile-jsx-service.ts    # Full-featured compilation service
├── compile-jsx.ts            # Simple compilation function (deprecated)
├── abort-utils.ts            # Abort signal utilities
├── merge-deep.ts             # Deep object merge utility
└── schema.ts                 # Schema detection/conversion utilities
```

### File Overview

| File                     | Lines | Purpose                                  |
| ------------------------ | ----- | ---------------------------------------- |
| `compile-jsx-service.ts` | ~1900 | Full-featured JSX compilation service    |
| `compile-jsx.ts`         | 72    | Simple compilation (deprecated)          |
| `abort-utils.ts`         | 48    | Abort signal merging and error detection |
| `merge-deep.ts`          | 36    | Recursive object merge                   |
| `schema.ts`              | ~470  | Schema detection and JSON Schema export  |

---

## API Reference

### compile-jsx-service.ts

The `Runtime` is a comprehensive JSX compilation service that provides all the setup and compilation logic the Engine needs. It supports:

- Component and lifecycle hooks
- Tool registration and MCP server initialization
- Model-based renderer resolution
- Session-based multi-tick execution
- Fork/spawn process management

#### `Runtime`

```typescript
class Runtime {
  constructor(config?: RuntimeConfig);

  // Session management
  createSession(config: RuntimeSessionConfig): Promise<RuntimeSession>;

  // Single-tick compilation
  compile(
    jsx: JSX.Element | ComponentDefinition,
    input?: Partial<EngineInput>,
    handle?: ExecutionHandle,
  ): Promise<CompileResult>;

  // Execution methods (as Procedures)
  run: Procedure<(config, fn) => Promise<COMInput>>;
  runStream: Procedure<
    (config, executor) => AsyncGenerator<SessionStreamEvent>
  >;

  // Tool management
  getTools(): (ToolClass | ExecutableTool)[];
  registerTools(com: COM): void;
  registerMCPTools(com: COM): Promise<void>;

  // Internal helpers
  setup(
    input,
    rootElement,
    handle?,
  ): Promise<{ com; compiler; structureRenderer }>;
  prepareTickState(com, tick, previous?, current?): TickState;
  clearAndReRegisterTools(com: COM): void;
  checkAbort(): void;
  callLifecycleHooks<T>(hookName: T, args): Promise<void>;
}
```

#### `RuntimeConfig`

```typescript
interface RuntimeConfig {
  tools?: (ToolClass | ExecutableTool | string)[];
  mcpServers?: Record<string, MCPServerConfig | MCPConfig>;
  channels?: ChannelServiceConfig | ChannelService;
  renderers?: { [key: string]: Renderer };
  defaultRenderer?: ContentRenderer;
  modelGetter?: (com: COM) => ModelInstance | undefined;
  processMethods?: COM["process"];
  hookRegistries?: {
    components?: ComponentHookRegistry;
    lifecycle?: EngineLifecycleHookRegistry;
  };
  componentHooks?: { [K in ComponentHookName]?: ComponentHookMiddleware<K>[] };
  lifecycleHooks?: {
    [K in EngineLifecycleHookName]?: EngineLifecycleHook<K>[];
  };
  compileOptions?: CompileStabilizationOptions;
  abortChecker?: () => boolean;
}
```

#### `RuntimeSession`

A long-lived compilation session for multi-tick execution:

```typescript
class RuntimeSession {
  // State accessors
  readonly tick: number;
  readonly previous: COMInput | undefined;
  readonly current: COMOutput | undefined;
  readonly tickState: TickState | undefined;
  readonly stopReason: string | undefined;
  readonly com: COM;

  // Control queries
  shouldContinue(): boolean;
  isComplete(): boolean;

  // Lifecycle methods
  compileTick(): Promise<TickResult>;
  ingestTickResult(result: TickResultInput): Promise<TickResultOutput>;
  advanceTick(): void;
  notifyError(error, phase, context?): Promise<RecoveryAction | null>;
  complete(): Promise<COMInput>;
  unmount(): Promise<void>;

  // Message API
  sendMessage(
    message: Omit<ExecutionMessage, "id" | "timestamp">,
  ): Promise<void>;
}
```

#### `CompileResult`

```typescript
interface CompileResult {
  compiled: CompiledStructure;
  com: COM;
  structureRenderer: StructureRenderer;
  formatted: COMInput;
  input: COMInput;
  metadata: {
    iterations: number;
    forcedStable: boolean;
    recompileReasons?: string[];
  };
  tickControl: COMTickDecision;
  stopReason?: string | { reason: string; description?: string };
}
```

---

### compile-jsx.ts

Simple compilation function for basic use cases.

#### `compileJSX(jsx, options?)` (deprecated)

```typescript
async function compileJSX(
  jsx: JSX.Element,
  options?: {
    renderer?: ContentRenderer;
    initialInput?: Partial<COMInput>;
  },
): Promise<{
  com: COM;
  compiled: CompiledStructure;
  formatted: COMInput;
}>;
```

> **Note**: This function is deprecated. Use `Runtime` for full-featured compilation with hooks, tools, MCP, etc.

---

### abort-utils.ts

Utilities for working with abort signals in cooperative cancellation scenarios.

#### `mergeAbortSignals(signals)`

Merges multiple `AbortSignal` instances into a single signal that aborts when any of the input signals abort.

```typescript
function mergeAbortSignals(signals: AbortSignal[]): AbortSignal;
```

**Behavior:**

- Returns a never-aborting signal if the array is empty
- Returns the single signal if only one is provided
- Returns a merged signal that aborts when any input signal aborts
- Cleans up event listeners after abort

#### `isAbortError(error)`

Detects if an error is an abort error using multiple heuristics.

```typescript
function isAbortError(error: any): boolean;
```

**Detection heuristics:**

- `error.name === 'AbortError'`
- `error.name === 'DOMException' && error.code === 20`
- Error message contains "abort" or "cancelled"

---

### merge-deep.ts

Recursive object merge utility.

#### `mergeDeep(target, ...sources)`

Deep merges objects recursively. Arrays are replaced, not merged.

```typescript
function mergeDeep<T extends Record<string, any>>(
  target: T,
  ...sources: Array<Partial<T> | undefined>
): T;
```

**Behavior:**

- Recursively merges nested objects
- Arrays are replaced entirely (not concatenated)
- `undefined` sources are skipped
- Mutates and returns the target object

---

## Usage Examples

### Session-Based Compilation

```typescript
import { Runtime } from "tentickle/utils";

const service = new Runtime({
  tools: [MyTool],
  modelGetter: (com) => myModel,
});

const session = await service.createSession({
  input: { timeline: [], sections: {} },
  rootElement: <MyAgent />,
});

while (session.shouldContinue() && session.tick <= 10) {
  // Pre-model: compile and get input
  const { formatted, model, tools } = await session.compileTick();

  // Model execution (caller's responsibility)
  const response = await model.generate(formatted);

  // Tool execution (caller's responsibility)
  const toolResults = await executeTools(response.toolCalls, tools);

  // Post-model: ingest results and run component lifecycle
  await session.ingestTickResult({ response, toolResults });

  // Advance to next tick
  session.advanceTick();
}

const finalState = await session.complete();
```

### Streaming Execution

```typescript
for await (const event of service.runStream(config, {
  onTick: async function* (compiled) {
    for await (const chunk of model.stream(compiled.formatted)) {
      yield chunk;
    }
  },
  finalizeChunks: (chunks) => {
    const response = mergeChunks(chunks);
    return { response };
  },
})) {
  if (event.type === "chunk") {
    process.stdout.write(event.chunk.text);
  }
}
```

### Single-Tick Compilation

```typescript
import { Runtime } from "tentickle/utils";

const service = new Runtime({
  tools: [CalculatorTool],
  defaultRenderer: new MarkdownRenderer(),
});

const result = await service.compile(<MyComponent />, {
  timeline: [],
  sections: {},
});

console.log(result.formatted);
```

### Merging Abort Signals

```typescript
import { mergeAbortSignals } from "tentickle/utils";

// Merge user abort signal with timeout signal
const userController = new AbortController();
const timeoutController = new AbortController();

setTimeout(() => timeoutController.abort(), 30000);

const mergedSignal = mergeAbortSignals([
  userController.signal,
  timeoutController.signal,
]);

// Pass to fetch or other abortable operations
await fetch(url, { signal: mergedSignal });
```

### Error Handling with Abort Detection

```typescript
import { isAbortError } from "tentickle/utils";

try {
  await engine.stream(input);
} catch (error) {
  if (isAbortError(error)) {
    console.log("Operation was cancelled");
  } else {
    throw error; // Re-throw non-abort errors
  }
}
```

### Deep Merging Objects

```typescript
import { mergeDeep } from "tentickle/utils";

const defaults = {
  timeout: 30000,
  retries: { count: 3, delay: 1000 },
};

const userConfig = {
  retries: { count: 5 },
};

const config = mergeDeep({}, defaults, userConfig);
// Result: { timeout: 30000, retries: { count: 5, delay: 1000 } }
```

---

## Integration Points

### Where Utilities Are Used

| Utility             | Used By                       | Purpose                                 |
| ------------------- | ----------------------------- | --------------------------------------- |
| `Runtime`           | `engine/engine.ts`            | Core compilation in Engine tick loop    |
| `Runtime`           | `adapters/ai-sdk/compiler.ts` | AI SDK adapter compilation              |
| `mergeAbortSignals` | `engine/engine.ts`            | Combining context and execution signals |
| `isAbortError`      | `engine/engine.ts`            | Error handling in execution             |
| `mergeDeep`         | `adapters/ai-sdk/adapter.ts`  | Merging provider options                |

### Engine Integration

The Engine uses `Runtime` internally for compilation:

```typescript
// In Engine.stream() / Engine.generate()
const compileService = new Runtime({
  tools: this.getTools(),
  hookRegistries: {
    components: this.componentHooksRegistry,
    lifecycle: this.lifecycleHooksRegistry,
  },
  modelGetter: (com) => this.getRawModel(com),
  processMethods: { fork: ..., spawn: ..., ... },
});

const session = await compileService.createSession({ input, rootElement });

while (session.shouldContinue()) {
  const { model, modelInput, tools } = await session.compileTick();
  const response = await this.executeModel(model, modelInput);
  const toolResults = await this.executeTools(response.toolCalls, tools);
  await session.ingestTickResult({ response, toolResults });
  session.advanceTick();
}
```

### Adapter Integration

The AI SDK adapter uses utilities for compilation and option merging:

```typescript
import { Runtime } from "tentickle/utils";
import { mergeDeep } from "tentickle/utils";

// Compilation
const service = new Runtime({ ... });
const result = await service.compile(jsx, input);

// Option merging
const providerOptions = mergeDeep<ProviderToolOptions>(
  {},
  toolDef.metadata.providerOptions || {},
  libraryProviderOptions || {},
);
```

---

## Summary

The utils module provides essential infrastructure for Tentickle:

- **`Runtime`** - Full-featured compilation with hooks, tools, MCP, and session management
- **`compileJSX`** - Simple compilation for basic use cases (deprecated)
- **`mergeAbortSignals`** - Combines multiple abort signals for cooperative cancellation
- **`isAbortError`** - Detects abort errors across different error formats
- **`mergeDeep`** - Recursively merges objects for configuration handling

The Engine delegates compilation to `Runtime`, keeping the Engine focused on model execution, tool handling, and event yielding while the service manages JSX compilation, component lifecycle, and state management.

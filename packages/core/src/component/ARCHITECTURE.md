# @agentick/core Component Architecture

> **The component model for Agentick agents**

The component module defines how Agentick agents are structured and executed. Components are the building blocks of agents, providing lifecycle management, state, and rendering capabilities. Like React components render to the DOM, Agentick components render to the Context Object Model (COM).

---

## Table of Contents

1. [Overview](#overview)
2. [Module Structure](#module-structure)
3. [Core Concepts](#core-concepts)
4. [Component Types](#component-types)
5. [Component Lifecycle](#component-lifecycle)
6. [Component Hooks Registry](#component-hooks-registry)
7. [Rendering to COM](#rendering-to-com)
8. [API Reference](#api-reference)
9. [Usage Examples](#usage-examples)
10. [React Comparison](#react-comparison)

---

## Overview

### What This Module Does

The component module provides:

- **Component Base Class** - `Component<P, S>` abstract class for stateful class components
- **EngineComponent Interface** - Contract for all component types (class, function, factory)
- **Lifecycle Hooks** - Mount, unmount, tick boundaries, message handling, error recovery
- **Component Hook Registry** - Middleware injection for component lifecycle methods
- **TickState** - Execution context passed through the component tree

### Why It Exists

Agentick agents need a structured way to:

1. **Compose behavior** - Build complex agents from smaller, reusable components
2. **Manage state** - Track component-local and shared state across ticks
3. **React to lifecycle events** - Initialize resources, handle messages, clean up
4. **Render context** - Transform component tree into model-consumable format
5. **Handle errors** - Provide recovery mechanisms for failures

### Design Principles

- **React-inspired** - Familiar patterns for React developers
- **Async-first** - All lifecycle methods can be async (no UI to freeze)
- **Tick-based** - Components operate within engine ticks, not continuous renders
- **JSX-compatible** - Components work with Agentick's custom JSX runtime
- **Composable** - Components can be nested, wrapped, and combined

---

## Module Structure

```
component/
├── component.ts           # Core types and Component base class
└── component-hooks.ts     # ComponentHookRegistry and utilities
```

### File Overview

| File                 | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `component.ts`       | Component base class, EngineComponent interface, TickState, lifecycle types |
| `component-hooks.ts` | ComponentHookRegistry for middleware, tag utilities                         |

---

## Core Concepts

### 1. EngineComponent Interface

The `EngineComponent` interface defines the contract all components must follow:

```typescript
interface EngineComponent {
  name?: string;
  tool?: ExecutableTool;

  // Lifecycle
  onMount?: (ctx: COM) => Promise<void> | void;
  onUnmount?: (ctx: COM) => Promise<void> | void;
  onStart?: (ctx: COM) => Promise<void> | void;
  onTickStart?: (ctx: COM, state: TickState) => Promise<void> | void;
  onAfterCompile?: (
    ctx: COM,
    compiled: CompiledStructure,
    state: TickState,
    ctx: AfterCompileContext,
  ) => Promise<void> | void;
  onTickEnd?: (ctx: COM, state: TickState) => Promise<void> | void;
  onComplete?: (ctx: COM, finalState: COMInput) => Promise<void> | void;
  onMessage?: (ctx: COM, message: ExecutionMessage, state: TickState) => Promise<void> | void;
  onError?: (ctx: COM, state: TickState) => Promise<RecoveryAction | void> | RecoveryAction | void;

  // Render
  render?: (
    ctx: COM,
    state: TickState,
  ) => Promise<void | JSX.Element | null> | void | JSX.Element | null;
}
```

### 2. TickState

`TickState` provides execution context to components during each tick:

```typescript
interface TickState {
  tick: number; // Current tick number (1-indexed)
  current?: COMOutput; // Model outputs from current tick
  timeline: COMTimelineEntry[]; // Session's full timeline (append-only source of truth)
  stopReason?: StopReasonInfo; // Why model stopped (if applicable)
  usage?: UsageStats; // Token usage from last model execution
  error?: EngineError; // Error info (if applicable)
  stop: (reason: string) => void; // Signal engine to stop
  queuedMessages: ExecutionMessage[]; // Messages since last tick
  channels?: ChannelService; // Bidirectional communication
}
```

### 3. Component Definition Types

Agentick supports multiple ways to define components:

```typescript
// Class component
type ComponentClass = new (props?: any) => EngineComponent;

// Factory function (returns instance)
type ComponentFactory = (props?: any) => EngineComponent | Promise<EngineComponent>;

// Pure function component (React-style or Engine-style)
type PureFunctionComponent<P = any> =
  | ((props: P) => JSX.Element | null)
  | ((props: P, ctx: COM, state: TickState) => JSX.Element | null);

// Any component definition
type ComponentDefinition =
  | EngineComponent // Instance
  | ComponentClass // Class
  | ComponentFactory // Factory
  | PureFunctionComponent // Function
  | JSX.Element; // Virtual element
```

---

## Component Types

### Function Components

Function components are the simplest form. They receive props and return JSX:

```tsx
// React-style (props only)
function Greeting(props: { name: string }) {
  return <User>Hello, {props.name}!</User>;
}

// Engine-style (props + COM access)
function StatefulGreeting(props: { name: string }, ctx: COM) {
  const count = ctx.getState<number>("visitCount") ?? 0;
  return (
    <User>
      Hello, {props.name}! Visit #{count}
    </User>
  );
}

// Full access (props + COM + TickState)
function TickAwareGreeting(props: { name: string }, ctx: COM, state: TickState) {
  return (
    <User>
      Hello on tick {state.tick}, {props.name}!
    </User>
  );
}
```

**Async function components** are supported (unlike React):

```tsx
async function DataComponent(props: { userId: string }) {
  const user = await fetchUser(props.userId);
  return <User>Data for {user.name}</User>;
}
```

### Class Components

Class components extend `Component<P, S>` for complex stateful logic:

```tsx
class ChatAgent extends Component<{ model: Model }, { messages: Message[] }> {
  static tags = ["chat", "agent"]; // For hook targeting
  static hooks = {
    onTickStart: [loggingMiddleware], // Static middleware
  };

  async onMount(ctx: COM) {
    // Initialize resources
    const history = await loadChatHistory();
    this.setState({ messages: history });
  }

  onTickStart(ctx: COM, state: TickState) {
    // Called before each tick
    console.log(`Starting tick ${state.tick}`);
  }

  render(ctx: COM, state: TickState): JSX.Element {
    return (
      <Fragment>
        <Model model={this.props.model} />
        <System>You are a helpful assistant.</System>
        {this.state.messages.map((msg, i) => (
          <Message key={i} role={msg.role}>
            {msg.content}
          </Message>
        ))}
      </Fragment>
    );
  }

  onComplete(ctx: COM, finalState: COMInput) {
    // Save conversation
    saveChatHistory(this.state.messages);
  }
}
```

### Component Base Class

The `Component<P, S>` abstract class provides:

```typescript
abstract class Component<P = {}, S = {}> implements EngineComponent {
  static hooks: Record<string, ComponentHookMiddleware<any>[]> = {};
  static tags: string[] = [];

  props: P;
  state: S;

  constructor(props: P = {} as P);

  // Instance hook registry
  get hooks(): ComponentHookRegistry;

  // Legacy state (prefer signals)
  setState(partial: Partial<S>): void;
  getState<T>(key: keyof S): T;

  // Lifecycle (override as needed)
  onMount(ctx: COM): void;
  onUnmount(ctx: COM): void;
  onStart(ctx: COM): void;
  onTickStart(ctx: COM, state: TickState): void;
  onAfterCompile(ctx, compiled, state, afterCompileCtx): void;
  onTickEnd(ctx: COM, state: TickState): void;
  onComplete(ctx: COM, finalState: COMInput): void;
  onError(ctx: COM, state: TickState): RecoveryAction | void;
  render(ctx, state): JSX.Element | null;
}
```

---

## Component Lifecycle

### Lifecycle Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Agentick Component Lifecycle                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  INITIALIZATION                                                              │
│  ───────────────                                                             │
│  ┌────────────┐                                                              │
│  │  onMount   │ ← Component added to tree (register tools, init resources)  │
│  └─────┬──────┘                                                              │
│        │                                                                     │
│        ▼                                                                     │
│  ┌────────────┐                                                              │
│  │  onStart   │ ← Before first tick (one-time initialization)               │
│  └─────┬──────┘                                                              │
│        │                                                                     │
│  ══════╪════════════════════════════════════════════════════════════════     │
│        │           TICK LOOP (repeats per tick)                              │
│  ══════╪════════════════════════════════════════════════════════════════     │
│        │                                                                     │
│        ▼                                                                     │
│  ┌──────────────┐                                                            │
│  │ onTickStart  │ ← Before render (react to current tick state)    │
│  └─────┬────────┘                                                            │
│        │                                                                     │
│        ▼                                                                     │
│  ┌────────────┐                                                              │
│  │   render   │ ← Return JSX tree (OR modify COM directly)                  │
│  └─────┬──────┘                                                              │
│        │                                                                     │
│        ▼                                                                     │
│  ┌───────────────────┐                                                       │
│  │  Compile to COM   │ ← Fiber compiler processes JSX → CompiledStructure   │
│  └─────┬─────────────┘                                                       │
│        │                                                                     │
│        ▼                                                                     │
│  ┌────────────────┐                                                          │
│  │ onAfterCompile │ ← Inspect compiled output, request recompile if needed  │
│  └─────┬──────────┘                                                          │
│        │                                                                     │
│        ▼                                                                     │
│  ┌───────────────────┐                                                       │
│  │  Model Execution  │ ← Engine sends to model, receives response            │
│  └─────┬─────────────┘                                                       │
│        │                                                                     │
│        ▼                                                                     │
│  ┌─────────────┐                                                             │
│  │  onTickEnd  │ ← After model execution (process outputs, validate)        │
│  └─────┬───────┘                                                             │
│        │                                                                     │
│        └──────────────────────────────────────────────────────────┐          │
│                                                                   │          │
│  ══════════════════════════════════════════════════════════════════╪═════    │
│                                                                   │          │
│        ┌──────────────────────────────────────────────────────────┘          │
│        ▼                                                                     │
│  ┌─────────────┐                                                             │
│  │ onComplete  │ ← After all ticks (persist state, cleanup)                 │
│  └─────┬───────┘                                                             │
│        │                                                                     │
│        ▼                                                                     │
│  ┌─────────────┐                                                             │
│  │  onUnmount  │ ← Component removed from tree (cleanup resources)          │
│  └─────────────┘                                                             │
│                                                                              │
│  ASYNC HOOKS (anytime during execution)                                      │
│  ───────────────────────────────────────                                     │
│  ┌─────────────┐                                                             │
│  │  onMessage  │ ← Immediately when message arrives via channel/handle      │
│  └─────────────┘                                                             │
│                                                                              │
│  ┌─────────────┐                                                             │
│  │   onError   │ ← When error occurs (return RecoveryAction to continue)    │
│  └─────────────┘                                                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Lifecycle Method Details

| Method           | When Called                   | Purpose                                       |
| ---------------- | ----------------------------- | --------------------------------------------- |
| `onMount`        | Component added to fiber tree | Register tools, initialize resources          |
| `onStart`        | Before first tick             | One-time setup after mount                    |
| `onTickStart`    | Start of each tick            | React to previous state, prepare for render   |
| `render`         | During tick, after tickStart  | Return JSX or modify COM directly             |
| `onAfterCompile` | After compile, before model   | Inspect compiled output, request recompile    |
| `onTickEnd`      | After model execution         | Process outputs, validation, side effects     |
| `onComplete`     | After all ticks complete      | Final persistence, reporting                  |
| `onUnmount`      | Component removed from tree   | Cleanup resources, cancel subscriptions       |
| `onMessage`      | Message received (anytime)    | Handle runtime messages immediately           |
| `onError`        | Error during execution        | Return RecoveryAction to continue or let fail |

### Error Recovery

Components can handle errors and optionally recover:

```typescript
interface RecoveryAction {
  continue: boolean; // Whether to continue execution
  recoveryMessage?: string; // Message to add explaining recovery
  modifications?: (ctx: COM) => void | Promise<void>;
}

class ResilientAgent extends Component {
  onError(ctx: COM, state: TickState): RecoveryAction {
    const error = state.error;

    if (error?.recoverable && error?.phase === "tool_execution") {
      return {
        continue: true,
        recoveryMessage: `Tool failed, continuing without result`,
        modifications: (ctx) => {
          ctx.setState("toolFailed", true);
        },
      };
    }

    // Let error propagate
    return { continue: false };
  }
}
```

---

## Component Hooks Registry

### Overview

The `ComponentHookRegistry` provides middleware injection for component lifecycle methods:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Component Hook Registry                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Middleware can be registered at multiple levels:                            │
│                                                                              │
│  1. Global (undefined selector)     → Applied to ALL components              │
│  2. Name-based (string)             → Applied to components with name        │
│  3. Tag-based ({ tags: [...] })     → Applied to components with any tag     │
│  4. Class-based (Function ref)      → Applied to specific class/function     │
│  5. Component-defined (static.hooks)→ Defined on component class itself      │
│                                                                              │
│  Resolution Order (most specific first):                                     │
│  component-defined → class-based → tag-based → name-based → global           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Hook Names

```typescript
type ComponentHookName =
  | "onMount"
  | "onUnmount"
  | "onStart"
  | "onTickStart"
  | "render"
  | "onAfterCompile"
  | "onTickEnd"
  | "onMessage"
  | "onComplete"
  | "onError";
```

### ComponentHookRegistry

```typescript
class ComponentHookRegistry extends BaseHookRegistry<
  ComponentHookName,
  ComponentSelector,
  ComponentHookMiddleware<ComponentHookName>
> {
  // Register for specific hook + selector
  register(hookName, selector, middleware): void;

  // Register for specific hook, all components
  register(hookName, middleware): void;

  // Register for all hooks, specific selector
  register(selector, middleware): void;

  // Register for all hooks, all components
  register(middleware): void;

  // Get middleware for component
  getMiddleware(hookName, componentClass, componentName, componentTags): Middleware[];
}
```

### Registration Examples

```typescript
const registry = new ComponentHookRegistry();

// Global: all components, all hooks
registry.register(async (args, envelope, next) => {
  console.log(`Hook: ${envelope.operationName}`);
  return next();
});

// All components, specific hook
registry.register("onTickStart", async (args, envelope, next) => {
  console.log("Tick starting for any component");
  return next();
});

// Specific class, all hooks
registry.register(ChatAgent, async (args, envelope, next) => {
  console.log("ChatAgent lifecycle event");
  return next();
});

// Tag-based, specific hook
registry.register("onTickEnd", { tags: ["logging"] }, async (args, envelope, next) => {
  console.log("Logging component tick end");
  return next();
});

// Name-based
registry.register("render", "TimelineManager", async (args, envelope, next) => {
  console.log("TimelineManager rendering");
  return next();
});
```

### Tag Utilities

```typescript
// Auto-generate tags from class name
autoGenerateTags(ChatAgent); // ['chat', 'agent']
autoGenerateTags(TimelineManager); // ['timeline', 'manager']

// Get component tags (explicit or auto-generated)
getComponentTags(ChatAgent); // Uses static.tags if defined, else auto-generates

// Get component name
getComponentName(instance, ChatAgent); // instance.name || ChatAgent.name
```

---

## Rendering to COM

### How Components Render

Components can render in two ways:

1. **Return JSX** - Fiber compiler processes the tree
2. **Modify COM directly** - For dynamic/imperative updates

```tsx
// JSX rendering (declarative)
class DeclarativeAgent extends Component {
  render(ctx: COM, state: TickState): JSX.Element {
    return (
      <Fragment>
        <Model model={this.props.model} />
        <System>You are helpful.</System>
        <User>{this.props.userInput}</User>
      </Fragment>
    );
  }
}

// Direct COM modification (imperative)
class ImperativeAgent extends Component {
  render(ctx: COM, state: TickState): void {
    ctx.pushToTimeline({
      kind: "message",
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
    });
    // Return void, not JSX
  }
}
```

### Fiber Compilation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Component to COM Pipeline                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Component Tree (JSX)                                                        │
│  ────────────────────                                                        │
│  <ChatAgent>                                                                 │
│    <Model model={gpt5} />                                                    │
│    <System>You are helpful.</System>                                         │
│    <User>{userInput}</User>                                                  │
│  </ChatAgent>                                                                │
│        │                                                                     │
│        ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                     Fiber Compiler                                   │     │
│  ├─────────────────────────────────────────────────────────────────────┤     │
│  │  1. Create fiber tree from JSX elements                              │     │
│  │  2. Instantiate class components, call function components           │     │
│  │  3. Execute component lifecycle hooks                                │     │
│  │  4. Process hooks (useState, useEffect, etc.)                        │     │
│  │  5. Traverse tree, extract content                                   │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│        │                                                                     │
│        ▼                                                                     │
│  CompiledStructure                                                           │
│  ─────────────────                                                           │
│  {                                                                           │
│    timelineEntries: [                                                        │
│      { kind: 'message', message: { role: 'system', content: [...] }},       │
│      { kind: 'message', message: { role: 'user', content: [...] }}          │
│    ],                                                                        │
│    sections: Map(...),                                                       │
│    tools: [...],                                                             │
│    ephemeral: [...],                                                         │
│    metadata: {...}                                                           │
│  }                                                                           │
│        │                                                                     │
│        ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                    Context Object Model (COM)                        │     │
│  ├─────────────────────────────────────────────────────────────────────┤     │
│  │  - timeline: COMTimelineEntry[]                                      │     │
│  │  - sections: Map<string, COMSection>                                 │     │
│  │  - tools: Map<string, ExecutableTool>                               │     │
│  │  - state: Map<string, unknown>                                       │     │
│  │  - refs: Map<string, unknown>                                        │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## API Reference

### component.ts

#### `Component<P, S>`

Abstract base class for stateful components:

```typescript
abstract class Component<P = {}, S = {}> implements EngineComponent {
  // Static properties (for hook targeting)
  static hooks: Record<string, ComponentHookMiddleware<any>[]> = {};
  static tags: string[] = [];

  // Instance properties
  props: P;
  state: S;
  get hooks(): ComponentHookRegistry;

  // Constructor
  constructor(props: P = {} as P);

  // State management (deprecated - use signals)
  setState(partial: Partial<S>): void;
  getState<T>(key: keyof S): T;

  // Lifecycle methods (all optional, override as needed)
  onMount(ctx: COM): void;
  onUnmount(ctx: COM): void;
  onStart(ctx: COM): void;
  onTickStart(ctx: COM, state: TickState): void;
  onAfterCompile(ctx, compiled, state, afterCompileCtx): void;
  onTickEnd(ctx: COM, state: TickState): void;
  onComplete(ctx: COM, finalState: COMInput): void;
  onError(ctx, state): RecoveryAction | void;
  render(ctx, state): JSX.Element | null;
}
```

#### `TickState`

Execution context for each tick:

```typescript
interface TickState {
  tick: number;
  current?: COMOutput;
  timeline: COMTimelineEntry[];
  stopReason?: StopReasonInfo;
  usage?: UsageStats;
  error?: EngineError;
  stop: (reason: string) => void;
  queuedMessages: ExecutionMessage[];
  channels?: ChannelService;
}
```

#### `StopReasonInfo`

Information about why execution stopped:

```typescript
interface StopReasonInfo {
  reason: string | StopReason;
  description?: string;
  recoverable?: boolean;
  metadata?: Record<string, unknown>;
}
```

#### `EngineError`

Error information for components:

```typescript
interface EngineError {
  error: Error;
  phase:
    | "render"
    | "model_execution"
    | "tool_execution"
    | "tick_start"
    | "tick_end"
    | "complete"
    | "unknown";
  context?: Record<string, unknown>;
  recoverable?: boolean;
}
```

#### `RecoveryAction`

Return from `onError` to control error handling:

```typescript
interface RecoveryAction {
  continue: boolean;
  recoveryMessage?: string;
  modifications?: (ctx: COM) => void | Promise<void>;
}
```

---

### component-hooks.ts

#### `ComponentHookRegistry`

Registry for component lifecycle middleware:

```typescript
class ComponentHookRegistry extends BaseHookRegistry<
  ComponentHookName,
  ComponentSelector,
  ComponentHookMiddleware<ComponentHookName>
> {
  // Get all middleware for a hook, ordered by specificity
  getMiddleware<T extends ComponentHookName>(
    hookName: T,
    componentClass: any,
    componentName: string,
    componentTags: string[],
  ): ComponentHookMiddleware<T>[];
}
```

#### `ComponentHookName`

```typescript
type ComponentHookName =
  | "onMount"
  | "onUnmount"
  | "onStart"
  | "onTickStart"
  | "render"
  | "onAfterCompile"
  | "onTickEnd"
  | "onMessage"
  | "onComplete"
  | "onError";
```

#### `ComponentSelector`

```typescript
type ComponentSelector =
  | string // Component name
  | { name?: string; tags?: string[] } // Selector object
  | Function // Component class/function reference
  | undefined; // Global
```

#### Utility Functions

```typescript
// Generate tags from component name
function autoGenerateTags(componentClass: any): string[];

// Get tags (explicit or auto-generated)
function getComponentTags(componentClass: any): string[];

// Get component name from instance or class
function getComponentName(instance: EngineComponent, componentClass: any): string;
```

---

## Usage Examples

### Basic Class Component

```tsx
import { Component } from "agentick";
import type { ContextObjectModel, TickState } from "agentick";

interface GreetingProps {
  name: string;
}

interface GreetingState {
  greetCount: number;
}

class GreetingAgent extends Component<GreetingProps, GreetingState> {
  static tags = ["greeting"];

  onMount(ctx: COM) {
    this.state = { greetCount: 0 };
  }

  onTickStart(ctx: COM, state: TickState) {
    this.setState({ greetCount: this.state.greetCount + 1 });
  }

  render(ctx: COM, state: TickState): JSX.Element {
    return (
      <Fragment>
        <Model model={myModel} />
        <System>You are a friendly greeter.</System>
        <User>
          Greet {this.props.name} (greeting #{this.state.greetCount})
        </User>
      </Fragment>
    );
  }
}
```

### Function Component with Hooks

```tsx
import { useSignal, useOnMount, useOnTickEnd } from "agentick";

function CounterAgent(props: { initialCount: number }) {
  const count = useSignal(props.initialCount);

  useOnMount((ctx) => {
    console.log("CounterAgent mounted");
  });

  useOnTickEnd((result) => {
    saveCount(count());
  });

  return (
    <Fragment>
      <Model model={myModel} />
      <System>You are a counting assistant. Current count: {count()}</System>
      <User>{props.query}</User>
    </Fragment>
  );
}
```

### Message Handling

```tsx
class InteractiveAgent extends Component {
  onMessage(ctx: COM, message: ExecutionMessage, state: TickState) {
    if (message.type === "stop") {
      ctx.abort("User requested stop");
    } else if (message.type === "feedback") {
      ctx.setState("userFeedback", message.content);
    } else if (message.type === "update_context") {
      ctx.setState("additionalContext", message.data);
    }
  }

  render(ctx: COM, state: TickState): JSX.Element {
    const feedback = ctx.getState<string>("userFeedback");

    return (
      <Fragment>
        <Model model={myModel} />
        {feedback && <Ephemeral>User feedback: {feedback}</Ephemeral>}
        <User>Continue the conversation</User>
      </Fragment>
    );
  }
}
```

### Component with Tools

```tsx
import { createTool } from "agentick";
import { z } from "zod";

const calculatorTool = createTool({
  name: "calculator",
  description: "Perform arithmetic calculations",
  schema: z.object({
    expression: z.string(),
  }),
  execute: async ({ expression }) => {
    return eval(expression).toString();
  },
});

class CalculatorAgent extends Component {
  static tool = calculatorTool; // Auto-registered on mount

  render(ctx: COM, state: TickState): JSX.Element {
    return (
      <Fragment>
        <Model model={myModel} />
        <Tool definition={calculatorTool} />
        <System>You can use the calculator tool for math.</System>
        <User>{this.props.query}</User>
      </Fragment>
    );
  }
}
```

### Error Recovery

```tsx
class ResilientAgent extends Component {
  onError(ctx: COM, state: TickState): RecoveryAction {
    const error = state.error;

    if (!error) {
      return { continue: false };
    }

    // Log the error
    console.error(`Error in ${error.phase}:`, error.error);

    // Retry for transient tool failures
    if (error.phase === "tool_execution" && error.recoverable) {
      const retryCount = ctx.getState<number>("retryCount") ?? 0;

      if (retryCount < 3) {
        return {
          continue: true,
          recoveryMessage: `Tool failed, retrying (attempt ${retryCount + 1})`,
          modifications: (ctx) => {
            ctx.setState("retryCount", retryCount + 1);
          },
        };
      }
    }

    // Don't recover for other errors
    return { continue: false };
  }
}
```

---

## React Comparison

### Similarities

| Feature             | React                | Agentick Components      |
| ------------------- | -------------------- | ------------------------ |
| Function components | Yes                  | Yes                      |
| Class components    | Yes                  | Yes (`Component<P,S>`)   |
| Props               | `props`              | `this.props`             |
| State               | `useState`           | `useSignal`, `setState`  |
| Effects             | `useEffect`          | `useEffect`, lifecycle   |
| Refs                | `useRef`             | `useRef`, `useCOMRef`    |
| Context             | `useContext`         | COM state, `useComState` |
| JSX                 | React JSX            | Agentick JSX             |
| Keys                | `key` prop           | `key` prop               |
| Fragments           | `<Fragment>` or `<>` | Same                     |

### Key Differences

| Aspect                | React                    | Agentick Components           |
| --------------------- | ------------------------ | ----------------------------- |
| **Async support**     | Requires Suspense        | Native async components/hooks |
| **Render target**     | DOM                      | Context Object Model (COM)    |
| **Lifecycle**         | Mount/unmount, effects   | Tick-based (tickStart/End)    |
| **Execution model**   | Continuous, event-driven | Tick-based, sequential        |
| **State persistence** | Component-local          | COM (shared), signals         |
| **Error handling**    | Error boundaries         | `onError` with RecoveryAction |
| **Message handling**  | N/A                      | `onMessage` hook              |
| **Middleware**        | N/A                      | ComponentHookRegistry         |
| **Component tags**    | N/A                      | Static `tags` for targeting   |
| **Render return**     | ReactElement             | JSX.Element or void           |

### Why These Differences?

1. **Async-first** - AI model calls are inherently async, no UI to freeze
2. **Tick-based** - AI agent execution happens in discrete ticks, not continuous renders
3. **COM persistence** - State needs to survive across model invocations
4. **Error recovery** - AI operations fail differently than UI rendering
5. **Message handling** - Real-time interaction during execution

---

## Summary

The component module provides the foundational building blocks for Agentick agents:

- **EngineComponent interface** defines the contract for all components
- **Component base class** provides stateful class components with lifecycle methods
- **Function components** offer simple, React-style composition
- **TickState** provides execution context to components
- **ComponentHookRegistry** enables middleware injection
- **Error recovery** via `RecoveryAction` for resilient agents

Components render to the Context Object Model (COM), transforming declarative JSX into the format consumed by AI models. The tick-based lifecycle aligns with agent execution patterns while maintaining familiar React-like patterns.

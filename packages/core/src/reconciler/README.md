# Agentick Reconciler

React-based reconciler for building LLM prompt trees. This is the foundation that enables JSX syntax for composing model inputs.

## Overview

Agentick uses `react-reconciler` to build a virtual tree from JSX components. This tree is then compiled into model-ready format (messages, tools, system prompt).

```
JSX Components → Reconciler → AgentickNode Tree → Compiler → ModelInput
```

## How It Works

The reconciler implements React's host config interface to build `AgentickNode` trees instead of DOM nodes:

```typescript
// JSX like this:
<>
  <System>You are helpful.</System>
  <Timeline />
  <MyTool />
</>

// Becomes a AgentickNode tree:
{
  type: Fragment,
  children: [
    { type: 'system', props: { children: 'You are helpful.' } },
    { type: Timeline, props: {} },
    { type: MyTool, props: {} },
  ]
}
```

## Key Exports

| Export                   | Description                         |
| ------------------------ | ----------------------------------- |
| `reconciler`             | The react-reconciler instance       |
| `createContainer()`      | Create a new render container       |
| `createRoot()`           | Create a fiber root for a container |
| `updateContainer()`      | Render elements into a container    |
| `flushSync()`            | Flush pending work synchronously    |
| `flushPassiveEffects()`  | Flush useEffect callbacks           |
| `getContainerChildren()` | Get rendered nodes from container   |

## Types

### AgentickNode

A node in the rendered tree:

```typescript
interface AgentickNode {
  type: AgentickNodeType; // Component type
  props: Record<string, unknown>;
  children: AgentickNode[];
  parent: AgentickNode | null;
  renderer: Renderer | null; // Inherited renderer context
  key: string | number | null;
  index: number;
}
```

### AgentickContainer

The root container:

```typescript
interface AgentickContainer {
  children: AgentickNode[];
  renderer: Renderer; // Default renderer (markdown/xml)
}
```

## React DevTools

Connect to standalone React DevTools for debugging:

```typescript
import { enableReactDevTools } from "@agentick/core/reconciler";

// Before creating sessions
enableReactDevTools(); // Connects to npx react-devtools on port 8097
```

## Internal Use

This module is primarily used internally by the session system. Most users interact with it indirectly through `createApp` and JSX components.

```typescript
// Internal flow (simplified):
const container = createContainer(markdownRenderer);
const root = createRoot(container);
updateContainer(<MyApp />, root);
flushSync(() => {});
flushPassiveEffects();
const nodes = getContainerChildren(container);
// nodes are then passed to the compiler
```

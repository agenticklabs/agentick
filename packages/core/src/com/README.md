# Context Object Model (COM)

The COM is the intermediate representation between JSX components and model input. Components render to the COM, which is then transformed into the format expected by AI models.

## Overview

```
JSX Components → Compiler → COM → Model Adapter → Provider API
```

The COM holds:

- **Timeline** - Conversation history (user, assistant, tool messages)
- **System** - System prompt content
- **Sections** - Named content blocks
- **Tools** - Available tool definitions
- **Ephemeral** - Transient per-tick content

## Accessing the COM

Use the `useCom` hook in components:

```typescript
import { useCom } from '@tentickle/core';

function MyComponent() {
  const ctx = useCom();

  // Read timeline
  const messages = ctx.timeline;

  // Read/write state
  const value = ctx.getState('myKey');
  ctx.setState('myKey', newValue);

  // Add content
  ctx.addSection({ id: 'context', content: 'Current time: ...' });

  return <Section id="info">...</Section>;
}
```

## Key Types

### COMInput

The full context state:

```typescript
interface COMInput {
  timeline: COMTimelineEntry[];       // Conversation messages
  system: COMTimelineEntry[];         // System prompt content
  sections: Record<string, COMSection>;
  tools: ToolDefinition[];
  ephemeral: EphemeralEntry[];        // Transient content
  metadata: Record<string, unknown>;
  modelOptions?: ModelConfig;
}
```

### COMTimelineEntry

A message in the timeline:

```typescript
interface COMTimelineEntry {
  message: Message & {
    content: SemanticContentBlock[];
  };
  timestamp?: string;
  metadata?: Record<string, unknown>;
}
```

### EphemeralEntry

Transient content rebuilt each tick (not persisted):

```typescript
interface EphemeralEntry {
  content: ContentBlock[];
  position: 'start' | 'end' | 'before-user' | 'after-system' | 'flow';
  type?: string;
  order?: number;
}
```

## COM Methods

| Method                     | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `getState(key)`            | Get shared state value                           |
| `setState(key, value)`     | Set shared state value                           |
| `addSection(section)`      | Add a named section                              |
| `removeSection(id)`        | Remove a section                                 |
| `addEphemeral(entry)`      | Add transient content                            |
| `setModel(model)`          | Set the active model                             |
| `requestRecompile(reason)` | Request tree recompilation                       |
| `spawn(agent, input)`      | Spawn a child session (requires session context) |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation on:

- COM lifecycle and state management
- Timeline vs ephemeral content
- Section visibility and audience
- Tick control (stop/continue)

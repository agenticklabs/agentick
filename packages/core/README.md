# @tentickle/core

Core engine for Tentickle. Provides the React-like reconciler, JSX components, and hooks for building LLM applications.

## Installation

```bash
pnpm add @tentickle/core
```

## Quick Start

```tsx
import { createApp, System, Timeline, Message, createTool } from "@tentickle/core";
import { createOpenAIModel } from "@tentickle/openai";
import { z } from "zod";

// Create a tool
const Calculator = createTool({
  name: "calculator",
  description: "Performs math calculations",
  input: z.object({ expression: z.string() }),
  handler: async ({ expression }) => {
    const result = eval(expression);
    return [{ type: "text", text: String(result) }];
  },
});

// Define your app
function MyApp() {
  return (
    <>
      <System>You are a helpful assistant with access to a calculator.</System>
      <Timeline />
      <Calculator />
    </>
  );
}

// Create and run
const app = createApp(MyApp, { model: createOpenAIModel() });
const session = await app.session();
await session.run({ message: "What is 2 + 2?" });
```

## JSX Components

### `<System>`

Define system instructions:

```tsx
<System>You are a helpful assistant.</System>
```

### `<Timeline>`

Render conversation history. This is the core component that represents the conversation:

```tsx
<Timeline />

// With custom rendering
<Timeline.Provider>
  <Timeline.Messages>
    {(messages) => messages.map(msg => <CustomMessage {...msg} />)}
  </Timeline.Messages>
</Timeline.Provider>
```

### `<Message>`

Add messages to the conversation:

```tsx
<Message role="user">Hello!</Message>
<Message role="assistant">Hi there!</Message>

// With content blocks
<Message role="user">
  <Text>Check this image:</Text>
  <Image source={{ type: "url", url: "https://..." }} />
</Message>
```

### `<Section>`

Group content with semantic meaning:

```tsx
<Section id="context" title="Current Context">
  Today is {new Date().toDateString()}.
  User is logged in as {user.name}.
</Section>
```

### `<Model>`

Override the model for a subtree:

```tsx
<Model id="gpt-4o-mini">
  {/* Children use gpt-4o-mini */}
</Model>
```

### `<Markdown>` / `<XML>`

Control output formatting:

```tsx
<Markdown>
  <Section id="rules">
    - Rule 1
    - Rule 2
  </Section>
</Markdown>

<XML>
  <Section id="data" title="User Data">
    {JSON.stringify(userData)}
  </Section>
</XML>
```

## Hooks

### State Hooks

```tsx
import { useState, useSignal, useComputed, useComState } from "@tentickle/core";

function MyComponent() {
  // React-style state
  const [count, setCount] = useState(0);

  // Signal-based reactive state
  const counter = useSignal(0);
  const doubled = useComputed(() => counter.value * 2);

  // COM state (persisted across ticks)
  const [notes, setNotes] = useComState<string[]>("notes", []);
}
```

### Lifecycle Hooks

```tsx
import { useTickStart, useTickEnd, useAfterCompile } from "@tentickle/core";

function MyComponent() {
  // Called at the start of each tick (before model call)
  useTickStart(() => {
    console.log("Tick starting...");
  });

  // Called at the end of each tick (after model response)
  useTickEnd(() => {
    console.log("Tick complete!");
  });

  // Called after JSX compiles but before model call
  useAfterCompile(() => {
    console.log("Compilation done");
  });
}
```

### Data Hooks

```tsx
import { useData, useInvalidateData } from "@tentickle/core";

function MyComponent() {
  // Fetch data with caching
  const { data, loading, error } = useData(
    "user-profile",
    async () => fetchUserProfile(),
    { ttl: 60000 }  // Cache for 1 minute
  );

  // Invalidate cached data
  const invalidate = useInvalidateData();
  const refresh = () => invalidate("user-profile");
}
```

### Context Hooks

```tsx
import { useCom, useTickState, useContextInfo } from "@tentickle/core";

function MyComponent() {
  // Access the Context Object Model
  const com = useCom();
  const history = com.timeline;

  // Access current tick state
  const tickState = useTickState();
  console.log(`Tick ${tickState.tick}`);

  // Access context utilization info (updated after each tick)
  const contextInfo = useContextInfo();
  if (contextInfo) {
    console.log(`Model: ${contextInfo.modelId}`);
    console.log(`Tokens: ${contextInfo.inputTokens} in / ${contextInfo.outputTokens} out`);
    console.log(`Utilization: ${contextInfo.utilization?.toFixed(1)}%`);
  }
}
```

## Context Utilization

The `useContextInfo` hook provides real-time information about model context usage:

```tsx
import { useContextInfo, type ContextInfo } from "@tentickle/core";

function ContextAwareComponent() {
  const contextInfo = useContextInfo();

  if (!contextInfo) {
    return <Section id="status">Waiting for first response...</Section>;
  }

  // Access model info
  const { modelId, modelName, provider } = contextInfo;

  // Access token usage
  const { inputTokens, outputTokens, totalTokens } = contextInfo;

  // Access utilization percentage
  const { utilization, contextWindow } = contextInfo;

  // Access capabilities
  const { supportsVision, supportsToolUse, isReasoningModel } = contextInfo;

  // Access cumulative usage across ticks
  const { cumulativeUsage } = contextInfo;

  // Make decisions based on context usage
  if (utilization && utilization > 80) {
    return <System>Be concise - context is running low.</System>;
  }

  return null;
}
```

### ContextInfo Interface

```typescript
interface ContextInfo {
  // Model identification
  modelId: string;           // "gpt-4o", "claude-3-5-sonnet", etc.
  modelName?: string;        // Human-readable name
  provider?: string;         // "openai", "anthropic", etc.

  // Context limits
  contextWindow?: number;    // Total context window size
  maxOutputTokens?: number;  // Max output tokens for model

  // Token usage (current tick)
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  // Utilization
  utilization?: number;      // Percentage (0-100)

  // Model capabilities
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  isReasoningModel?: boolean;

  // Execution info
  tick: number;              // Current tick number

  // Cumulative usage across all ticks
  cumulativeUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    ticks: number;
  };
}
```

### Using ContextInfoProvider (Advanced)

For custom setups, you can create and provide your own context info store:

```tsx
import { createContextInfoStore, ContextInfoProvider } from "@tentickle/core";

// Create a store
const contextInfoStore = createContextInfoStore();

// Provide to components
<ContextInfoProvider store={contextInfoStore}>
  <MyApp />
</ContextInfoProvider>

// Update the store
contextInfoStore.update({
  modelId: "gpt-4o",
  inputTokens: 1500,
  outputTokens: 500,
  totalTokens: 2000,
  tick: 1,
});

// Read current value
const current = contextInfoStore.current;
```

## Tools

Create tools the model can call:

```tsx
import { createTool } from "@tentickle/core";
import { z } from "zod";

const WeatherTool = createTool({
  name: "get_weather",
  description: "Get current weather for a location",
  input: z.object({
    location: z.string().describe("City name"),
    units: z.enum(["celsius", "fahrenheit"]).optional(),
  }),
  handler: async ({ location, units }) => {
    const weather = await fetchWeather(location, units);
    return [{ type: "text", text: JSON.stringify(weather) }];
  },
  // Optional: render state to model context
  render: () => (
    <Section id="weather-info">
      Last checked: {lastChecked}
    </Section>
  ),
});

// Use in your app
function App() {
  return (
    <>
      <System>You can check the weather.</System>
      <Timeline />
      <WeatherTool />
    </>
  );
}
```

## App & Session

### Creating an App

```tsx
import { createApp } from "@tentickle/core";

const app = createApp(MyApp, {
  model: myModel,
  devTools: true,  // Enable DevTools
});
```

### Session Management

```tsx
// Create a new session
const session = await app.session();

// Or get/create a specific session by ID
const session = await app.session("user-123");

// Run with input
const result = await session.run({
  message: { role: "user", content: "Hello!" },
});

// Check session state
const snapshot = session.snapshot();
console.log(snapshot.timeline);
console.log(snapshot.usage);
```

### Standalone Run

For one-off executions without session management:

```tsx
import { run, runComponent } from "@tentickle/core";

// Run a component directly
const result = await runComponent(
  <MyApp />,
  { message: "Hello!" },
  { model: myModel }
);

// Run with app configuration
const result = await run(MyApp, {
  input: { message: "Hello!" },
  model: myModel,
});
```

## DevTools Integration

Enable DevTools for debugging:

```tsx
const app = createApp(MyApp, {
  devTools: true,
  // or with remote DevTools
  devTools: {
    enabled: true,
    remote: true,
    remoteUrl: "http://localhost:3001/api/devtools",
  },
});
```

For debugging the reconciler itself with React DevTools:

```tsx
import { enableReactDevTools } from "@tentickle/core";

// Before creating sessions
enableReactDevTools();  // Connects to npx react-devtools on port 8097
```

## License

MIT

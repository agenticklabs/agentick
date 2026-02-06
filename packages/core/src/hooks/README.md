# Tentickle Hooks

React-like hooks for building agentic applications with Tentickle.

## Agent Loop Control

The most important hooks for agent development are the lifecycle hooks that control how your agent loops through ticks (model calls).

### useContinuation

The primary hook for implementing agent loops with custom termination conditions.

All callbacks receive data first, COM (context) last. Most callbacks only need the data parameter.

```tsx
import { useContinuation } from "@tentickle/core";

function MyAgent() {
  // Simple: continue until model outputs a done marker
  useContinuation((result) => !result.text?.includes("<DONE>"));

  // With control methods and reasons (for debugging/logging)
  useContinuation((result) => {
    if (result.text?.includes("<DONE>")) {
      result.stop("task-complete");
    } else if (result.tick >= 10) {
      result.stop("max-ticks-reached");
    } else {
      result.continue("still-working");
    }
  });

  // Access COM when needed (second parameter)
  useContinuation((result, ctx) => {
    ctx.setState("lastTick", result.tick);
    return !result.text?.includes("<DONE>");
  });

  return <Timeline />;
}
```

### TickResult

The `TickResult` object passed to continuation callbacks contains:

| Property            | Type                 | Description                            |
| ------------------- | -------------------- | -------------------------------------- |
| `tick`              | `number`             | Current tick number                    |
| `text`              | `string?`            | Combined text from assistant response  |
| `content`           | `ContentBlock[]`     | Raw content blocks from response       |
| `toolCalls`         | `ToolCall[]`         | Tool calls made this tick              |
| `toolResults`       | `ToolResult[]`       | Results from tool execution            |
| `stopReason`        | `string?`            | Model's stop reason (e.g., "end_turn") |
| `usage`             | `UsageStats?`        | Token usage statistics                 |
| `timeline`          | `COMTimelineEntry[]` | Timeline entries for this tick         |
| `stop(reason?)`     | `function`           | Request execution to stop              |
| `continue(reason?)` | `function`           | Request execution to continue          |

### Callback Return Values

The callback can influence continuation in three ways:

1. **Return boolean**: `true` = continue, `false` = stop
2. **Call methods**: `result.stop(reason?)` or `result.continue(reason?)`
3. **Return void**: Let default behavior apply (stop when no tool calls)

```tsx
// Boolean return
useContinuation((r) => !r.text?.includes("<DONE>"));

// Method calls with reasons
useContinuation((r) => {
  if (r.text?.includes("<DONE>")) r.stop("task-complete");
  else r.continue("working");
});

// Async verification
useContinuation(async (r) => {
  const verified = await verifyWithModel(r.text);
  return verified ? false : true; // stop if verified
});
```

## Common Agent Patterns

### Done Tool Pattern

Let the model explicitly signal completion by calling a tool:

```tsx
import { Tool, useContinuation } from "@tentickle/core";

function AgentWithDoneTool() {
  const [isDone, setIsDone] = useState(false);

  useContinuation(() => !isDone);

  return (
    <>
      <Tool
        name="done"
        description="Call this when the task is complete"
        input={z.object({
          summary: z.string().describe("Summary of what was accomplished")
        })}
        handler={async ({ summary }) => {
          setIsDone(true);
          return [{ type: "text", text: `Task complete: ${summary}` }];
        }}
      />
      <Timeline />
    </>
  );
}
```

### Token-Based Completion

Parse the model's response for a completion marker:

```tsx
function AgentWithDoneMarker() {
  useContinuation((result) => {
    // Look for done marker in response
    if (result.text?.includes("<DONE>") || result.text?.includes("TASK COMPLETE")) {
      result.stop("done-marker-found");
      return false;
    }

    // Continue if there are pending tool calls
    if (result.toolCalls.length > 0) {
      return true;
    }

    // Default: stop if model says it's done
    return result.stopReason !== "end_turn";
  });

  return <Timeline />;
}
```

### Async Verification

Use another model or external service to verify completion:

```tsx
function AgentWithVerification() {
  useContinuation(async (result) => {
    // Skip verification if no substantive response
    if (!result.text || result.toolCalls.length > 0) {
      return true;
    }

    // Verify with a cheaper/faster model
    const isComplete = await verifyCompletion(result.text);

    if (isComplete) {
      result.stop("verified-complete");
      return false;
    }

    result.continue("verification-pending");
    return true;
  });

  return <Timeline />;
}
```

### Max Ticks with Reason

Track why execution stopped:

```tsx
function AgentWithLimits() {
  useContinuation((result) => {
    if (result.tick >= 20) {
      result.stop("max-ticks-exceeded");
      return false;
    }

    if (result.usage && result.usage.totalTokens > 100000) {
      result.stop("token-budget-exceeded");
      return false;
    }

    return true;
  });

  return <Timeline />;
}
```

## Lifecycle Hooks

All lifecycle hooks follow the pattern: data first, COM (context) last.

### useOnMount

Run code when the component mounts:

```tsx
function AgentWithSetup() {
  useOnMount((ctx) => {
    console.log("Component mounted");
    ctx.setState("initialized", true);
  });

  return <Timeline />;
}
```

### useOnUnmount

Run code when the component unmounts:

```tsx
function AgentWithCleanup() {
  useOnUnmount((ctx) => {
    console.log("Component unmounting");
    // Cleanup resources
  });

  return <Timeline />;
}
```

### useOnTickStart

Run code at the start of each tick (before compilation):

```tsx
function AgentWithSetup() {
  useOnTickStart((tickState) => {
    console.log(`Tick ${tickState.tick} starting!`);
  });

  // With COM access
  useOnTickStart((tickState, ctx) => {
    ctx.setState("lastTickStart", tickState.tick);
  });

  return <Timeline />;
}
```

> **Note:** `useOnTickStart` uses `useEffect` internally, so the callback is registered _after_ the component's first render. This means:
>
> - **Tick 1**: Component mounts, effect queues callback registration
> - **Tick 2+**: Callback fires at tick start
>
> If you need code to run on the very first tick, use `useOnMount` or `useMemo` instead.

### useOnTickEnd

Lower-level hook for post-tick processing (useContinuation is built on this):

```tsx
function AgentWithTelemetry() {
  useOnTickEnd((result) => {
    // Log tick metrics
    analytics.track("tick_complete", {
      tick: result.tick,
      tokens: result.usage?.totalTokens,
      toolCalls: result.toolCalls.length,
    });

    // Don't affect continuation (return void)
  });

  return <Timeline />;
}
```

### useAfterCompile

Inspect compiled context before sending to model, optionally request recompilation:

```tsx
function AgentWithContextManagement() {
  useAfterCompile((compiled, ctx) => {
    // Estimate tokens
    const tokens = estimateTokens(compiled);

    if (tokens > MAX_CONTEXT_TOKENS) {
      // Summarize old messages
      summarizeOldMessages(ctx);
      ctx.requestRecompile("context-too-large");
    }
  });

  return <Timeline />;
}
```

## State Hooks

### useState

React's useState, re-exported for convenience:

```tsx
const [count, setCount] = useState(0);
const [state, dispatch] = useReducer(reducer, initial);
```

### useSignal

Reactive state that triggers recompilation on change:

```tsx
const count = useSignal(0);
const doubled = useComputed(() => count.value * 2);

// Update triggers recompile
count.value++;
```

### useComState

State stored in the COM, accessible to all components:

```tsx
function ComponentA() {
  const [value, setValue] = useComState("shared-key", "initial");
  // ...
}

function ComponentB() {
  const [value] = useComState("shared-key"); // Same value
  // ...
}
```

## Context Hooks

### useCom

Access the Context Object Model:

```tsx
const ctx = useCom();
ctx.addSection({ id: "context", content: "..." });
ctx.setState("key", value);
```

### useTickState

Access current tick information:

```tsx
const state = useTickState();
console.log(`Tick ${state.tick}`);
console.log(state.previous?.timeline); // Previous tick's output
```

## Message Hooks

### useOnMessage

React to incoming messages (for interactive agents):

```tsx
useOnMessage((message, ctx, state) => {
  if (message.type === "user") {
    console.log("User said:", message.content);
  }
});
```

### useQueuedMessages

Access messages queued for this tick:

```tsx
const messages = useQueuedMessages();
for (const msg of messages) {
  // Process queued messages
}
```

## Data Hooks

### useData

Fetch and cache data with dependency-based refresh:

```tsx
// Refetch when location changes
const weather = useData("weather", () => fetchWeather(location), [location]);

// Refetch every tick by including tick in deps
const { tick } = useTickState();
const status = useData("status", fetchStatus, [tick]);

// Cache forever (no deps)
const config = useData("config", fetchConfig);
```

## Priority System

When multiple components call `stop()` or `continue()`, the COM uses a priority system:

1. **Stop requests** take precedence over continue requests
2. **Higher priority** wins within each category (default priority: 0)
3. **Reasons** are preserved for debugging

```tsx
// High-priority stop (will override normal continues)
result.stop({ reason: "critical-error", priority: 100 });

// Normal priority continue
result.continue({ reason: "still-working", priority: 0 });
```

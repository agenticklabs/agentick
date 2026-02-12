# Hooks

Agentick hooks follow React conventions with AI-specific extensions. They manage state, lifecycle, and reactive behavior within agent components.

## State Hooks

### useState

Identical to React's `useState`. State persists across ticks within an execution.

```tsx
const [count, setCount] = useState(0);
```

### useSignal

Reactive signal — updates propagate without re-rendering the full component tree.

```tsx
const count = useSignal(0);
count.value++; // Triggers targeted update
console.log(count.value); // Current value
```

### useKnob

Creates model-visible, model-settable reactive state. See [Knobs](/docs/knobs) for full documentation.

```tsx
const [depth, setDepth] = useKnob("search_depth", 3, {
  min: 1,
  max: 10,
  description: "Number of results to analyze",
});
```

## Lifecycle Hooks

All lifecycle hooks follow the **"data first, ctx last"** convention.

### useOnMount

Runs once when the component first mounts (tick 1).

```tsx
useOnMount((ctx) => {
  console.log("Agent initialized");
});
```

### useOnTickStart

Runs at the start of each tick (tick 2+). Does NOT fire on the mount tick — use `useOnMount` for first-tick setup.

```tsx
useOnTickStart((tickState, ctx) => {
  console.log(`Starting tick ${tickState.tickNumber}`);
});
```

### useOnTickEnd

Runs after each tick completes (including the mount tick).

```tsx
useOnTickEnd((result, ctx) => {
  console.log(`Tick ended. Response: ${result.response}`);
});
```

### useAfterCompile

Runs after the compiler produces the model input, before the model call. Useful for inspection or telemetry.

```tsx
useAfterCompile((compiled, ctx) => {
  console.log(`Sending ${compiled.messages.length} messages`);
});
```

### useContinuation

Controls whether execution continues with another tick. See [Controlling the Tick Loop](#controlling-the-tick-loop) below.

```tsx
useContinuation((result, ctx) => {
  return result.hasToolUse && result.tickNumber < 10;
});
```

### useOnExecutionEnd

Runs once when execution completes (after all ticks finish). Fires before the session snapshot is persisted, so state changes here are captured cleanly. Always fires — even on abort or error.

```tsx
useOnExecutionEnd((ctx) => {
  console.log("Execution complete");
  ctx.setState("lastCompleted", Date.now());
});
```

### useOnMessage

Fires when a new message is added to the timeline.

```tsx
useOnMessage((message, ctx, state) => {
  if (message.role === "assistant") {
    logResponse(message.content);
  }
});
```

## Controlling the Tick Loop

An execution is a sequence of ticks. Each tick is one model API call. By default, execution continues when the model returns tool calls and stops when it returns a text response.

You control this with `useContinuation` and the `result.stop()` / `result.continue()` methods available on the `TickResult` object.

### Default behavior

No tool calls in response → stop. Tool calls in response → run tools, continue to next tick.

### `useContinuation`

Override the default with a boolean return or explicit control methods:

```tsx
// Simple: return boolean (true = continue, false = stop)
useContinuation((result, ctx) => {
  return result.hasToolUse && result.tickNumber < 10;
});

// Explicit: call stop/continue with reasons
useContinuation((result, ctx) => {
  if (result.text?.includes("<DONE>")) {
    result.stop("task-complete");
  } else {
    result.continue("still-working");
  }
});
```

### `result.stop()` and `result.continue()`

These methods are available on the `TickResult` passed to both `useContinuation` and `useOnTickEnd`. They accept an optional reason string or options object:

```tsx
result.stop("task-complete");
result.stop({ reason: "verified", status: "completed" });

result.continue("verification-pending");
result.continue({ reason: "retry", priority: 10 });
```

### Stopping from `useOnTickEnd`

You can also control the loop from `useOnTickEnd` — useful when you want to run side effects and control flow in the same callback:

```tsx
useOnTickEnd((result, ctx) => {
  // Log the result
  saveToDatabase(result.response);

  // Stop if the agent found what it was looking for
  if (result.response?.includes("FOUND")) {
    result.stop("target-found");
  }
});
```

### Tick limit

Set `maxTicks` on the input to cap the number of ticks per execution:

```tsx
await session.send({
  messages: [...],
  maxTicks: 5,  // Hard limit: stop after 5 ticks regardless
});
```

## Signature Reference

```typescript
useOnMount((ctx) => {});
useOnTickStart((tickState, ctx) => {});
useOnTickEnd((result, ctx) => {});
useAfterCompile((compiled, ctx) => {});
useOnExecutionEnd((ctx) => {});
useContinuation((result, ctx) => boolean);
useOnMessage((message, ctx, state) => {});
```

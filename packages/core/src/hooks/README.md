# Agentick Hooks

React-like hooks for building agentic applications with Agentick.

## Agent Loop Control

The most important hooks for agent development are the lifecycle hooks that control how your agent loops through ticks (model calls).

### useContinuation

The primary hook for implementing agent loops with custom termination conditions.

All callbacks receive data first, COM (context) last. Most callbacks only need the data parameter.

```tsx
import { useContinuation } from "@agentick/core";

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
import { Tool, useContinuation } from "@agentick/core";

function AgentWithDoneTool() {
  const [isDone, setIsDone] = useState(false);

  useContinuation(() => !isDone);

  return (
    <>
      <Tool
        name="done"
        description="Call this when the task is complete"
        input={z.object({
          summary: z.string().describe("Summary of what was accomplished"),
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

> **Timing:** `useOnTickStart` fires on every tick the component is alive, including the tick in which it mounts. Newly-mounted components receive a catch-up call after their first render.

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

### useOnExecutionEnd

Run code when execution completes (after all ticks, before snapshot persistence):

```tsx
function AgentWithCleanup() {
  useOnExecutionEnd((ctx) => {
    ctx.setState("lastCompleted", Date.now());
  });

  return <Timeline />;
}
```

> **Timing:** `useOnExecutionEnd` fires once per `send()` call, after the tick loop exits but before the session snapshot is persisted. State changes here are captured in the snapshot.

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

State stored in the COM, accessible to all components. Returns a Signal (not a tuple).
Automatically re-renders when state is modified externally (e.g. from a tool handler).

```tsx
function ComponentA() {
  const value = useComState("shared-key", "initial");
  console.log(value()); // or value.value — read current value
  value.set("updated"); // write new value
}

function ComponentB() {
  const value = useComState("shared-key", "initial"); // Same COM state
  return <Section id="info">Value: {value()}</Section>;
}
```

#### Snapshot Persistence

COM state entries are included in session snapshots by default. On restore, values are applied before the component tree renders, so `useComState` reads the persisted value instead of reinitializing.

Set `{ persist: false }` for transient state that shouldn't survive session restore:

```tsx
// Transient state — don't persist across sessions
const isExpanded = useComState("ui:expanded", false, { persist: false });
```

Values must be JSON-serializable. Non-serializable values are silently skipped during snapshot creation.

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
console.log(state.timeline); // Session's full timeline
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

## Timeline Hooks

### useTimeline

Direct read/write access to the session's timeline (the append-only source of truth):

```tsx
function MyAgent() {
  const timeline = useTimeline();

  // Read entries
  console.log(`${timeline.entries.length} messages in history`);

  // Replace entire timeline (e.g., after summarization)
  timeline.set([summaryEntry, ...recentEntries]);

  // Transform timeline via function
  timeline.update((entries) => entries.slice(-10)); // Keep last 10
}
```

The timeline is the session's complete conversation history. Use `<Timeline>` component props (`limit`, `maxTokens`, `roles`) for non-destructive context management. Use `useTimeline().set()` / `.update()` for destructive mutations (e.g., context compression with summarization).

### useConversationHistory

Read-only access to the full timeline, without needing a `<Timeline.Provider>`:

```tsx
function HistoryViewer() {
  const history = useConversationHistory();
  return <Section id="stats">Messages: {history.length}</Section>;
}
```

## Resolve Hooks

### useResolved

Access data loaded by the `resolve` configuration during session restore (Layer 2).

```tsx
function MyAgent() {
  const greeting = useResolved<string>("greeting");
  const userData = useResolved<User>("userData");

  return (
    <>
      {greeting && <System>{greeting}</System>}
      <Timeline />
    </>
  );
}
```

`useResolved` returns `undefined` for keys that weren't resolved (or when no resolve is configured). Results are set once during restore and are read-only thereafter.

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

#### Snapshot Persistence

`useData` cache entries are included in session snapshots by default. On restore, cached values are applied without re-fetching.

Set `{ persist: false }` to exclude large datasets, frequently-changing data, or values already stored elsewhere. These entries will re-fetch on restore as if the session were starting fresh.

```tsx
// Large data — re-fetch on restore instead of persisting
const embeddings = useData("embeddings", () => fetchEmbeddings(query), [query], { persist: false });
```

Values must be JSON-serializable. Non-serializable values (functions, circular references, etc.) are silently skipped during snapshot creation.

## Knobs

Knobs are model-visible, model-settable reactive state. Think of them as **form controls for models** — the same way HTML inputs bridge humans to application state, knobs bridge models to application state.

The model sees primitive values (string, number, boolean) and can change them via a `set_knob` tool. An optional resolve callback maps the primitive to a rich application value.

### knob() — Config-level Descriptor

Create a knob descriptor for use in config objects. Detected by `isKnob()`.

```tsx
import { knob } from "@agentick/core";

const config = {
  mode: knob("broad", { description: "Operating mode", options: ["broad", "deep"] }),
  model: knob("gpt-4", { description: "Model", options: ["gpt-4", "gpt-5"] }, (v) => openai(v)),
  citations: knob(true, { description: "Whether to include citations" }),
};
```

### useKnob() — Component-level Hook

Create a live knob inside a component. Returns `[value, setter]`.

```tsx
import { useKnob, Knobs } from "@agentick/core";

function Agent() {
  // Simple — mode is "broad" or "deep"
  const [mode, setMode] = useKnob("mode", "broad", {
    description: "Operating mode",
    options: ["broad", "deep"],
  });

  // With resolver — model sees "gpt-4", you get openai("gpt-4")
  const [model, setModel] = useKnob("model", "gpt-4", { description: "Model" }, (v) => openai(v));

  // From descriptor
  const desc = knob("broad", { description: "Mode", options: ["broad", "deep"] });
  const [modeFromDesc] = useKnob("mode", desc);

  return (
    <>
      <Knobs />
      <Model model={model} />
      <Section id="system" audience="model">
        Mode: {mode}
      </Section>
      <Timeline />
    </>
  );
}
```

### Type-Safe Constraints

Constraints are conditional on the value type:

```tsx
// Numbers: min, max, step
useKnob("temp", 0.7, { description: "Temperature", min: 0, max: 2, step: 0.1 });

// Strings: maxLength, pattern
useKnob("code", "abc", { description: "Code", maxLength: 10, pattern: "^[a-z]+$" });

// Booleans: no constraints (just a toggle)
useKnob("verbose", true, { description: "Verbose output" });

// All types: options, group, required, validate
useKnob("mode", "quick", {
  description: "Research depth",
  options: ["quick", "deep"],
  group: "Behavior",
  required: true,
  validate: (v) => (v !== "invalid" ? true : "Cannot use 'invalid'"),
});
```

Semantic types are inferred automatically: `[toggle]`, `[range]`, `[number]`, `[select]`, `[text]`.

### `<Knobs />` — Three Rendering Modes

The `<Knobs />` component always registers the `set_knob` tool. It provides three modes for rendering the knobs section:

#### Mode 1: Default rendering

Place `<Knobs />` in the tree. Renders a model-visible section with all knobs grouped and typed.

```tsx
function Agent() {
  useKnob("temp", 0.7, { description: "Temperature", group: "Model", min: 0, max: 2 });
  useKnob("mode", "quick", { description: "Depth", group: "Behavior", options: ["quick", "deep"] });
  useKnob("verbose", true, { description: "Verbose output" });

  return (
    <>
      <Knobs />
      <Timeline />
    </>
  );
}
```

Produces a section like:

```
verbose [toggle]: true — Verbose output

### Model
temp [range]: 0.7 — Temperature (0 - 2)

### Behavior
mode [select]: "quick" — Depth (options: "quick", "deep")
```

#### Mode 2: Render prop

Pass a function as children to control section rendering. Receives `KnobGroup[]`.

```tsx
function Agent() {
  useKnob("temp", 0.7, { description: "Temperature", group: "Model", min: 0, max: 2 });
  useKnob("mode", "quick", { description: "Depth", options: ["quick", "deep"] });

  return (
    <>
      <Knobs>
        {(groups) => (
          <Section id="my-knobs" audience="model">
            {groups
              .flatMap((g) => g.knobs)
              .map((k) => `${k.name}=${k.value}`)
              .join("\n")}
          </Section>
        )}
      </Knobs>
      <Timeline />
    </>
  );
}
```

The `set_knob` tool is still registered automatically. You control only the section output.

#### Mode 3: Provider + Context

Full custom rendering. `<Knobs.Provider>` registers the tool and exposes knob data via React context. Use `<Knobs.Controls />` or `useKnobsContext()` to consume.

```tsx
import { useKnobsContext, type KnobInfo, type KnobGroup } from "@agentick/core";

function MyKnobDisplay() {
  const { knobs, groups, get } = useKnobsContext();
  const temp = get("temp");
  return (
    <Section id="knobs" audience="model">
      Temperature: {temp?.value} | Total knobs: {knobs.length}
    </Section>
  );
}

function Agent() {
  useKnob("temp", 0.7, { description: "Temperature", min: 0, max: 2 });
  useKnob("mode", "quick", { description: "Depth", options: ["quick", "deep"] });

  return (
    <>
      <Knobs.Provider>
        <MyKnobDisplay />
      </Knobs.Provider>
      <Timeline />
    </>
  );
}
```

`<Knobs.Controls />` provides built-in rendering with optional customization:

```tsx
// Default section (same as <Knobs /> output)
<Knobs.Provider>
  <Knobs.Controls />
</Knobs.Provider>

// Custom per-knob rendering
<Knobs.Provider>
  <Knobs.Controls renderKnob={(knob) => (
    <Section id={`knob-${knob.name}`} audience="model">
      {knob.name}: {knob.value}
    </Section>
  )} />
</Knobs.Provider>

// Custom per-group rendering
<Knobs.Provider>
  <Knobs.Controls renderGroup={(group) => (
    <Section id={`group-${group.name || "default"}`} audience="model">
      {group.knobs.map(k => `${k.name}=${k.value}`).join(", ")}
    </Section>
  )} />
</Knobs.Provider>
```

### KnobInfo

Read-only snapshot of a knob, passed to render props and available via context:

| Field                  | Type                                                    | Description                       |
| ---------------------- | ------------------------------------------------------- | --------------------------------- |
| `name`                 | `string`                                                | Knob name                         |
| `description`          | `string`                                                | Human/model-readable summary      |
| `value`                | `string \| number \| boolean`                           | Current primitive value           |
| `defaultValue`         | `string \| number \| boolean`                           | Initial value                     |
| `semanticType`         | `"toggle" \| "range" \| "number" \| "select" \| "text"` | Inferred from value + constraints |
| `valueType`            | `"string" \| "number" \| "boolean"`                     | Primitive type                    |
| `group`                | `string?`                                               | Group name                        |
| `options`              | `(string \| number \| boolean)[]?`                      | Valid values (select/enum)        |
| `min`, `max`, `step`   | `number?`                                               | Number constraints                |
| `maxLength`, `pattern` | `string? / number?`                                     | String constraints                |
| `required`             | `boolean?`                                              | Whether value is required         |

### KnobsContextValue

Returned by `useKnobsContext()`:

| Field    | Type                                      | Description                     |
| -------- | ----------------------------------------- | ------------------------------- |
| `knobs`  | `KnobInfo[]`                              | All knobs (flat list)           |
| `groups` | `KnobGroup[]`                             | Knobs grouped; `""` = ungrouped |
| `get`    | `(name: string) => KnobInfo \| undefined` | Lookup a knob by name           |

### Hooks

| Hook                        | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `useKnobsContext()`         | Access knob context (throws outside `Knobs.Provider`) |
| `useKnobsContextOptional()` | Access knob context (returns null outside provider)   |

### Momentary Knobs

Momentary knobs auto-reset to their default value at the end of each execution. Use them for lazy-loaded context that the model expands on demand, with automatic token reclamation.

```tsx
import { knob, useKnob, Knobs } from "@agentick/core";

// Config-level descriptor
const planningWorkflow = knob.momentary(false, {
  description: "Account planning workflow",
});

// Or inline with useKnob
function Agent() {
  const [showPlanning] = useKnob("planning", false, {
    description: "Account planning workflow",
    momentary: true,
  });

  return (
    <>
      <Knobs />
      {showPlanning && (
        <Section id="planning" audience="model">
          ...
        </Section>
      )}
      <Timeline />
    </>
  );
}
```

Momentary knobs display as `[momentary toggle]` with a `(resets after use)` hint in the model-visible section. The model sets the knob to expand context, acts on it, and the knob resets at execution end — before the snapshot is persisted, so restored sessions start clean.

### When no knobs exist

All three modes render nothing when no knobs are registered — no tool, no section, no context. `<Knobs.Provider>` still renders its children (just without context).

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

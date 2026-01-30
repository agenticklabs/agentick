# Fiber Compiler Design: Tick-Based Agent Architecture

## Core Philosophy

This compiler is designed for **AI agent execution**, not UI rendering. This changes everything:

| Concern            | React (UI)                  | Tentickle (Agent)                   |
| ------------------ | --------------------------- | ----------------------------------- |
| **Timing**         | 60fps, can't block          | Tick-based, waiting is fine         |
| **Output**         | DOM mutations               | Data structures (CompiledStructure) |
| **Async**          | Effects after paint         | First-class async in all phases     |
| **Concurrency**    | Time-slicing to avoid jank  | Not needed - no jank                |
| **Suspense**       | Show fallback while loading | Wait for data, then proceed         |
| **Layout effects** | Before DOM paint            | N/A - no paint                      |

## Design Principles

1. **Async-first**: All hooks can be async. No need for useEffect dance.
2. **Tick-controlled**: Effects run in explicit phases (tickStart, render, tickEnd)
3. **Data-oriented**: Output is CompiledStructure, not DOM
4. **Waiting is okay**: We can pause for async work - no screen to freeze
5. **Non-rendering components**: Components can manage state without producing output

---

## Execution Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ENGINE TICK LOOP                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │  TICK START  │→ │    RENDER    │→ │   COMPILE    │→ │  TICK END   │  │
│  │              │  │              │  │   STABILIZE  │  │             │  │
│  │ useTickStart │  │ Component    │  │ (recompile   │  │ useTickEnd  │  │
│  │ effects run  │  │ render()     │  │  if needed)  │  │ effects run │  │
│  │              │  │ calls        │  │              │  │             │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐│
│  │                        MODEL EXECUTION                               ││
│  │  Send CompiledStructure to LLM, receive response, execute tools      ││
│  └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Phase Details

1. **Tick Start Phase**
   - `useTickStart` effects run
   - Class `onTickStart()` methods called
   - Good for: processing previous tick's output, updating state

2. **Render Phase**
   - Component `render()` / function bodies execute
   - `useState`, `useComState` values are read
   - JSX tree is built

3. **Compile Stabilization Phase**
   - JSX → CompiledStructure
   - `useAfterCompile` callbacks run
   - If `requestRecompile()` called, loop back to render
   - Max iterations prevent infinite loops

4. **Tick End Phase**
   - `useTickEnd` effects run
   - Class `onTickEnd()` methods called
   - Good for: side effects, logging, persistence

---

## Async Handling: No Suspense Needed

React needs Suspense because it can't block the render thread. We CAN wait.

### The `useAsync` Hook

Instead of Suspense's throw-and-catch pattern, we use a simpler approach:

```typescript
// Async hook that waits for data
function useAsync<T>(
  asyncFn: () => Promise<T>,
  deps: unknown[]
): { data: T | undefined; loading: boolean; error: Error | undefined }

// Usage
function DataComponent({ userId }) {
  const { data: user, loading, error } = useAsync(
    () => fetchUser(userId),
    [userId]
  );

  if (loading) return null;  // Component contributes nothing while loading
  if (error) throw error;    // Or handle gracefully

  return <Message role="system">User: {user.name}</Message>;
}
```

**Why this works for us:**

- We're not blocking a UI thread
- The tick can wait for all async work
- No fallback UI needed (there's no UI!)

### Async Effects

Effects CAN be async - we await them:

```typescript
useEffect(async () => {
  const data = await fetchSomething();
  setData(data);

  return () => {
    // cleanup can also be async
    await saveData(data);
  };
}, [deps]);
```

This is different from React where the effect callback can't be async.

---

## Non-Rendering Components

Components that manage state/effects but produce no output:

```tsx
// State manager - no render output
function TimelineManager() {
  const [timeline, setTimeline] = useComState('timeline', []);

  useTickStart((com, state) => {
    // Process model output from previous tick
    if (state.current?.timeline) {
      setTimeline(t => [...t, ...state.current.timeline]);
    }
  });

  // Returns null - doesn't contribute to CompiledStructure
  return null;
}

// Controller component - manages tick execution
function ExecutionController() {
  const [turnCount, setTurnCount] = useState(0);

  useTickEnd((com, state) => {
    setTurnCount(c => c + 1);

    if (turnCount >= 10) {
      state.stop('max turns reached');
    }
  });

  return null;
}

// Usage in agent
function MyAgent() {
  return (
    <>
      <TimelineManager />
      <ExecutionController />
      <SystemPrompt />
      <Timeline />
      <Tools />
    </>
  );
}
```

---

## Pure Content Blocks

Direct rendering of content block objects:

```tsx
function MyComponent() {
  return (
    <Message role="assistant">
      {/* JSX content components */}
      <Text>Hello, world!</Text>

      {/* Pure content blocks - passed through directly */}
      {{ type: 'text', text: 'Raw content block' }}
      {{ type: 'code', language: 'python', code: 'print("hello")' }}

      {/* Array of content blocks */}
      {[
        { type: 'text', text: 'Block 1' },
        { type: 'text', text: 'Block 2' },
      ]}
    </Message>
  );
}
```

The compiler detects these by shape and passes them through:

```typescript
function isContentBlock(value: unknown): value is ContentBlock {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    CONTENT_BLOCK_TYPES.includes((value as { type: string }).type)
  );
}
```

---

## Component Types

### 1. Function Components (with hooks)

```tsx
function ToolProvider({ tools }: { tools: Tool[] }) {
  // Local state
  const [enabled, setEnabled] = useState(true);

  // COM state
  const [toolCalls] = useComState('toolCalls', []);

  // Lifecycle
  useOnMount((com) => {
    tools.forEach(t => com.addTool(t));
  });

  useOnUnmount((com) => {
    tools.forEach(t => com.removeTool(t.name));
  });

  if (!enabled) return null;

  return (
    <Section id="tools">
      <Text>Available tools: {tools.map(t => t.name).join(', ')}</Text>
    </Section>
  );
}
```

### 2. Class Components (with signals)

```tsx
class ConversationManager extends Component {
  // Signals (existing pattern)
  private timeline = comState<Message[]>('timeline', []);
  private messageCount = signal(0);

  // Input signals
  private maxMessages = input<number>(100);

  async onTickStart(com: COM, state: TickState) {
    if (state.current?.timeline) {
      this.timeline.update(t => [...t, ...state.current.timeline]);
      this.messageCount.update(c => c + state.current.timeline.length);
    }
  }

  render() {
    const timeline = this.timeline();
    const max = this.maxMessages() ?? 100;

    // Truncate if needed
    const visible = timeline.slice(-max);

    return (
      <Timeline>
        {visible.map((msg, i) => (
          <Message key={i} role={msg.role}>
            {msg.content}
          </Message>
        ))}
      </Timeline>
    );
  }
}
```

### 3. Hybrid: Class with Hook-Like API

For those who want signals in functions, we provide a bridge:

```tsx
// Hook that creates a signal (persisted on fiber)
function useSignal<T>(initialValue: T): Signal<T> {
  const hook = mountOrUpdateHook(HookTag.Signal);

  if (hook.memoizedState === undefined) {
    hook.memoizedState = signal(initialValue);
  }

  return hook.memoizedState as Signal<T>;
}

// Usage
function Counter() {
  const count = useSignal(0);  // Full signal API

  return (
    <Section id="counter">
      <Text>Count: {count()}</Text>
      <Button onClick={() => count.update(c => c + 1)}>+</Button>
    </Section>
  );
}
```

---

## Why Not Concurrent Mode?

React's concurrent mode solves UI problems we don't have:

| React Problem                 | Our Situation                      |
| ----------------------------- | ---------------------------------- |
| Long renders freeze UI        | No UI to freeze                    |
| Need to prioritize user input | No user input during tick          |
| Time-slice to maintain 60fps  | No fps requirement                 |
| Interruptible rendering       | We want to complete, not interrupt |

**What we DO need:**

- Ability to abort execution (AbortController)
- Compile stabilization loop
- Async phase execution

We keep the **work loop** concept but remove time-slicing:

```typescript
// React: interruptible, time-sliced
while (workInProgress && !shouldYield()) {
  performUnitOfWork(workInProgress);
}

// Tentickle: complete the work
while (workInProgress) {
  await performUnitOfWork(workInProgress);  // Note: async!
}
```

---

## Effect Phases

Instead of React's:

- `useLayoutEffect` (sync, before paint)
- `useEffect` (async, after paint)

We have:

```typescript
// Phase-specific effects
useTickStart(callback);     // Before render, after previous tick
useAfterCompile(callback);  // After compile, can request recompile
useTickEnd(callback);       // After model execution
useEffect(callback, deps);  // General side effect, runs after commit

// Lifecycle effects
useOnMount(callback);       // Once, when component mounts
useOnUnmount(callback);     // Once, when component unmounts
```

Effect execution order in a tick:

```
1. useTickStart effects
2. Render (useState, useComState reads happen here)
3. Compile
4. useAfterCompile effects (may trigger recompile → back to 2)
5. [Model execution happens here]
6. useTickEnd effects
7. useEffect effects (general side effects)
```

---

## API Summary

### State Hooks

```typescript
// Local state (function components)
const [value, setValue] = useState<T>(initial);

// COM state (shared, persisted)
const [value, setValue] = useComState<T>(key, initial);

// Watch COM state (read-only)
const value = useWatch<T>(key, defaultValue);

// Signal in function component (full signal API)
const sig = useSignal<T>(initial);

// Computed (memoized derived value)
const derived = useMemo(() => computeExpensive(value), [value]);
```

### Effect Hooks

```typescript
// General effect (runs after commit)
useEffect(() => {
  // setup
  return () => { /* cleanup */ };
}, [deps]);

// Async effect (can await)
useEffect(async () => {
  const data = await fetch();
  // ...
  return async () => { /* async cleanup */ };
}, [deps]);

// Lifecycle
useOnMount((com) => { /* once on mount */ });
useOnUnmount((com) => { /* once on unmount */ });

// Tick phases
useTickStart((com, state) => { /* before render */ });
useTickEnd((com, state) => { /* after model execution */ });
useAfterCompile((com, compiled, state) => {
  // inspect compiled output
  // optionally: com.requestRecompile(reason);
});
```

### Async Data

```typescript
// Async data fetching
const { data, loading, error } = useAsync(() => fetchData(), [deps]);

// Cached async (dedupes requests)
const { data } = useCachedAsync(cacheKey, () => fetchData(), [deps]);
```

### Refs and Utilities

```typescript
// Mutable ref
const ref = useRef<T>(initial);

// COM ref (access other components)
const component = useCOMRef<MyComponent>('componentRef');

// Previous value
const prevValue = usePrevious(value);

// Callback (stable reference)
const callback = useCallback(() => { /* ... */ }, [deps]);
```

---

## Implementation Considerations

### 1. Hook State Storage

Hooks store state on the fiber node in a linked list:

```typescript
interface FiberNode {
  // For function components
  memoizedState: HookState | null;  // Head of linked list

  // For class components
  stateNode: ComponentInstance | null;  // The instance
}
```

### 2. Render Context

During render, a global context tracks the current fiber:

```typescript
let currentFiber: FiberNode | null = null;

function renderFunctionComponent(fiber, Component, props) {
  currentFiber = fiber;
  try {
    return Component(props, com, tickState);
  } finally {
    currentFiber = null;
  }
}

function useState(initial) {
  if (!currentFiber) throw new Error('useState outside render');
  // ... use currentFiber.memoizedState
}
```

### 3. Content Block Detection

Pure content blocks are detected and passed through:

```typescript
const CONTENT_BLOCK_TYPES = [
  'text', 'image', 'document', 'audio', 'video',
  'code', 'json', 'tool_use', 'tool_result', 'reasoning'
];

function processChild(child: unknown): FiberChild {
  if (isContentBlock(child)) {
    return { type: 'content-block', block: child };
  }
  if (isElement(child)) {
    return { type: 'element', element: child };
  }
  if (typeof child === 'string') {
    return { type: 'text', text: child };
  }
  // ...
}
```

### 4. Abort Handling

AbortController integration for cancellation:

```typescript
function useAbortSignal(): AbortSignal {
  const ctx = getCurrentContext();
  return ctx.abortController.signal;
}

// Usage
function DataFetcher() {
  const signal = useAbortSignal();

  useEffect(async () => {
    const data = await fetch(url, { signal });
    setData(data);
  }, [url]);
}
```

---

## Component Patterns

### Class Components

Class components use signals and lifecycle methods:

```typescript
class MyComponent extends Component {
  timeline = comState('timeline', []);

  onMount(com) { /* called once when component mounts */ }
  onTickStart(com, state) { /* called at start of each tick */ }
  render(com, state) { return <Section>...</Section>; }
}
```

### Function Components with Hooks

Function components use React-style hooks:

```typescript
function StatefulComponent(props) {
  const count = useSignal(0);
  const [shared, setShared] = useComState('shared', {});

  useOnMount((com) => { /* ... */ });

  useTickStart((com, state) => {
    count.update(c => c + 1);
  });

  return <Section>Count: {count()}</Section>;
}
```

### Engine Configuration

```typescript
const engine = createEngine({
  root: MyAgent,
  model: myModel,
  // ... other config
});
```

---

## File Structure

```
packages/core/src/compiler/
├── index.ts              # Public exports (re-exports hooks from ../state)
├── types.ts              # Type definitions (FiberNode, HookState, Effect, etc.)
├── fiber.ts              # Fiber node creation/management
├── fiber-compiler.ts     # Main FiberCompiler class
├── content-block-registry.ts  # JSX-to-ContentBlock mappers
├── extractors.ts         # Semantic node extraction from JSX
├── structure-renderer.ts # CompiledStructure to model-ready format
├── DESIGN.md             # This document
└── ARCHITECTURE.md       # Detailed architecture docs

packages/core/src/state/
├── hooks.ts              # All hook implementations (useState, useEffect, etc.)
├── signal.ts             # Signal/reactive primitives
└── use-state.ts          # State hook utilities
```

> **Note:** Hooks are in `state/hooks.ts` but re-exported from `compiler/index.ts` for API convenience.

---

## FAQ: Design Decisions

### Q: Should useEffect be async?

**Yes, in our model.** React's useEffect can't be async because:

1. It must return `undefined | cleanup` synchronously
2. React needs to know the cleanup function immediately
3. Async would block the render thread

We don't have these constraints:

```typescript
// React: Can't be async
useEffect(() => {
  fetchData().then(setData);  // Must wrap async
  return () => cleanup();     // Must be sync
}, []);

// Tentickle: Can be async
useEffect(async () => {
  const data = await fetchData();  // Direct await
  setData(data);
  return async () => {             // Cleanup can also be async
    await saveData(data);
  };
}, []);
```

**Why this works for us:**

- No render thread to block
- Tick loop can await effects
- Cleanup can be async (e.g., saving state to DB)

### Q: What about Suspense?

**We don't need it.** React Suspense solves a UI problem:

```
React's Problem:
1. Component needs data
2. Can't block render (would freeze UI)
3. Solution: Throw promise, show fallback, re-render when ready

Our Situation:
1. Component needs data
2. CAN block (no UI to freeze)
3. Solution: Just wait for the data
```

Instead of Suspense, we use `useAsync`:

```tsx
// React: Suspense pattern (complex)
const resource = createResource(fetchUser);
function Profile() {
  const user = resource.read();  // Throws promise!
  return <div>{user.name}</div>;
}
<Suspense fallback={<Loading />}>
  <Profile />
</Suspense>

// Tentickle: Simple async (no Suspense needed)
function Profile() {
  const { data: user, loading } = useAsync(() => fetchUser(), []);
  if (loading) return null;  // Just return nothing while loading
  return <Text>{user.name}</Text>;
}
```

### Q: Do we need concurrent mode?

**No.** React's concurrent mode solves:

- Time-slicing (avoid jank)
- Priority lanes (user input > background updates)
- Interruptible rendering

We don't have these needs:

- No UI = no jank
- No user input during render
- We WANT to complete rendering, not interrupt it

What we DO have:

- **AbortController** for cancellation
- **Compile stabilization** for recompile loops
- **Async phases** for waiting on async work

### Q: Can components be non-rendering?

**Absolutely.** A component that returns `null` is valid and useful:

```tsx
// State manager - no output
function TimelineManager() {
  const [timeline, setTimeline] = useComState('timeline', []);

  useTickStart((com, state) => {
    if (state.current?.timeline) {
      setTimeline(t => [...t, ...state.current.timeline]);
    }
  });

  return null;  // ← No output, just manages state
}

// Execution controller
function MaxTurnsGuard({ max }) {
  const [turns, setTurns] = useState(0);

  useTickEnd((com, state) => {
    setTurns(t => t + 1);
    if (turns >= max) state.stop('max turns');
  });

  return null;  // ← No output, just controls execution
}

// Tool provider
function ToolProvider({ tools }) {
  useOnMount((com) => {
    tools.forEach(t => com.addTool(t));
  });
  useOnUnmount((com) => {
    tools.forEach(t => com.removeTool(t.name));
  });

  return null;  // ← No output, just manages tools
}
```

### Q: How do pure content blocks work?

Content blocks can be rendered directly without JSX wrappers:

```tsx
function MyComponent() {
  return (
    <Message role="assistant">
      {/* JSX components */}
      <Text>Hello, world!</Text>

      {/* Pure content block object */}
      {{ type: 'text', text: 'I am a raw content block' }}

      {/* Code block */}
      {{ type: 'code', language: 'python', code: 'print("hi")' }}

      {/* Array of blocks */}
      {[
        { type: 'text', text: 'Block 1' },
        { type: 'text', text: 'Block 2' },
      ]}
    </Message>
  );
}
```

The compiler detects them by shape:

```typescript
const CONTENT_BLOCK_TYPES = ['text', 'image', 'code', 'document', ...];

function isContentBlock(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    CONTENT_BLOCK_TYPES.includes(value.type)
  );
}
```

### Q: Do class components still work?

**Yes, unchanged.** Class components with signals work exactly as before:

```tsx
class MyAgent extends Component {
  // Signals (component-local)
  private count = signal(0);

  // COM state (shared)
  private timeline = comState<Message[]>('timeline', []);

  // Input signals (from props)
  private maxTurns = input<number>(10);

  async onMount(com: COM) {
    // Setup
  }

  async onTickStart(com: COM, state: TickState) {
    if (state.current?.timeline) {
      this.timeline.update(t => [...t, ...state.current.timeline]);
    }
  }

  async onAfterCompile(com, compiled, state, ctx) {
    if (this.timeline().length > 100) {
      com.requestRecompile('timeline too long');
    }
  }

  render(com: COM, state: TickState) {
    return (
      <Timeline>
        {this.timeline().map((msg, i) => (
          <Message key={i} role={msg.role}>{msg.content}</Message>
        ))}
      </Timeline>
    );
  }
}
```

### Q: When to use function vs class components?

| Use Case                   | Recommended                  |
| -------------------------- | ---------------------------- |
| Simple stateless rendering | Function                     |
| Local state + effects      | Function with hooks          |
| Complex shared state       | Either (hooks or signals)    |
| Heavy lifecycle logic      | Class (cleaner organization) |
| Tool components            | Class (static tool property) |
| Quick prototyping          | Function (less boilerplate)  |

Both are first-class citizens. Use what feels right.

---

## Implementation Status

| Feature                  | Status         |
| ------------------------ | -------------- |
| Fiber tree structure     | ✅ Implemented |
| useState, useReducer     | ✅ Implemented |
| useEffect (async)        | ✅ Implemented |
| useComState, useWatch    | ✅ Implemented |
| useTickStart/End         | ✅ Implemented |
| useAfterCompile          | ✅ Implemented |
| useMemo, useCallback     | ✅ Implemented |
| useRef, useCOMRef        | ✅ Implemented |
| useAsync                 | ✅ Implemented |
| useSignal (bridge)       | ✅ Implemented |
| Class component support  | ✅ Implemented |
| Pure content blocks      | ✅ Implemented |
| Non-rendering components | ✅ Implemented |
| Compile stabilization    | ✅ Implemented |
| Structure collection     | ✅ Implemented |
| Engine integration       | ✅ Implemented |
| useOnMessage hook        | ✅ Implemented |
| Fork/Spawn model inherit | ✅ Implemented |
| Error boundaries         | 🔲 Todo        |
| DevTools integration     | 🔲 Todo        |

---

## Future Improvements

1. **Error Boundaries**: Error boundaries for component errors with recovery
2. **DevTools**: Fiber tree visualization for debugging tick flow
3. **Performance**: Optimize reconciliation for very large trees

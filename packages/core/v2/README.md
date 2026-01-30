# Tentickle V2

React-reconciler based implementation - **drop-in replacement** for v1.

## What Changed

The `FiberCompiler` now uses `react-reconciler` internally instead of a custom fiber implementation. Everything else stays the same.

| V1                          | V2                                       |
| --------------------------- | ---------------------------------------- |
| Custom fiber tree           | `react-reconciler`                       |
| Async components            | Sync components + `useData()`            |
| Custom hooks impl           | React's hooks + extensions               |
| ~1500 LOC fiber-compiler.ts | ~200 LOC wrapper around react-reconciler |

## Same API

```typescript
// Session uses FiberCompiler the same way
import { FiberCompiler } from "@tentickle/core/v2";

const compiler = new FiberCompiler(com, hookRegistry, config);
const result = await compiler.compileUntilStable(element, tickState);
```

## Component Changes

The main change for components is how async data is handled:

```tsx
// V1: Async component
const MyAgent = async ({ userId }) => {
  const user = await fetchUser(userId);
  return <Section>{user.name}</Section>;
};

// V2: Sync component with useData
const MyAgent = ({ userId }) => {
  const user = useData(`user-${userId}`, () => fetchUser(userId));
  return <Section>{user.name}</Section>;
};
```

The `useData` hook:

1. First render: throws a promise (like Suspense, but no fallback)
2. Compiler catches it, resolves the promise
3. Second render: returns the cached value

## Hooks Still Work

All your hooks work the same:

```tsx
const MyAgent = () => {
  const com = useCom();
  const state = useTickState();

  useTickStart(() => console.log("Tick starting"));
  useTickEnd(() => console.log("Tick done"));
  useAfterCompile((compiled) => {
    if (needsMore) com.requestRecompile();
  });

  const count = useSignal(0);

  return <Section id="main">...</Section>;
};
```

## Nested Renderers Still Work

```tsx
<Markdown>
  <Section id="instructions">
    <Text>Markdown here</Text>
  </Section>

  <XML>
    <Section id="structured">
      <Text>XML here</Text>
    </Section>
  </XML>
</Markdown>
```

## Data Caching

```tsx
// Cached forever (same key = same data)
const user = useData(`user-${id}`, () => fetchUser(id));

// Refetch every tick
const status = useData('status', fetchStatus, { refetchEveryTick: true });

// Refetch when deps change
const data = useData('data', fetchData, { deps: [filter] });
```

## Session Isolation

Each `FiberCompiler` instance has its own isolated `RuntimeStore`. This means:

- Multiple sessions can run concurrently without sharing state
- Data caches, lifecycle callbacks, and pending fetches are per-session
- No global state pollution between sessions

```typescript
const compiler1 = new FiberCompiler(com1); // Has its own RuntimeStore
const compiler2 = new FiberCompiler(com2); // Completely isolated
```

## Session Hibernation

V2 supports serializing and restoring session state for persistence:

```typescript
import { hibernate, hydrate, FiberCompiler, type SessionSnapshot } from "@tentickle/core/v2";

// Hibernate a session (serialize)
const snapshot = hibernate(compiler, {
  sessionId: session.id,
  tick: session.currentTick,
  timeline: session.timeline,
  comState: session.com.state,
});

// Save to storage
await db.sessions.save(session.id, JSON.stringify(snapshot));

// Later: restore from storage
const json = await db.sessions.get(sessionId);
const snapshot = JSON.parse(json) as SessionSnapshot;

// Create new compiler and hydrate
const compiler = new FiberCompiler(com);
const state = hydrate(compiler, snapshot);

// Apply restored state to session
session.timeline = state.timeline;
session.currentTick = state.tick;
// etc.
```

Key insight: We don't serialize React's fiber tree (which is an implementation
detail). We serialize **our** state (data cache, COM state, timeline), and when
we hydrate, React rebuilds its tree from scratch. Since our hooks read from
our restored caches, the render produces the same output.

## Why V2?

1. **Less code to maintain** - React handles reconciliation
2. **Battle-tested** - React's diffing algorithm is proven
3. **Familiar** - Standard React patterns
4. **Session persistence** - Built-in hibernation/hydration
5. **DevTools potential** - Could integrate with React DevTools

## File Structure

```
v2/src/
├── compiler/
│   ├── fiber-compiler.tsx   # Drop-in replacement
│   ├── collector.ts         # Tree → CompiledStructure
│   └── types.ts
├── reconciler/
│   ├── host-config.ts       # react-reconciler config
│   └── reconciler.ts        # Reconciler instance
├── hooks/
│   ├── context.tsx          # useCom, useTickState
│   ├── runtime-context.tsx  # RuntimeStore (per-session isolation)
│   ├── lifecycle.ts         # useTickStart, useTickEnd
│   ├── data.ts              # useData
│   └── signal.ts            # useSignal
├── hibernation/
│   └── index.ts             # hibernate(), hydrate()
├── components/              # Same as v1
├── renderers/               # Same as v1
└── index.ts
```

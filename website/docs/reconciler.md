# The Reconciler

Agentick is a custom React renderer. Like React Native renders to mobile views and React Three Fiber renders to a WebGL scene, agentick renders to model context.

## Why a Reconciler?

When you write:

```tsx
function Agent() {
  const [phase, setPhase] = useState("research");

  return (
    <>
      <System>You are in {phase} mode.</System>
      {phase === "research" ? <SearchTools /> : <WritingTools />}
      <Timeline />
    </>
  );
}
```

The reconciler handles:
- **Mounting** `<SearchTools />` on first render, registering its tools
- **Unmounting** `<SearchTools />` when phase changes, deregistering tools
- **Mounting** `<WritingTools />` in its place, registering new tools
- **Updating** the system prompt text
- **Preserving** the `<Timeline />` across both renders (identity-stable)

Without a reconciler, you'd manage tool registration manually, rebuild prompt strings on every change, and track component identity yourself. The reconciler automates all of this.

## Fiber Tree

Every component instance becomes a **fiber** — a node in a linked tree. The fiber stores:
- Component function reference
- Props and state
- Child/sibling/parent links
- Effect hooks and cleanup functions

```
<Agent>                          ← Root fiber
├── <System>                     ← Intrinsic fiber (renders to system prompt)
├── <SearchTools>                ← Component fiber (user-defined)
│   ├── <Tool name="search">    ← Intrinsic fiber (registers tool)
│   └── <Section>               ← Intrinsic fiber (renders to context)
└── <Timeline>                  ← Intrinsic fiber (renders messages)
```

## Compile Cycle

Each tick runs this cycle:

1. **Reconcile** — diff the fiber tree against previous render, apply updates
2. **Compile** — walk the tree, collect system prompt, sections, tools, messages
3. **Stabilize** — if any state changed during compile, reconcile and compile again
4. **Output** — produce the `CompiledStructure` sent to the model adapter

The "compile until stable" loop handles cascading state updates — a hook that runs during compile can trigger another render, which triggers another compile, until the tree settles.

## Intrinsic Elements

Like React's `<div>` and `<span>`, agentick has intrinsic elements that compile to model context:

| Element | Compiles To |
|---------|------------|
| `<System>` | System prompt |
| `<Section>` | Context block |
| `<Tool>` | Tool registration |
| `<Timeline>` | Message history |
| `<Message>` | Single message |
| `<Knobs>` | Knob section + set_knob tool |

Custom components (`<MyAgent>`, `<SearchTools>`) are transparent to the compiler — they're just function calls that return intrinsic elements.

## Comparison to React

| Concept | React | Agentick |
|---------|-------|----------|
| Tree type | DOM elements | Model context |
| Output | HTML/Native views | Compiled prompt structure |
| Trigger | User events | Tick lifecycle |
| Effects | `useEffect` | `useOnMount`, `useOnTickEnd`, etc. |
| Re-render | State change → diff → DOM patch | State change → diff → recompile |
| Refs | DOM nodes | N/A |
| Portals | Different DOM trees | N/A |
| Suspense | Loading boundaries | N/A (yet) |

The main difference from React DOM is the output target. Instead of DOM mutations, agentick produces a compiled context structure for the model. Everything else — fibers, work loops, hooks, effects — works the way you'd expect from React.

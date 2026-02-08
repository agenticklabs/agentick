# Why JSX?

The most common reaction to agentick: "Why would you use JSX for AI agents?"

## The short answer

JSX is not about HTML. It's syntax for composing tree structures with embedded expressions. React uses it for UI trees. Agentick uses it for **context trees** — the structured prompt that an LLM receives.

An agent's context has the same properties as a UI:
- **Conditional rendering**: show different tools in different phases
- **Composition**: combine small, reusable pieces into complex behavior
- **Reactivity**: state changes should propagate automatically
- **Lifecycle**: components mount, update, unmount — and side effects happen at each stage

## What JSX gets you

### Composition

```tsx
// Reusable component
function ResearchTools({ maxResults = 5 }) {
  return (
    <>
      <WebSearch maxResults={maxResults} />
      <ReadPage />
      <SummarizeContent />
    </>
  );
}

// Compose into agents
function ResearchAgent() {
  return (
    <>
      <System>You are a research assistant.</System>
      <ResearchTools maxResults={10} />
      <Timeline />
    </>
  );
}
```

No "tool registry" to manage. No ID-based references. Just components composing.

### Conditional rendering

```tsx
function Agent({ userTier }: { userTier: string }) {
  return (
    <>
      <System>You are a helpful assistant.</System>
      <BasicTools />
      {userTier === "pro" && <ProTools />}
      {userTier === "enterprise" && <EnterpriseTools />}
      <Timeline />
    </>
  );
}
```

When `userTier` changes, tools mount/unmount automatically. The reconciler handles registration and deregistration.

### State + Context coupling

```tsx
function Agent() {
  const [mode, setMode] = useKnob("mode", "helpful");

  return (
    <>
      <System>Respond in a {mode} tone.</System>
      <Tool
        name="set_mode"
        description="Change response mode"
        input={z.object({ mode: z.string() })}
        handler={({ mode }) => { setMode(mode); return "Mode updated."; }}
      />
      <Timeline />
    </>
  );
}
```

When the model calls `set_mode`, the state updates, the system prompt re-renders, and the model sees the new prompt on the next tick. The state and the context that depends on it are colocated — exactly like React.

## The real reason

The JSX is optional. You can use `createAgent({ ... })` with a config object and never write a single `<>` fragment. Under the hood, it still runs through the reconciler.

The real reason is simpler than it sounds: **managing an agent's context is a UI problem.** What the model sees changes over time, reacts to state, composes from parts. React already solved this. Agentick just points it at a different render target.

You know React. The only new things are the domain-specific primitives: `<Tool>`, `<Timeline>`, `<Section>`, `useKnob`. Everything else is the React you already write.

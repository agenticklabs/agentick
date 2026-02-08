# What is agentick?

Agentick is React for model interfaces. React renders UI for humans via the DOM. Agentick renders context for models via a compiler. Same reconciler, same component model, different render target.

## The Problem

Every agent framework gives you some way to define "what the model sees": a system prompt, tools, conversation history. The hard part isn't defining these things once — it's managing them reactively as the conversation evolves.

- A tool handler updates shared state. Other tools need to see the change.
- The system prompt depends on runtime configuration the model can adjust.
- Different conversation phases need different tool sets, different context sections.
- Multiple components need to coordinate without knowing about each other.

Sound familiar? These are the same problems React solved for UIs a decade ago.

## The Solution

Your agent is a React app. Function components define what the model sees. The reconciler diffs the tree, the compiler produces model-ready context, and hooks manage lifecycle.

```tsx
function MyAgent() {
  const [phase, setPhase] = useState<"research" | "write">("research");

  return (
    <>
      <System>You are a {phase === "research" ? "researcher" : "writer"}.</System>
      {phase === "research" && <SearchTool />}
      {phase === "write" && <WritingTools />}
      <Tool
        name="switch_phase"
        description="Switch to writing mode"
        input={z.object({})}
        handler={() => { setPhase("write"); return "Switched."; }}
      />
      <Timeline />
    </>
  );
}
```

When `setPhase("write")` fires, `<SearchTool />` unmounts (its tool deregisters), `<WritingTools />` mounts (its tools register), and the system prompt updates. The model sees the new context on the next tick. Standard React behavior — just a different render target.

## Key Concepts

| Concept | What it is |
|---------|-----------|
| **Session** | Long-lived conversation context. Manages identity, state, persistence. |
| **Execution** | One user message → model response cycle. Contains one or more ticks. |
| **Tick** | One model API call. Tool use creates multi-tick executions. |
| **Fiber tree** | Virtual DOM-like component hierarchy defining model context. |
| **Reconciler** | Diffs the fiber tree, manages component lifecycle. |
| **Compiler** | Transforms fiber tree → model-ready prompt structure. |

## What it's not

- **Not a hosted service.** Agentick is a library. Your code, your infra.
- **Not a graph DSL.** No nodes, edges, or visual builders. Components compose.
- **Not opinionated about models.** Adapters for OpenAI, Google, Vercel AI SDK. Bring your own.
- **Not a prompt template engine.** The reconciler manages context reactively, not string interpolation.

## Next

[Getting Started →](/docs/getting-started)

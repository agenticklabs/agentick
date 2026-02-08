# DevTools

Agentick DevTools let you inspect running agents in real-time — fiber tree, timeline, component state, tool calls.

## Enable DevTools

```tsx
const result = await app.run({
  devTools: true,
  messages: [{ role: "user", content: "Hello!" }],
}).result;
```

Or per-session:

```tsx
const session = await app.session({
  id: "debug-session",
  devTools: true,
});
```

## What You Can Inspect

- **Fiber Tree**: The full component hierarchy, updated in real-time
- **Component State**: `useState`, `useKnob` values for each component
- **Timeline**: All messages, tool calls, and tool results
- **Compiled Context**: The exact prompt sent to the model
- **Execution Flow**: Tick-by-tick execution trace

## Debugging Tips

### Component shows as `<Unknown>`

Add `displayName` to function components:

```tsx
function MyAgent() { ... }
MyAgent.displayName = "MyAgent";
```

### System tokens showing as 0

Verify `<System>` or `<Section>` components are in the tree.

### Fiber tree not updating

Snapshots are taken at tick end. Verify `tick_end` events are being emitted.

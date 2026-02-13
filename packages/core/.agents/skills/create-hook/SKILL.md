---
name: create-hook
description: Create a new agentick lifecycle hook or custom hook. Use when asked to add a hook, create reactive behavior, or implement lifecycle logic.
---

# Create a Hook

Agentick hooks follow React conventions — they're functions starting with `use` that compose state and lifecycle behavior.

## Existing Hooks

Before creating a new hook, check if an existing one covers your use case:

| Hook              | Purpose                                      |
| ----------------- | -------------------------------------------- |
| `useState`        | Local state (standard React)                 |
| `useEffect`       | Side effects (standard React)                |
| `useSignal`       | Reactive signal state                        |
| `useKnob`         | Model-visible, model-settable reactive state |
| `useOnMount`      | Run once on first tick                       |
| `useOnUnmount`    | Cleanup on component removal                 |
| `useOnTickStart`  | Run at start of tick 2+                      |
| `useOnTickEnd`    | Run at end of every tick                     |
| `useContinuation` | Control whether execution continues          |
| `useAfterCompile` | Run after each compilation                   |
| `useOnMessage`    | React to individual messages                 |
| `useComState`     | Subscribe to COM state changes               |
| `useData`         | Reactive data cache with serialization       |

## Steps

1. Create the hook file in `packages/core/src/hooks/`:

```typescript
// packages/core/src/hooks/my-hook.ts
import { useState, useEffect } from "react";
import { useCom } from "./context";

export function useMyHook(initialValue: string) {
  const ctx = useCom();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    // Setup logic
    return () => {
      // Cleanup logic
    };
  }, []);

  return [value, setValue] as const;
}
```

2. Export from the hooks index:

```typescript
// packages/core/src/hooks/index.ts
export { useMyHook } from "./my-hook";
```

3. Re-export from core's public API if it should be user-facing:

```typescript
// packages/core/src/index.ts — add to the hooks re-exports
export { useMyHook } from "./hooks";
```

## Lifecycle Hook Signatures

All lifecycle callbacks follow "data first, ctx last":

```typescript
useOnMount((ctx) => {});
useOnTickStart((tickState, ctx) => {});
useOnTickEnd((result, ctx) => {});
useAfterCompile((compiled, ctx) => {});
useContinuation((result, ctx) => boolean | void); // result.shouldContinue shows framework default
useOnMessage((message, ctx, state) => {});
```

## Accessing COM

```typescript
import { useCom } from "./context";

export function useMyHook() {
  const ctx = useCom();
  // ctx.setState(key, value) — persist to session
  // ctx.getState(key) — read from session
  // ctx.emit(event, data) — emit events
}
```

## Key Files

- All hooks: `packages/core/src/hooks/`
- Hook index: `packages/core/src/hooks/index.ts`
- Lifecycle hooks: `packages/core/src/hooks/lifecycle.ts`
- Signal hooks: `packages/core/src/hooks/signal.ts`
- Knob hooks: `packages/core/src/hooks/knob.ts`
- COM context: `packages/core/src/hooks/context.ts`

## Testing

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createApp } from "@agentick/core";
import { createTestAdapter, renderAgent, cleanup } from "@agentick/core/testing";

describe("useMyHook", () => {
  afterEach(() => cleanup());

  it("works in a component", async () => {
    const adapter = createTestAdapter({ defaultResponse: "ok" });

    function TestAgent() {
      const [val] = useMyHook("initial");
      return (
        <>
          <Model model={adapter} />
          <System>Value: {val}</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(TestAgent);
    const result = await app.run({
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    }).result;

    expect(result).toBeDefined();
  });
});
```

After creating, run:

```bash
pnpm --filter @agentick/core typecheck
pnpm --filter @agentick/core test
```

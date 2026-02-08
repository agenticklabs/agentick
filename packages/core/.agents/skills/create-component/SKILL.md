---
name: create-component
description: Create a new agentick JSX component. Use when asked to add a component, create a UI primitive, or build a reusable agent building block.
---

# Create a JSX Component

Agentick components are React components. They render to the fiber tree, and the compiler transforms the tree into model context.

## Component Types

1. **Structural** — renders intrinsic elements (`<message>`, `<section>`, `<tool>`, `<entry>`)
2. **Semantic** — renders content primitives (`<H1>`, `<List>`, `<Table>`)
3. **Configuration** — sets up state/config, returns Fragment
4. **Composite** — composes other components

## Steps

1. Create the component in `packages/core/src/jsx/components/`:

```tsx
// packages/core/src/jsx/components/my-component.tsx
import React, { useEffect, useDebugValue } from "react";
import { useCom } from "../../hooks/context";
import type { ComponentBaseProps } from "./index";

export interface MyComponentProps extends ComponentBaseProps {
  title: string;
  children?: React.ReactNode;
}

export function MyComponent({ title, children }: MyComponentProps) {
  const ctx = useCom();
  useDebugValue("MyComponent");

  return (
    <section id={`my-${title}`}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

MyComponent.displayName = "MyComponent";
```

2. Export from the components index:

```typescript
// packages/core/src/jsx/components/index.ts
export { MyComponent } from "./my-component";
export type { MyComponentProps } from "./my-component";
```

3. Re-export from core if it should be public:

```typescript
// packages/core/src/index.ts
export { MyComponent } from "./jsx/components";
```

## Intrinsic Elements

These are the low-level elements the reconciler understands:

| Element     | Purpose                   |
| ----------- | ------------------------- |
| `<message>` | A message in the timeline |
| `<section>` | A content section with id |
| `<tool>`    | A tool registration       |
| `<entry>`   | A timeline entry          |
| `<system>`  | System prompt content     |

Components compose these to produce model context.

## Existing Semantic Components

Before creating new ones, check `packages/core/src/jsx/components/semantic.tsx`:

`<H1>`, `<H2>`, `<H3>`, `<Header>`, `<Paragraph>`, `<List>`, `<ListItem>`, `<Table>`, `<Row>`, `<Column>`

And content blocks in `packages/core/src/jsx/components/content.tsx`:

`<Text>`, `<Image>`, `<Code>`, `<Json>`, `<Document>`, `<Audio>`, `<Video>`

## Configuration Components

Components that set up state without rendering visible content:

```tsx
export function MyConfig({ apiKey }: { apiKey: string }) {
  const ctx = useCom();

  useEffect(() => {
    ctx.setState("apiKey", apiKey);
  }, [apiKey]);

  return React.createElement(React.Fragment, null);
}
```

## Key Files

- Components: `packages/core/src/jsx/components/`
- Component index: `packages/core/src/jsx/components/index.ts`
- Primitives (intrinsics): `packages/core/src/jsx/components/primitives.ts`
- Semantic: `packages/core/src/jsx/components/semantic.tsx`
- Content: `packages/core/src/jsx/components/content.tsx`
- Messages: `packages/core/src/jsx/components/messages.tsx`
- Architecture doc: `packages/core/src/jsx/ARCHITECTURE.md`

## Testing

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { createTestAdapter, compileAgent, cleanup } from "@agentick/core/testing";

describe("MyComponent", () => {
  afterEach(() => cleanup());

  it("renders to model context", async () => {
    const adapter = createTestAdapter({ defaultResponse: "ok" });
    const { compiled } = await compileAgent(() => (
      <>
        <Model model={adapter} />
        <MyComponent title="Test">Content here</MyComponent>
        <Timeline />
      </>
    ));
    // Verify the compiled output includes your component's content
  });
});
```

After creating, run:

```bash
pnpm --filter @agentick/core typecheck
pnpm --filter @agentick/core test
```

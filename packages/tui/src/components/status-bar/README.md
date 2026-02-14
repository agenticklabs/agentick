# StatusBar

Composable status bar system for terminal UIs.

## Architecture

**Hybrid data flow**: `<StatusBar>` calls `useContextInfo` and `useStreamingText` once, provides results via `StatusBarContext`. Widgets read from context by default, but accept explicit props to override — so they work both inside `<StatusBar>` (convenient) and standalone (flexible).

```
StatusBar (container)
├── calls useContextInfo + useStreamingText
├── provides StatusBarContext to children
└── layout: left (grows) | right (shrinks), no border

Widgets (leaf components)
├── read from StatusBarContext via useStatusBarData()
├── accept explicit props that override context
└── return null when they have no data to show

DefaultStatusBar (pre-composed)
├── wraps StatusBar with responsive right side
├── uses useStdout() for terminal width
└── hides segments in narrow terminals
```

## Files

| File                   | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `context.ts`           | `StatusBarData` type, `StatusBarContext`, `useStatusBarData` |
| `StatusBar.tsx`        | Container — hooks, context provider, flexbox layout          |
| `StatusBarRight.tsx`   | Right-side composition with responsive breakpoints           |
| `DefaultStatusBar.tsx` | Pre-composed layout (hints left, info right)                 |
| `widgets/`             | Individual display widgets                                   |

## Responsive Breakpoints

`DefaultStatusBar` adapts to terminal width:

| Width | Right side                           |
| ----- | ------------------------------------ |
| 80+   | model \| tokens utilization \| state |
| 60-79 | model \| state                       |
| <60   | state                                |

## Adding a Widget

1. Create `widgets/MyWidget.tsx`
2. Call `useStatusBarData()` for context, accept explicit props as overrides
3. Return `null` when there's nothing to display (prevents dangling separators)
4. Export from `widgets/index.ts` and `index.ts`

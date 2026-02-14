# @agentick/tui

Terminal UI for Agentick agents. Uses [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) with `@agentick/react` hooks — same hooks, same streaming, different renderer.

## Installation

```sh
pnpm add @agentick/tui
```

## Quick Start

### Local Agent

```typescript
import { createApp, Model, Timeline, Section } from "@agentick/core";
import { openai } from "@agentick/openai";
import { createTUI } from "@agentick/tui";

function MyAgent() {
  return (
    <>
      <Model model={openai({ model: "gpt-4o-mini" })} />
      <Section id="system" audience="model">
        You are a helpful assistant.
      </Section>
      <Timeline />
    </>
  );
}

const app = createApp(MyAgent);
createTUI({ app }).start();
```

### Remote Agent

Connect to an Agentick gateway over HTTP/SSE:

```typescript
import { createTUI } from "@agentick/tui";

createTUI({ url: "https://my-agent.fly.dev/api" }).start();
```

### Custom UI

Replace the default chat interface with your own Ink component:

```typescript
import { createTUI } from "@agentick/tui";
import { MyDashboard } from "./dashboard.js";

createTUI({ app, ui: MyDashboard }).start();
```

### Alternate Screen

Use the terminal's alternate screen buffer to avoid polluting scrollback:

```typescript
createTUI({ app, alternateScreen: true }).start();
```

When enabled, the TUI takes over the alternate screen on start and restores the normal screen on exit. This prevents terminal scrollbar confusion where native scrollback doesn't interact with Ink's rendering.

## CLI

The `agentick-tui` binary launches a TUI from the command line.

```sh
# Local app (file exporting an App instance)
agentick-tui --app ./my-app.ts

# Remote gateway
agentick-tui --url https://my-agent.fly.dev/api

# With session ID
agentick-tui --url https://my-agent.fly.dev/api --session my-session

# Custom terminal UI
agentick-tui --app ./my-app.ts --ui ./dashboard.tsx
agentick-tui --app ./my-app.ts --ui ./dashboard.tsx --ui-export MonitorDashboard
```

**Dev (from repo root):**

```sh
pnpm tui -- --url http://localhost:3000/api --session default
```

### CLI Options

| Flag                 | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `--app <path>`       | Path to a file exporting an `App` instance               |
| `--export <name>`    | Named export to use (default: auto-detect)               |
| `--url <url>`        | Remote gateway URL (include the mount path, e.g. `/api`) |
| `--session <id>`     | Session ID (default: `"main"`)                           |
| `--ui <name\|path>`  | Built-in UI name or path to custom UI file               |
| `--ui-export <name>` | Named export from custom UI file                         |

### Built-in UIs

| Name   | Description                                |
| ------ | ------------------------------------------ |
| `chat` | Default conversational interface (default) |

## API

### createTUI(options)

Returns `{ start(): Promise<void> }`.

**Local options:**

| Option            | Type           | Description                                  |
| ----------------- | -------------- | -------------------------------------------- |
| `app`             | `App`          | Agentick App instance                        |
| `sessionId`       | `string`       | Session ID (default: `"main"`)               |
| `ui`              | `TUIComponent` | Custom UI component (default: `Chat`)        |
| `alternateScreen` | `boolean`      | Use alternate screen buffer (default: false) |

**Remote options:**

| Option            | Type           | Description                                  |
| ----------------- | -------------- | -------------------------------------------- |
| `url`             | `string`       | Gateway URL                                  |
| `token`           | `string`       | Auth token                                   |
| `sessionId`       | `string`       | Session ID (default: `"main"`)               |
| `ui`              | `TUIComponent` | Custom UI component (default: `Chat`)        |
| `alternateScreen` | `boolean`      | Use alternate screen buffer (default: false) |

### TUIComponent

Any React component that accepts `{ sessionId: string }`:

```typescript
import type { TUIComponent } from "@agentick/tui";

const MyUI: TUIComponent = ({ sessionId }) => {
  const { messages, status } = useSession(sessionId);
  // ... Ink components
};
```

## Components

All components are exported for building custom UIs.

| Component                | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `Chat`                   | Default conversational interface (block rendering)  |
| `MessageList`            | Prop-driven message display (Static + in-progress)  |
| `StreamingMessage`       | Live streaming response with cursor                 |
| `ToolCallIndicator`      | Spinner during tool execution                       |
| `ToolConfirmationPrompt` | Y/N/A prompt for tools with `requireConfirmation`   |
| `DiffView`               | Side-by-side diff display for file changes          |
| `ErrorDisplay`           | Error box with optional dismiss                     |
| `InputBar`               | Visual-only text input (value + cursor from parent) |
| `StatusBar`              | Container with context provider and layout          |
| `DefaultStatusBar`       | Pre-composed status bar with responsive layout      |

**Status bar widgets** (use standalone or inside `<StatusBar>`):

| Widget               | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `ModelInfo`          | Model name/id display                       |
| `TokenCount`         | Formatted token count (cumulative or tick)  |
| `TickCount`          | Current execution tick number               |
| `ContextUtilization` | Utilization % with color thresholds         |
| `StateIndicator`     | Mode label with color (idle/streaming/etc.) |
| `KeyboardHints`      | Contextual keyboard shortcut hints          |
| `BrandLabel`         | Styled app name                             |
| `Separator`          | Visual divider between segments             |

### InputBar

Visual-only input display. Renders the current value and cursor position — all keystroke handling lives in the parent via `useLineEditor`.

```typescript
import { InputBar, useLineEditor } from "@agentick/tui";

const editor = useLineEditor({ onSubmit: handleSubmit });

<InputBar
  value={editor.value}
  cursor={editor.cursor}
  isActive={chatMode === "idle"}
  placeholder="Type a message..."
/>
```

### useLineEditor

Ink-specific wrapper around `@agentick/client`'s `LineEditor` class. Provides
readline-quality editing with cursor movement, history, kill/yank, and word
navigation.

```typescript
const editor = useLineEditor({
  onSubmit: (text) => send(text),
});

// In your centralized useInput handler:
if (chatMode === "idle") {
  editor.handleInput(input, key);
}
```

Returns `{ value, cursor, handleInput, setValue, clear }`. Does not call `useInput` internally — the parent routes keystrokes to `editor.handleInput` when appropriate.

For framework-agnostic usage (web, Angular), use `LineEditor` from `@agentick/client` directly, or `useLineEditor` from `@agentick/react`.

### handleConfirmationKey

Input routing utility for tool confirmation prompts. Maps `y`/`n`/`a` keys to confirmation responses.

```typescript
import { handleConfirmationKey } from "@agentick/tui";

if (chatMode === "confirming_tool") {
  handleConfirmationKey(input, respondToConfirmation);
}
```

### MessageList

Prop-driven message display. Accepts `messages` from `useChat` and splits them into committed (Ink `<Static>`) and in-progress (regular render) based on `isExecuting`.

```typescript
<MessageList messages={messages} isExecuting={isExecuting} />
```

`Chat` uses `useChat({ renderMode: "block" })` so messages appear block-at-a-time as content completes, rather than waiting for the entire execution to finish.

### StatusBar

`<StatusBar>` is a container that calls `useContextInfo` and `useStreamingText` once, provides the data via React context, and renders a left/right flexbox layout with a top border.

Widgets read from context automatically when inside a `<StatusBar>`, or accept explicit props when used standalone.

**Default** — `Chat` renders `<DefaultStatusBar>` automatically:

```
Enter send | Ctrl+C exit                          GPT-4o | 6.2K 35% | idle
```

The default is responsive — hides token/utilization info in narrow terminals.

**Custom** — compose your own from widgets:

```typescript
import { StatusBar, BrandLabel, ModelInfo, TokenCount,
  ContextUtilization, StateIndicator, Separator, KeyboardHints } from "@agentick/tui";

<StatusBar sessionId={sessionId} mode={chatMode}
  left={<KeyboardHints hints={{ idle: [{ key: "Tab", action: "complete" }] }} />}
  right={<>
    <BrandLabel name="myapp" />
    <Separator />
    <ModelInfo />
    <Separator />
    <TokenCount cumulative />
    <Separator />
    <ContextUtilization />
    <Separator />
    <StateIndicator labels={{ streaming: "active" }} />
  </>}
/>
```

**Chat integration** — control the status bar via the `statusBar` prop:

```typescript
// Default (renders DefaultStatusBar)
<Chat sessionId="main" />

// Disabled
<Chat sessionId="main" statusBar={false} />

// Render prop — receives chat state
<Chat sessionId="main" statusBar={({ mode, sessionId }) => (
  <StatusBar sessionId={sessionId} mode={mode}
    left={<KeyboardHints />}
    right={<StateIndicator />}
  />
)} />
```

## Architecture

The TUI reuses `@agentick/react` hooks unchanged. Ink is React for terminals, so the same `useSession`, `useStreamingText`, and `useEvents` hooks work in both browser and terminal.

For local agents, `createLocalTransport` (from `@agentick/core`) bridges the in-process `App` to the `ClientTransport` interface. The TUI components don't know or care about local vs remote.

```
createTUI({ app })
  → createLocalTransport(app) → ClientTransport
  → createClient({ transport })
  → AgentickProvider + Ink components
  → useSession, useStreamingText, useEvents (same as web)
```

For remote agents, the client uses HTTP/SSE to connect to the gateway. An `eventsource` polyfill is included for Node.js environments where `globalThis.EventSource` is not available.

### Ink + React 19

Ink 5 bundles `react-reconciler@0.29`, which is incompatible with React 19. The monorepo applies a patch (`patches/ink@5.2.1.patch`) and overrides the reconciler to `0.31.0`. See `patches/README.md` for details.

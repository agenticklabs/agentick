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

| Component                | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `Chat`                   | Default chat UI (built-in)                        |
| `MessageList`            | Completed messages (Ink `<Static>`)               |
| `StreamingMessage`       | Live streaming response with cursor               |
| `ToolCallIndicator`      | Spinner during tool execution                     |
| `ToolConfirmationPrompt` | Y/N/A prompt for tools with `requireConfirmation` |
| `ErrorDisplay`           | Error box with optional dismiss                   |
| `InputBar`               | Text input with controlled/uncontrolled modes     |

### InputBar

Supports two modes:

**Uncontrolled** (default) — manages its own value, clears on submit:

```typescript
<InputBar onSubmit={(text) => send(text)} isDisabled={isStreaming} />
```

**Controlled** — parent owns the value (needed for Ctrl+L clear, scroll mode, etc.):

```typescript
const [value, setValue] = useState("");

<InputBar
  value={value}
  onChange={setValue}
  onSubmit={(text) => { send(text); setValue(""); }}
  isDisabled={isStreaming}
/>
```

### MessageList

Uses `execution_end` events as its data source. When the event includes `newTimelineEntries` (a delta of entries added during that execution), MessageList appends them. Falls back to replacing all messages from `output.timeline` for backwards compatibility.

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

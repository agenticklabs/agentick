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

| Option      | Type           | Description                           |
| ----------- | -------------- | ------------------------------------- |
| `app`       | `App`          | Agentick App instance                 |
| `sessionId` | `string`       | Session ID (default: `"main"`)        |
| `ui`        | `TUIComponent` | Custom UI component (default: `Chat`) |

**Remote options:**

| Option      | Type           | Description                           |
| ----------- | -------------- | ------------------------------------- |
| `url`       | `string`       | Gateway URL                           |
| `token`     | `string`       | Auth token                            |
| `sessionId` | `string`       | Session ID (default: `"main"`)        |
| `ui`        | `TUIComponent` | Custom UI component (default: `Chat`) |

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
| `InputBar`               | Text input, disabled while streaming              |

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

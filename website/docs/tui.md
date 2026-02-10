# Terminal UI (TUI)

`@agentick/tui` provides a terminal interface for Agentick agents using [Ink](https://github.com/vadimdemedes/ink) — React for CLIs. It reuses `@agentick/react` hooks unchanged, so the same `useSession`, `useStreamingText`, and `useEvents` work in both browser and terminal.

The TUI is **pluggable by design**. The default chat interface is just one option — swap in any Ink component to create dashboards, monitors, debugging tools, or entirely custom terminal experiences for your agents.

## Installation

```sh
npm install @agentick/tui
```

## Quick Start

### Local Agent

```tsx
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

```tsx
import { createTUI } from "@agentick/tui";

createTUI({ url: "https://my-agent.fly.dev/api" }).start();
```

## Pluggable UI

The default chat is a starting point, not the destination. Pass any Ink component as `ui` to completely replace the interface. Your component receives a `sessionId` and has full access to `@agentick/react` hooks.

```tsx
import { Box, Text } from "ink";
import { useSession, useStreamingText } from "@agentick/react";
import { createTUI } from "@agentick/tui";

// A monitoring dashboard instead of a chat
const Monitor = ({ sessionId }) => {
  const { status, messages } = useSession(sessionId);
  const streaming = useStreamingText(sessionId);

  return (
    <Box flexDirection="column">
      <Text bold>Agent Status: {status}</Text>
      <Text>Messages: {messages.length}</Text>
      {streaming && <Text color="green">▸ {streaming}</Text>}
    </Box>
  );
};

createTUI({ app, ui: Monitor }).start();
```

### Via CLI

Load custom UIs from the command line without changing code:

```sh
# Built-in chat (default)
agentick-tui --app ./my-app.ts

# Custom UI from a file
agentick-tui --app ./my-app.ts --ui ./monitor.tsx

# Custom UI with named export
agentick-tui --app ./my-app.ts --ui ./views.tsx --ui-export MonitorDashboard
```

This makes the TUI a general-purpose terminal harness for any agent. Build a chat, a log viewer, a tool call inspector, or a multi-agent dashboard — all driven by the same hooks.

## CLI

The `agentick-tui` binary launches a TUI from the command line.

```sh
# Local app (file exporting an App instance)
agentick-tui --app ./my-app.ts

# Remote gateway
agentick-tui --url https://my-agent.fly.dev/api

# With session ID
agentick-tui --url https://my-agent.fly.dev/api --session my-session
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

## Built-in Components

All components are exported for composing custom UIs. Mix and match them, or use them as reference implementations.

| Component                | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `Chat`                   | Default conversational interface                  |
| `MessageList`            | Completed messages (Ink `<Static>`)               |
| `StreamingMessage`       | Live streaming response with cursor               |
| `ToolCallIndicator`      | Spinner during tool execution                     |
| `ToolConfirmationPrompt` | Y/N/A prompt for tools with `requireConfirmation` |
| `ErrorDisplay`           | Error box with optional dismiss                   |
| `InputBar`               | Text input, disabled while streaming              |

## Architecture

The TUI is a thin rendering layer on top of `@agentick/client` and `@agentick/react`. It doesn't know or care whether the agent is local or remote.

```
createTUI({ app })
  → createLocalTransport(app) → ClientTransport
  → createClient({ transport })
  → AgentickProvider + Ink renderer
  → useSession, useStreamingText, useEvents (same hooks as web)

createTUI({ url })
  → createHTTPTransport(url) → ClientTransport
  → createClient({ transport })
  → AgentickProvider + Ink renderer
  → (identical hook usage)
```

For local agents, `createLocalTransport` (from `@agentick/core`) bridges the in-process `App` to the `ClientTransport` interface. For remote agents, the client uses HTTP/SSE with an `eventsource` polyfill for Node.js environments.

### Ink + React 19

Ink 5 bundles `react-reconciler@0.29`, which is incompatible with React 19. The monorepo applies a patch (`patches/ink@5.2.1.patch`) and overrides the reconciler to `0.31.0`. See `patches/README.md` for details.

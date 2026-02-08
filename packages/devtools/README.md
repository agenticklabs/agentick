# @agentick/devtools

Real-time debugging and observability for Agentick applications. Provides a server that captures execution events and a browser UI for inspection.

## Installation

```bash
pnpm add @agentick/devtools
```

## Quick Start

```typescript
import { startDevToolsServer } from "@agentick/devtools";
import { createApp } from "@agentick/core";

// Start DevTools server
const devtools = startDevToolsServer({ port: 3001 });

// Enable DevTools in your app
const app = createApp(MyApp, {
  model: myModel,
  devTools: true, // Enables event emission
});

// Navigate to http://localhost:3001 to view DevTools UI
```

## API

### startDevToolsServer(config?)

Convenience function to create and start a DevTools server:

```typescript
const devtools = startDevToolsServer({
  port: 3001, // Default: 3001
  host: "127.0.0.1", // Default: 127.0.0.1
  debug: false, // Enable debug logging
  heartbeatInterval: 30000, // SSE heartbeat interval (ms)
});

// Get server URL
console.log(devtools.getUrl()); // "http://127.0.0.1:3001"

// Stop when done
devtools.stop();
```

### DevToolsServer Class

For more control, use the class directly:

```typescript
import { DevToolsServer } from "@agentick/devtools";

const server = new DevToolsServer({ port: 3001 });
await server.start();

// Later...
await server.stop();
```

## HTTP Endpoints

| Endpoint       | Method | Description                    |
| -------------- | ------ | ------------------------------ |
| `/`            | GET    | DevTools UI                    |
| `/events`      | GET    | SSE stream of execution events |
| `/api/history` | GET    | All buffered events as JSON    |
| `/api/clear`   | GET    | Clear event history            |

## Event Types

The DevTools server captures these events from `@agentick/core`:

| Event               | Description                    |
| ------------------- | ------------------------------ |
| `execution_start`   | Execution began                |
| `execution_end`     | Execution completed            |
| `tick_start`        | Model API call started         |
| `tick_end`          | Model API call completed       |
| `compiled`          | JSX compiled to messages/tools |
| `model_request`     | Request sent to provider       |
| `provider_response` | Raw provider response          |
| `model_response`    | Normalized response            |
| `tool_call`         | Tool invocation                |
| `tool_result`       | Tool execution result          |
| `fiber_snapshot`    | Component tree state           |
| `content_delta`     | Streaming text chunk           |

## UI Features

### Execution List

View all executions with status, duration, and token usage.

### Tick Navigator

Scrub through individual ticks within an execution to see:

- Compiled context (system, messages, tools)
- Provider input/output
- Model response
- Tool calls

### Fiber Tree

Inspect the component hierarchy with:

- Props for each component
- Hook states
- Token estimates

### Context Info

Monitor context utilization:

- Input/output tokens per tick
- Context window usage percentage
- Cumulative usage across ticks

## Integration

### With Express

```typescript
import express from "express";
import { createExpressAdapter } from "@agentick/express";
import { startDevToolsServer } from "@agentick/devtools";

const app = express();

// Start DevTools on separate port
startDevToolsServer({ port: 3001 });

// Your Agentick app with DevTools enabled
const agentick = createExpressAdapter(MyApp, {
  model: myModel,
  devTools: true,
});

app.use("/api", agentick);
app.listen(3000);
```

### With Gateway

```typescript
import { createGateway } from "@agentick/gateway";
import { startDevToolsServer } from "@agentick/devtools";

startDevToolsServer({ port: 3001 });

const gateway = createGateway({
  agents: { assistant: myApp },
  devTools: true,
});
```

## Architecture

```
┌─────────────────────────┐
│  Agentick App/Session  │
│   (devTools: true)      │
└────────────┬────────────┘
             │ devToolsEmitter.emit()
             ↓
┌─────────────────────────┐
│   DevToolsServer        │
│   - Buffers events      │
│   - Broadcasts via SSE  │
│   - Serves UI           │
└────────────┬────────────┘
             │ HTTP /events (SSE)
             ↓
┌─────────────────────────┐
│   Browser UI (React)    │
│   - Real-time updates   │
│   - Execution inspection│
│   - Fiber tree viewer   │
└─────────────────────────┘
```

## Configuration

### Environment Variables

```bash
TENTICKLE_DEVTOOLS_PORT=3001
TENTICKLE_DEVTOOLS_HOST=127.0.0.1
```

### Programmatic

```typescript
const devtools = startDevToolsServer({
  port: process.env.DEVTOOLS_PORT || 3001,
  host: process.env.DEVTOOLS_HOST || "127.0.0.1",
  debug: process.env.NODE_ENV === "development",
});
```

## License

MIT

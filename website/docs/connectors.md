# Connectors

Connect agents to external messaging platforms. Connectors handle content filtering, delivery timing, rate limiting, and tool confirmations so platform adapters only need to handle I/O.

## Install

```bash
npm install @agentick/connector
```

Plus a platform adapter:

```bash
npm install @agentick/connector-telegram grammy
npm install @agentick/connector-imessage  # macOS only
```

## Quick Start

```typescript
import { createClient } from "@agentick/client";
import { createConnector } from "@agentick/connector";
import { TelegramPlatform } from "@agentick/connector-telegram";

const client = createClient({ url: "http://localhost:3000/api" });

const connector = createConnector(
  client,
  new TelegramPlatform({ token: process.env.TELEGRAM_BOT_TOKEN! }),
  {
    sessionId: "main",
    contentPolicy: "summarized",
    deliveryStrategy: "on-idle",
  },
);

await connector.start();
```

## How It Works

```
External Platform (Telegram, iMessage, ...)
    |
    v
ConnectorPlatform.start(bridge)
    |
    |-- inbound: bridge.send("user message")
    |       |
    |       v
    |   RateLimiter --> ConnectorSession.send() --> AgentickClient
    |
    +-- outbound: bridge.onDeliver(handler)
            ^
            |
    DeliveryBuffer (timing) --> ContentPipeline (filter) --> MessageLog
```

`createConnector` wires a `ConnectorPlatform` to a `ConnectorSession`. The session composes primitives from `@agentick/client` with content filtering and delivery timing on top.

## Content Policy

Controls what content reaches the platform.

| Policy | Behavior |
|--------|----------|
| `"text-only"` (default) | Strip tool_use and tool_result blocks, keep text and images |
| `"summarized"` | Collapse tool calls into brief summaries (`[Read config.ts]`, `[Ran: npm test]`) |
| `"full"` | Pass through unchanged |
| Function | Full control — receives a message, returns it transformed or `null` to drop |

### Custom Tool Summaries

Override built-in summaries for the `"summarized"` policy:

```typescript
import { createToolSummarizer } from "@agentick/connector";

const summarizer = createToolSummarizer({
  my_search: (input) => `[Searched: ${input.query}]`,
  deploy: () => `[Deploying...]`,
});

createConnector(client, platform, {
  contentPolicy: "summarized",
  toolSummarizer: summarizer,
});
```

## Delivery Strategy

Controls when messages are delivered to the platform.

| Strategy | Behavior |
|----------|----------|
| `"on-idle"` (default) | Deliver when execution completes. Clean, complete messages. |
| `"debounced"` | Deliver after `debounceMs` (default 1500) of no new content. |
| `"immediate"` | Deliver on every state change. For incremental rendering. |

## Rate Limiting

Throttle inbound messages with sliding-window per-minute and daily caps.

```typescript
createConnector(client, platform, {
  sessionId: "main",
  rateLimit: {
    maxPerMinute: 10,
    maxPerDay: 200,
    onLimited: ({ remaining, resetMs }) =>
      `Slow down! Try again in ${Math.ceil(resetMs / 1000)}s.`,
  },
});
```

When `onLimited` returns a string, it's delivered as a synthetic message. Return `void` to silently drop.

## Tool Confirmations

When the agent requests tool approval, connectors forward the confirmation to the platform. Built-in helpers for text-based confirmation:

```typescript
import {
  parseTextConfirmation,
  formatConfirmationMessage,
} from "@agentick/connector";

const message = formatConfirmationMessage(request);
// "Allow shell to execute?\n\n  command: rm -rf /tmp/test"

const response = parseTextConfirmation("yes but only in /tmp");
// { approved: true, reason: "yes but only in /tmp" }
```

## Writing a Platform Adapter

Implement `ConnectorPlatform` — two methods:

```typescript
import type {
  ConnectorPlatform,
  ConnectorBridge,
} from "@agentick/connector";

export class MyPlatform implements ConnectorPlatform {
  async start(bridge: ConnectorBridge): Promise<void> {
    // Subscribe to inbound messages
    this.onMessage((text) => bridge.send(text));

    // Handle outbound delivery
    bridge.onDeliver((output) => {
      for (const msg of output.messages) {
        this.sendToUser(extractText(msg.content));
      }
    });

    // Handle tool confirmations
    bridge.onConfirmation((request, respond) => {
      this.promptUser(request, (answer) => {
        respond(parseTextConfirmation(answer));
      });
    });
  }

  async stop(): Promise<void> {
    // Clean up connections, timers, etc.
  }
}
```

The bridge provides everything the platform needs:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `bridge.send(text)` | Inbound | Push a user message to the agent |
| `bridge.sendInput(input)` | Inbound | Push a rich `SendInput` |
| `bridge.onDeliver(handler)` | Outbound | Receive filtered, timed messages |
| `bridge.onConfirmation(handler)` | Outbound | Receive tool confirmation requests |
| `bridge.abort(reason?)` | Control | Cancel current execution |
| `bridge.destroy()` | Control | Tear down the session |

All outbound messages are already filtered by the content policy and timed by the delivery strategy. The platform just handles I/O.

## Platform Adapters

### @agentick/connector-telegram

Telegram bot adapter using [grammY](https://grammy.dev). `grammy` is a peer dependency.

```bash
npm install @agentick/connector-telegram grammy
```

```typescript
import { TelegramPlatform } from "@agentick/connector-telegram";

const platform = new TelegramPlatform({
  token: process.env.TELEGRAM_BOT_TOKEN!,
});
```

### @agentick/connector-imessage

iMessage adapter for macOS. Polls `chat.db` for incoming messages and sends responses via AppleScript through Messages.app. Requires Node 22+ (`node:sqlite` built-in).

```bash
npm install @agentick/connector-imessage
```

```typescript
import { IMessagePlatform } from "@agentick/connector-imessage";

const platform = new IMessagePlatform({
  chatId: "+15551234567",
});
```

## Config Reference

```typescript
interface ConnectorConfig {
  sessionId: string;
  contentPolicy?: ContentPolicy;      // default: "text-only"
  deliveryStrategy?: DeliveryStrategy; // default: "on-idle"
  debounceMs?: number;                 // default: 1500 (for "debounced")
  toolSummarizer?: ToolSummarizer;     // custom summaries for "summarized"
  rateLimit?: RateLimitConfig;
  autoSubscribe?: boolean;             // default: true
  retry?: RetryConfig;                 // exponential backoff for failed deliveries
}
```

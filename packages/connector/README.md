# @agentick/connector

Bridge external platforms to Agentick sessions. Handles content filtering,
delivery timing, rate limiting, and tool confirmations so platform adapters
only need to handle I/O.

## Install

```sh
pnpm add @agentick/connector
```

## Quick Start

```typescript
import { createConnector } from "@agentick/connector";
import { TelegramPlatform } from "@agentick/connector-telegram";

const connector = createConnector(
  client,
  new TelegramPlatform({
    token: process.env.TELEGRAM_BOT_TOKEN!,
  }),
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
External Platform
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

`createConnector` wires a `ConnectorPlatform` to a `ConnectorSession`. The
session composes `MessageLog` and `ToolConfirmations` from `@agentick/client`
with `subscribe: false`, adding content filtering and delivery timing on top.

## Content Policy

Controls what content reaches the platform.

```typescript
type ContentPolicy = "full" | "text-only" | "summarized" | ContentPolicyFn;
```

- **`"text-only"`** (default) — Strip tool_use and tool_result blocks, keep
  text and images.
- **`"summarized"`** — Collapse tool calls into brief summaries
  (`[Read config.ts]`, `[Ran: npm test]`), keep text.
- **`"full"`** — Pass through unchanged.
- **Function** — Full control. Receives a `ChatMessage`, returns it
  transformed or `null` to drop.

### Custom Tool Summaries

Override the built-in summaries for the `"summarized"` policy:

```typescript
import { createToolSummarizer } from "@agentick/connector";

const summarizer = createToolSummarizer({
  my_search: (input) => `[Searched: ${input.query}]`,
  deploy: () => `[Deploying...]`,
});

createConnector(client, platform, {
  sessionId: "main",
  contentPolicy: "summarized",
  toolSummarizer: summarizer,
});
```

Built-in summaries: `glob`, `grep`, `read_file`/`ReadFile`, `write_file`/
`WriteFile`, `edit_file`/`EditFile`, `shell`. Unknown tools get `[Used name]`.

## Delivery Strategy

Controls when messages are delivered to the platform.

```typescript
type DeliveryStrategy = "immediate" | "on-idle" | "debounced";
```

- **`"on-idle"`** (default) — Deliver only when execution completes. Produces
  clean, complete messages. Best for iMessage.
- **`"debounced"`** — Deliver after `debounceMs` (default: 1500) of no new
  content. Good for Telegram message editing.
- **`"immediate"`** — Deliver on every state change. For platforms that render
  incrementally.

## Rate Limiting

Throttle inbound messages with sliding-window per-minute and daily caps.

```typescript
createConnector(client, platform, {
  sessionId: "main",
  rateLimit: {
    maxPerMinute: 10,
    maxPerDay: 200,
    onLimited: ({ remaining, resetMs }) => `Slow down! Try again in ${Math.ceil(resetMs / 1000)}s.`,
  },
});
```

When `onLimited` returns a string, it's delivered as a synthetic message.
Return `void` to silently drop.

## Tool Confirmations

When the agent requests tool approval, connectors receive the confirmation
through `bridge.onConfirmation()`. The platform presents it to the user
(inline keyboard, text prompt, etc.) and calls `respond()` with the result.

The full response text is passed as `reason` so the model can interpret
nuanced answers like "yes but skip the tests".

```typescript
import { parseTextConfirmation, formatConfirmationMessage } from "@agentick/connector";

const message = formatConfirmationMessage(request);
// "Allow shell to execute?\n\n  command: rm -rf /tmp/test"

const response = parseTextConfirmation("yes but only in /tmp");
// { approved: true, reason: "yes but only in /tmp" }
```

## ConnectorSession

Use `ConnectorSession` directly for more control:

```typescript
import { ConnectorSession } from "@agentick/connector";

const session = new ConnectorSession(client, {
  sessionId: "main",
  contentPolicy: "summarized",
  deliveryStrategy: "on-idle",
});

session.onDeliver((output) => {
  for (const msg of output.messages) {
    sendToUser(extractText(msg.content));
  }
  if (output.isComplete) {
    showTypingIndicator(false);
  }
});

session.onConfirmation((request, respond) => {
  promptUser(formatConfirmationMessage(request), (answer) => {
    respond(parseTextConfirmation(answer));
  });
});

session.send("Hello agent!");
```

## Writing a Platform Adapter

Implement `ConnectorPlatform` — two methods, one interface:

```typescript
import type { ConnectorPlatform, ConnectorBridge } from "@agentick/connector";

export class MyPlatform implements ConnectorPlatform {
  async start(bridge: ConnectorBridge): Promise<void> {
    // 1. Subscribe to your platform's inbound messages
    this.onMessage((text) => bridge.send(text));

    // 2. Handle outbound delivery
    bridge.onDeliver((output) => {
      for (const msg of output.messages) {
        this.sendToUser(extractText(msg.content));
      }
    });

    // 3. Handle tool confirmations
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

The bridge provides:

| Method                           | Direction | Purpose                            |
| -------------------------------- | --------- | ---------------------------------- |
| `bridge.send(text)`              | Inbound   | Push a user message to the agent   |
| `bridge.sendInput(input)`        | Inbound   | Push a rich `SendInput`            |
| `bridge.onDeliver(handler)`      | Outbound  | Receive filtered, timed messages   |
| `bridge.onConfirmation(handler)` | Outbound  | Receive tool confirmation requests |
| `bridge.abort(reason?)`          | Control   | Cancel current execution           |
| `bridge.destroy()`               | Control   | Tear down the session              |

All outbound messages are already filtered by the content policy and timed by
the delivery strategy. The platform just handles I/O.

## Config Reference

```typescript
interface ConnectorConfig {
  sessionId: string;
  contentPolicy?: ContentPolicy; // default: "text-only"
  deliveryStrategy?: DeliveryStrategy; // default: "on-idle"
  debounceMs?: number; // default: 1500 (for "debounced")
  toolSummarizer?: ToolSummarizer; // custom summaries for "summarized"
  rateLimit?: RateLimitConfig;
  autoSubscribe?: boolean; // default: true
}
```

## Exports

```typescript
// Core
export { ConnectorSession } from "./connector-session.js";
export { createConnector } from "./create-connector.js";

// Content pipeline
export {
  buildContentFilter,
  applyContentPolicy,
  createToolSummarizer,
} from "./content-pipeline.js";
export type { ToolSummarizer } from "./content-pipeline.js";

// Delivery + rate limiting
export { DeliveryBuffer, RateLimiter } from "./delivery-buffer.js";

// Text utilities
export { parseTextConfirmation, formatConfirmationMessage } from "./text-utils.js";
export { extractText } from "@agentick/shared"; // re-exported for convenience

// Types
export type {
  ContentPolicy,
  ContentPolicyFn,
  DeliveryStrategy,
  RateLimitConfig,
  ConnectorConfig,
  ConnectorOutput,
  ConnectorPlatform,
  ConnectorBridge,
} from "./types.js";
```

# @agentick/connector-telegram

Telegram platform adapter for the Agentick connector system. Bridge a Telegram
bot to an agent session.

## Install

```sh
pnpm add @agentick/connector-telegram grammy
```

`grammy` is a peer dependency.

## Usage

```typescript
import { createConnector } from "@agentick/connector";
import { TelegramPlatform } from "@agentick/connector-telegram";

const connector = createConnector(
  client,
  new TelegramPlatform({
    token: process.env.TELEGRAM_BOT_TOKEN!,
    allowedUsers: [parseInt(process.env.TELEGRAM_USER_ID!)],
  }),
  {
    sessionId: "main",
    contentPolicy: "summarized",
    deliveryStrategy: "debounced",
    debounceMs: 2000,
  },
);

await connector.start();
```

## Options

```typescript
interface TelegramConnectorOptions {
  token: string;
  allowedUsers?: number[];
  chatId?: number;
  confirmationStyle?: "inline-keyboard" | "text";
}
```

**`token`** — Telegram bot token from [@BotFather](https://t.me/BotFather).

**`allowedUsers`** — Whitelist of Telegram user IDs. Empty array allows all
users. Get your ID from [@userinfobot](https://t.me/userinfobot).

**`chatId`** — Specific chat to use. If omitted, auto-detects from the first
incoming message.

**`confirmationStyle`** — How tool confirmations are presented. Default:
`"inline-keyboard"`.

## Tool Confirmations

### Inline Keyboard (default)

Sends a message with Approve/Deny buttons. The user taps a button, the
confirmation resolves.

### Text-based

Sends a text prompt. The next message from the user is parsed as the
confirmation response. Supports natural language — "yes but skip tests" is
approved with the full text as reason.

## Recommended Config

For a conversational bot experience:

```typescript
{
  contentPolicy: "summarized",   // collapse tool calls into brief summaries
  deliveryStrategy: "debounced", // wait for a pause before sending
  debounceMs: 2000,
}
```

For a long-running agent that reports results:

```typescript
{
  contentPolicy: "text-only",    // only deliver text, no tool noise
  deliveryStrategy: "on-idle",   // deliver only when execution completes
}
```

## Exports

```typescript
export { TelegramPlatform, type TelegramConnectorOptions } from "./telegram-platform.js";
```

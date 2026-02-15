# @agentick/connector-imessage

iMessage platform adapter for the Agentick connector system. macOS only.

Polls `~/Library/Messages/chat.db` for incoming messages and sends responses
via AppleScript through Messages.app.

## Install

```sh
pnpm add @agentick/connector-imessage
```

Requires Node 22+ (`node:sqlite` built-in).

## Prerequisites

Grant **Full Disk Access** to your terminal application in System Settings >
Privacy & Security > Full Disk Access. Without this, the agent cannot read
`chat.db`.

## Usage

```typescript
import { createConnector } from "@agentick/connector";
import { IMessagePlatform } from "@agentick/connector-imessage";

const connector = createConnector(
  client,
  new IMessagePlatform({
    handle: "+15551234567",
  }),
  {
    sessionId: "main",
    contentPolicy: "summarized",
    deliveryStrategy: "on-idle",
  },
);

await connector.start();
```

## Options

```typescript
interface IMessageConnectorOptions {
  handle: string;
  pollIntervalMs?: number;
  sendDelay?: number;
  dbPath?: string;
}
```

**`handle`** — Phone number (with country code) or email address to watch.

**`pollIntervalMs`** — How often to poll `chat.db`. Default: 2000ms.

**`sendDelay`** — Delay between sending multiple messages to avoid rate
limiting by Messages.app. Default: 500ms.

**`dbPath`** — Custom path to `chat.db` (for testing).

## How It Works

**Inbound**: Polls `chat.db` using `node:sqlite`. Tracks a ROWID watermark so
each poll only returns new messages. Filters by handle and `is_from_me = 0`.
Poll errors (e.g., `SQLITE_BUSY` when Messages.app holds a lock) are caught
and retried on the next interval.

**Outbound**: Sends via `osascript` driving Messages.app. Text is escaped to
prevent AppleScript injection.

**Confirmations**: Text-based only. Sends a prompt like "Allow shell to
execute? Reply yes/no" and parses the next inbound message as the response.
Natural language is supported — "yes but only in /tmp" is approved with the
full text as reason.

## Recommended Config

```typescript
{
  contentPolicy: "summarized",   // clean summaries, no raw tool blocks
  deliveryStrategy: "on-idle",   // one polished message per execution
}
```

iMessage works best with `"on-idle"` delivery — one complete, well-composed
message rather than a stream of fragments.

## Exports

```typescript
export { IMessagePlatform, type IMessageConnectorOptions } from "./imessage-platform.js";
export { IMessageDB, type IMessageRow } from "./imessage-db.js";
export { sendIMessage, buildAppleScript } from "./imessage-send.js";
```

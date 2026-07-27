# @agentick/connector

**Bind an external event source to an agent session.** A connector is an
_ingress binding_: Telegram, iMessage, a webhook, an MQ consumer, a cron tick —
each inbound event becomes an agentic action.

It is just a session under the hood. One server-side gateway extension resolves
the app, resolves the session, and calls `session.send`. There is no connector
subsystem, no bespoke send verb, and no client-side counterpart — the whole
package is composition over primitives that already ship.

## Install

```bash
npm install @agentick/connector
```

Subpath: `/testing` (a working in-memory platform).

## Quick start

Write the thin adapter for your wire, install it on a gateway, done.

```tsx
import { reactCompiler } from "@agentick/compiler-react";
import { defineConnector, type ConnectorPlatform } from "@agentick/connector";
import { createGateway } from "@agentick/gateway";

// Whatever SDK your source speaks. The adapter is the only thing that knows it.
declare const telegram: {
  onMessage(fn: (m: { chatId: number; from: string; text: string }) => void): void;
  sendMessage(chatId: number, text: string): Promise<void>;
  close(): Promise<void>;
};

// Typed provenance for this wire. `MessageSource` is an empty seed each port
// contributes its own slot to.
declare module "@agentick/spec" {
  interface MessageSource {
    readonly telegram?: { readonly chatId: number };
  }
}

const chatOf = (sessionId: string) => Number(sessionId.slice("telegram:".length));

const platform: ConnectorPlatform = {
  name: "telegram",
  start(handle) {
    telegram.onMessage((m) =>
      handle.emitInbound({
        text: m.text,
        senderId: m.from,
        sessionId: `telegram:${m.chatId}`, // one session per chat
        source: { telegram: { chatId: m.chatId } },
      }),
    );
  },
  stop: () => telegram.close(),
  // Optional. Omit it and this becomes a one-way ingress source.
  deliver: ({ sessionId, response }) => telegram.sendMessage(chatOf(sessionId), response),
};

const gateway = await createGateway({
  extensions: [defineConnector({ name: "telegram", platform, config: { allowlist: ["ryan"] } })],
});
await gateway.listen();
await gateway.createApp(<Agent />, { options: { model, compiler: reactCompiler() } });
```

`emitInbound` is the entire ingress contract. Everything the connector does with
it — resolve the app, get-or-create the session, stamp `metadata.source`, run
`send` — is already there.

## Ingress is the base; the reply path is optional

`start` and `stop` are required. `deliver` and `presentConfirmation` are not: a
one-way source implements neither and never delivers a reply. That is
first-class, not a degenerate case — no subscriptions are opened for a half the
platform didn't ask for.

| Direction         | Wired when                         | What it composes                                        |
| ----------------- | ---------------------------------- | ------------------------------------------------------- |
| **inbound**       | always                             | event → `gateway.apps()` → session → `session.send({})` |
| **outbound**      | platform has `deliver`             | execution-terminal bus event → hand raw output over     |
| **confirmations** | platform has `presentConfirmation` | elicitation channel → prompt → `respond(…)`             |
| **teardown**      | always                             | gateway close → unsubscribe → `platform.stop()`         |

### One-way ingress

```ts
import type { ConnectorPlatform } from "@agentick/connector";

declare const server: {
  on(route: string, fn: (req: { body: { text: string } }) => void): void;
  close(): void;
};

const webhook: ConnectorPlatform = {
  name: "webhook",
  start(handle) {
    server.on("POST /hook", (req) => handle.emitInbound({ text: req.body.text }));
  },
  stop: () => server.close(),
  // no `deliver`, no `presentConfirmation` → inbound-only
};
```

The event still drives a full execution; nothing is handed back.

### Outbound

`deliver` receives the agent's output when an execution completes, **raw** — no
cadence, no filtering, no chunking. A port that wants those composes them
itself:

```ts
import { summarizedFormatter } from "@agentick/formatters";
import { splitMessage } from "@agentick/utils";

declare const telegram: { sendMessage(chatId: number, text: string): Promise<void> };
declare const chatOf: (sessionId: string) => number;

const deliver = async ({ sessionId, response }: { sessionId: string; response: string }) => {
  for (const chunk of splitMessage(response, { maxLength: 4096 })) {
    await telegram.sendMessage(chatOf(sessionId), chunk);
  }
};
void summarizedFormatter; // …and a content-reduction policy, if the wire wants one
```

> [!NOTE]
> `deliver` fires once per completed execution, not per tick and not per block.
> `response` is the concatenated assistant text; `output` is the full content
> block array when the wire can render more than text.

### Confirmations

Implement `presentConfirmation` to opt into elicitation routing. The connector
formats the request and correlates the reply; you present it and relay the
answer through the handle you were given at `start`.

```ts
import { defineConnector, type ConnectorHandle, type ConnectorPlatform } from "@agentick/connector";

declare const telegram: {
  onMessage(fn: (m: { chatId: number; text: string }) => void): void;
  sendMessage(chatId: number, text: string): Promise<void>;
  close(): void;
};
declare let awaitingReply: string | undefined; // the correlationId in flight

let handle: ConnectorHandle | undefined;

const platform: ConnectorPlatform = {
  name: "telegram",
  start(h) {
    handle = h;
    telegram.onMessage((m) => {
      // A reply to a pending prompt answers the elicitation; anything else is
      // ordinary inbound.
      if (awaitingReply) {
        h.respondConfirmation({ correlationId: awaitingReply, text: m.text });
        awaitingReply = undefined;
        return;
      }
      h.emitInbound({ text: m.text, sessionId: `telegram:${m.chatId}` });
    });
  },
  stop: () => telegram.close(),
  presentConfirmation(prompt) {
    awaitingReply = prompt.correlationId; // "Delete everything?"
    return telegram.sendMessage(42, prompt.message);
  },
};

void handle;
void defineConnector({ name: "telegram", platform });
```

`"yes" / "y" / "ok" / "okay" / "approve" / "approved" / "go" / "go ahead" /
"do it"` (and anything starting `"yes "` or `"approve "`) resolve to
`{ outcome: "accepted", value: true }`; anything else to `value: false`. The raw
text always rides along as `reason`, so "yes, but skip the tests" reaches the
model intact.

> [!IMPORTANT]
> A text reply **answers** a yes/no question — it is never a dismissal. The
> `declined` / `cancelled` elicitation outcomes model an explicit dismissal,
> which free text is not.

`parseTextConfirmation` and `formatConfirmationMessage` are exported so a port
can reuse or replace the parse without reimplementing the format.

## Routing and config

`config` decides which app, which session, and who is allowed through.

| Slot        | Default                       | Effect                                                    |
| ----------- | ----------------------------- | --------------------------------------------------------- |
| `appId`     | the gateway's sole app        | Which hosted app to bind. Resolved at first inbound.      |
| `sessionId` | `connector:<name>`            | The session a source routes to when the event names none. |
| `allowlist` | unset (everything is allowed) | Drop inbound whose `senderId` is not listed.              |

Two routing postures, both one line:

```ts
import { defineConnector, type ConnectorPlatform } from "@agentick/connector";

declare const platform: ConnectorPlatform;

// One long-lived session for the whole source (the default).
defineConnector({ name: "ops-webhook", platform });

// One session per chat/topic — the port stamps `InboundMessage.sessionId`
// and the connector get-or-creates it.
defineConnector({ name: "telegram", platform, config: { sessionId: "telegram:fallback" } });
```

> [!WARNING]
> `allowlist` is a whitelist gate keyed on an unauthenticated platform handle,
> not identity. It answers "should I process this at all," never "who is this."

## Testing

`fakeConnectorPlatform` is a working in-memory platform — it records what the
connector pushed and hands you drivers to push back.

```ts
import { fakeConnectorPlatform } from "@agentick/connector/testing";
import { defineConnector } from "@agentick/connector";
import { createGateway } from "@agentick/gateway";

const platform = fakeConnectorPlatform();
const gateway = await createGateway({
  extensions: [defineConnector({ name: "test", platform })],
});
await gateway.listen();
// … create an app on the gateway, then:

platform.emit({ text: "hello agent" }); // drive inbound
platform.delivered; // OutboundDelivery[] the connector handed over
platform.confirmations; // ConfirmationPrompt[] presented
platform.replyLatest("yes"); // answer the most recent one
```

Pass `{ oneWay: true }` for an ingress-only platform (no `deliver`, no
`presentConfirmation`) to exercise the one-way path.

## API

### `@agentick/connector`

| Export                        | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `defineConnector(spec)`       | Returns a `GatewayExtension` — install via `createGateway`       |
| `parseTextConfirmation(t)`    | Free text → `{ approved, reason }`                               |
| `formatConfirmationMessage()` | Elicitation request → human-readable prompt (message, args, url) |
| `ConnectorPlatform` (type)    | The adapter you implement                                        |
| `ConnectorHandle` (type)      | What the connector hands the platform at `start`                 |
| `ConnectorConfig` (type)      | `appId` · `sessionId` · `allowlist`                              |
| `InboundMessage` (type)       | `text` · `source` · `senderId` · `sessionId`                     |
| `OutboundDelivery` (type)     | `sessionId` · `response` · `output`                              |
| `ConfirmationPrompt` (type)   | `sessionId` · `correlationId` · `message` · `mode` · `url`       |
| `ConfirmationReply` (type)    | `correlationId` · `text`                                         |
| `ConnectorStatus` (type)      | `disconnected` · `connecting` · `connected` · `error`            |

`defineConnector(spec)` slots: `name` · `platform` · `config`.

### `ConnectorPlatform`

| Member                        | Required | Direction            |
| ----------------------------- | -------- | -------------------- |
| `start(handle)`               | yes      | connector → platform |
| `stop()`                      | yes      | connector → platform |
| `deliver(delivery)`           | no       | connector → platform |
| `presentConfirmation(prompt)` | no       | connector → platform |
| `name` / `status`             | no       | diagnostics          |

### `ConnectorHandle`

| Method                         | Purpose                                       |
| ------------------------------ | --------------------------------------------- |
| `emitInbound(message)`         | An external event arrived. The required path. |
| `respondConfirmation(reply)`   | The user answered a pending confirmation.     |
| `reportStatus(status, error?)` | Report the platform's own connection health.  |

### `@agentick/connector/testing`

| Export                               | Purpose                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `fakeConnectorPlatform({ oneWay? })` | Working in-memory platform: `delivered` / `confirmations` / `started` / `stopped` plus `emit` / `reply` / `replyLatest` / `report` drivers |

## Patterns

**The gateway is the host.** [@agentick/gateway](../gateway) owns app and
session lifecycle; a connector borrows both through `installer.gateway.apps()`
and unwinds on gateway close.

**Confirmations ride elicitation.** [@agentick/elicitation](../elicitation) owns
the request/respond protocol; the connector only observes the channel and routes
the answer in-process — no wire hop, and no runtime dependency on the
elicitation package.

**Delivery polish is a port concern.**
[@agentick/formatters](../formatters) ships `summarizedFormatter` /
`textOnlyFormatter` and [@agentick/utils](../utils) ships `splitMessage`. Compose
them in `deliver`; the base stays a hand-off.

**Provenance, not identity.** `InboundMessage.source` lands at
`metadata.source` on the resulting user message, typed through the
`MessageSource` augmentation seam in [@agentick/spec](../spec). It records
which surface and which handle, never who.

## Roadmap & known gaps

- **No platform ports ship yet.** `@agentick/connector-telegram` and
  `@agentick/connector-imessage` are gated on their SDKs. This package is the
  base plus a fake platform; you write the adapter.
- **Delivery sophistication is deliberately absent.** Cadence strategies
  (immediate / on-idle / debounced), content-policy filtering, rate limiting,
  and retry backoff are not in the base and may never be — compose them in the
  port, or wait for opt-in riders.
- **Identity is a service account.** Inbound work is attributed to the
  connector's construction-bound principal. The per-message authenticated actor
  needs an ingress-interception seam that isn't built; until then `senderId` is
  a gate input and `metadata.source` is unauthenticated provenance.
- **`reportStatus` has no reader.** A platform can report `connecting` /
  `connected` / `error`, and an error is logged, but there is no status
  projection to subscribe to yet.
- **The ingress action is always `session.send`.** The shape leaves room for
  routing an event to a tool dispatch or a one-shot run instead; neither is
  wired.
- **Failures go to the console.** An inbound handler that throws, or a `deliver`
  that rejects, is reported with `console.error` rather than routed to a
  configurable sink.
- **Confirmation parsing is fixed.** The affirmative list is not configurable,
  and a form elicitation's reply is always coerced to a boolean — schema-aware
  free-form value replies are a port concern with no support from the base.

## Verified by

- `src/__tests__/connector.spec.tsx` — the full flow through a real gateway, app,
  and session with `fakeConnectorPlatform`: inbound `emit` → `session.send` with
  `metadata.source` stamped; one-way ingress running an execution and delivering
  nothing; `deliver` receiving the raw `response` + `output`; a presented
  confirmation whose `"yes"` / `"no"` reply resolves the elicitation to
  `true` / `false`.
- `src/__tests__/confirmations.spec.ts` — `parseTextConfirmation` over
  affirmatives and everything else (raw text kept as `reason`), and
  `formatConfirmationMessage` appending an argument summary and a URL.

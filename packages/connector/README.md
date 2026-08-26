# @agentick/connector

**Turn any event source into an agent conversation.**

A connector binds the outside world — a chat platform, a webhook, a message
queue, a cron tick — to an agent running on your gateway. Inbound events become
agent turns; the agent's replies flow back out. One flat spec, one
`GatewayExtension`, no new subsystem: under the hood it's just a session.

```ts
import { createGateway } from "@agentick/gateway";
import { defineConnector } from "@agentick/connector";

const gateway = await createGateway({
  extensions: [
    defineConnector({
      name: "telegram",
      start({ inbound }) {
        bot.on("message", (m) => inbound({ text: m.text, sessionId: `tg:${m.chat.id}` }));
        return () => bot.stop();
      },
      deliver: ({ sessionId, response }) => bot.send(chatOf(sessionId), response),
    }),
  ],
});
```

That's a complete two-way Telegram bridge. Each chat gets its own durable
session (history, tools, memory — everything a session has); each reply is the
agent's finished turn.

## The mental model

Three ideas, and you know the whole package:

1. **Ingress is the base.** `start(ctx)` subscribes your source and pushes
   events through `ctx.inbound(...)`. That's the only required part — a
   webhook or queue consumer that never replies is a complete connector.
2. **Delivery is a specialization.** Implement `deliver` and the agent's
   output for each completed turn is handed to you, raw. No cadence, no
   chunking, no formatting opinions — compose `@agentick/formatters` if you
   want them.
3. **It's just a session.** Sessions are durable and create-or-resume, so a
   reply arriving days later — after restarts, after deploys — lands in the
   same conversation. Route per chat/thread/user by stamping
   `inbound({ sessionId })`; omit it for one long-lived session per connector.

`start` may return a teardown (`useEffect`-style); it runs at gateway close.

## Acting as your users

By default a connector's sessions belong to the trusted host. When events come
_from your users_, authenticate them yourself and pass the result — the session
then opens through the gateway's identity door (ADR 100): the authorizer, your
`onBeforeWire…` policy hooks, and the owning-principal stamp all run exactly as
they would for a network request.

```ts
start({ inbound }) {
  source.on("message", async (m) => {
    const identity = await authSource.authenticate({ kind: "bearer", token: tokenFor(m) });
    inbound({
      text: m.body,
      identity,                                     // verified, never a raw credential
      sessionId: `sms:${m.conversationId}`,
      session: { title: "Text conversation", metadata: { channel: "sms" } },
    });
  });
}
```

`session` contributes to `createSession` when this event opens the session
(title, metadata, initial props). `identity` carries a _verified_
`IngressIdentity` — authenticating is your job; the connector never sees a
credential.

## One-shot processing

Some sources don't hold conversations — they classify, extract, react. Set
`ephemeral: true` and each event runs `app.runOnce`: create, send once,
dispose. Pair it with per-event `send` options for structured output:

```ts
defineConnector({
  name: "email-classifier",
  ephemeral: true,
  start({ inbound }) {
    stream.subscribe("email.received", async (e) => {
      inbound({
        text: await renderEmailPrompt(e),
        identity: await serviceIdentity(e.tenantId),
        send: { output: classificationSchema, allowedTools: ["query"] },
      });
    });
  },
  deliver: ({ output }) => persistVerdict(output), // handed the run's result directly
});
```

`send` merges over every turn's send — structured `output`, `allowedTools`,
execution-scoped `tools`, `maxTicks` — anything but `messages`, which is the
connector's own.

## Replies that need a human

Implement `confirm` and the agent's confirmations (tool approvals,
elicitations) are formatted and presented through your source; route the
user's answer back with `ctx.confirmed`:

```ts
confirm: (prompt) => bot.send(chatOf(prompt.sessionId), prompt.message),
start({ inbound, confirmed }) {
  bot.on("message", (m) =>
    isReplyToPrompt(m)
      ? confirmed({ correlationId: pendingFor(m), text: m.text })
      : inbound({ text: m.text }),
  );
}
```

"yes"/"ok"/"go ahead" approve; anything else declines with the raw text as the
reason. Omit `confirm` and confirmation routing is never wired.

## Testing

`connectorProbe()` stands in for your source: spread `probe.spec` into the
connector, then drive it.

```ts
import { connectorProbe } from "@agentick/connector/testing";

const probe = connectorProbe();
const gateway = await createGateway({
  extensions: [defineConnector({ name: "test", ...probe.spec })],
});
// …createApp, then:
probe.emit({ text: "hello" });
expect(probe.delivered[0]!.response).toBe("reply");
```

## API

| `defineConnector({ … })` |                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `name`                   | Connector name — diagnostics + extension routing.                                   |
| `start(ctx)`             | **Required.** Subscribe your source; push via `ctx.inbound`. May return a teardown. |
| `deliver(d)`             | _Optional._ Receive each completed turn's raw output.                               |
| `confirm(p)`             | _Optional._ Present confirmations; answer via `ctx.confirmed`.                      |
| `app`                    | Target app id. Default: the gateway's sole app, resolved lazily.                    |
| `session`                | Default session id. Default: `connector:<name>`.                                    |
| `ephemeral`              | `runOnce` per event instead of a held session.                                      |
| `allowlist`              | Allowed `senderId`s; others dropped. A gate, not identity.                          |

| `ctx.inbound({ … })` |                                                                    |
| -------------------- | ------------------------------------------------------------------ |
| `text`               | The event's message text.                                          |
| `sessionId`          | Route to a session (per chat/thread/user).                         |
| `identity`           | Verified `IngressIdentity` — open through the `as()` door.         |
| `session`            | `createSession` contribution: `title`, `metadata`, `initialProps`. |
| `send`               | Per-event send options (`output`, `allowedTools`, `tools`, …).     |
| `source`             | Provenance, stamped at `metadata.source` on the user message.      |
| `senderId`           | Checked against `allowlist` when one is set.                       |

## Design notes

- **No delivery riders in the base.** Cadence buffering, content policy, rate
  limiting, retry backoff — deliberately out; compose them around `deliver`.
- **Identity vs provenance.** `identity` is _who acts_ (verified, opens the
  session as that principal); `source` is _where it came from_ (stamped
  metadata). `senderId`/`allowlist` is a gate, neither of the above.
- **Per-message actor stamping** (a second user speaking mid-session) waits on
  interceptIngress (#302); `identity` covers the session-opening half today.

_ADR 58 (connectors) · ADR 100 (the identity door)_

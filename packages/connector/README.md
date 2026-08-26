# @agentick/connector

**Turn any event source into an agent conversation.**

A connector binds the outside world — a chat platform, a webhook, a message
queue, a cron tick — to an agent running on your gateway. Inbound events become
agent turns; the agent's replies flow back out. One flat spec, one first-class
slot, no new subsystem: under the hood it's just a session.

```ts
import { createGateway } from "@agentick/gateway";
import { defineConnector } from "@agentick/connector";

const gateway = await createGateway({
  connectors: [
    defineConnector({
      name: "telegram",
      start({ inbound }) {
        bot.on("message", (m) => inbound({ messages: m.text, sessionId: `tg:${m.chat.id}` }));
        return () => bot.stop();
      },
      deliver: ({ sessionId, response }) => bot.send(chatOf(sessionId), response),
    }),
  ],
});

gateway.connectors.get("telegram")?.status; // "connected"
```

That's a complete two-way Telegram bridge. Each chat gets its own durable
session (history, tools, memory — everything a session has); each reply is the
agent's finished turn.

## Configuration is just a function

A configurable connector is a factory returning `defineConnector` — no config
schema, no registration API, just arguments:

```ts
// telegram.ts
export function telegram(config: { token: string; allowFrom?: string[] }) {
  const bot = new Bot(config.token);
  return defineConnector({
    name: "telegram",
    start({ inbound }) {
      bot.on("message", (m) =>
        inbound({ messages: m.text, sessionId: `tg:${m.chat.id}` }),
      );
      void bot.start();
      return () => bot.stop();
    },
    deliver: ({ sessionId, response }) => bot.api.sendMessage(chatOf(sessionId), response),
  });
}

// wiring
connectors: [telegram({ token: process.env.TELEGRAM_TOKEN! })],
```

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

Connectors are a gateway **built-in**: `gateway.connectors` is the harness that
runs them, sources `start` when the gateway `listen()`s, and they stop FIRST at
`close()` — ingress opens and shuts with the deployment. `start` may return a
teardown (`useEffect`-style); it runs at stop.

`messages` is the same currency `session.send` takes — full `SendMessageInput`s
(role, content blocks, per-message metadata), with a plain string as shorthand
for one user message. Multimodal events are first-class: an MMS photo rides as
an image block with a `reference` source (a claim-check your tools resolve
later), a document as a file block. The connector adds only `source`
provenance; it never buffers media bytes.

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
      messages: m.body,
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
        messages: await renderEmailPrompt(e),
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

## Streaming

Implement `stream` and every connector-initiated turn is handed to you **live**,
as web streams — the same `ReadableStream` the execution handle exposes.
`text()` projects it to plain assistant text (deltas when the model streams,
whole blocks when it doesn't); `events` is the full firehose. Pipe it wherever
bytes go:

```ts
defineConnector({
  name: "voice",
  start({ inbound }) {
    mic.on("utterance", (u) => inbound({ messages: u.transcript, sessionId: u.callId }));
  },
  stream: ({ text }) => text().pipeTo(ttsSink), // speak as tokens arrive
  deliver: ({ response }) => transcriptLog(response), // and keep the settled turn
});
```

And the inbound face pipes too — `ctx.writable()` turns the connector into a
`WritableStream` where each chunk becomes one inbound event (a bare string is
shorthand for `{ text }`):

```ts
start({ writable }) {
  socket.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(lineSplitter())
    .pipeTo(writable({ sessionId: "socket-feed" }));
}
```

Source in, agent out — both directions are standard web streams. (Two chunks
racing into one session don't collide: the second **steers** into the in-flight
turn, exactly like a user sending two quick messages.)

## On the op spine

Every hop a connector takes is an **operation** — `connectors:inbound`,
`connectors:deliver`, `connectors:start` — journaled, spanned, and visible on
the gateway bus like any other command. The trace stitches source → turn →
delivery, and `ctx` carries the same facets a tool handler gets: `log`,
`trace`, `metrics`, and `run` (mint your own journaled step around a bindings
write or a claim-check fetch).

Because the harness sits on the gateway's live interceptor cascade, **policy is
middleware, not spec surface** — allowlists, rate limits, and dedupe are one
`guard()` away, typed per verb:

```ts
gateway.guard({
  connectorsInbound: ({ connector, message }) =>
    allowlist.permits(connector, message.identity)
      ? undefined // proceed
      : { kind: "veto", reason: "not allowed" },
});
```

A vetoed inbound never reaches the app, and the veto is journaled like every
other outcome. (`onBeforeConnectorsInbound` / `onAfterConnectorsDeliver` hooks
exist too — the full ADR 80 surface.)

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
      : inbound({ messages: m.text }),
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
  connectors: [defineConnector({ name: "test", ...probe.spec })],
});
// …createApp, then:
probe.emit({ messages: "hello" });
expect(probe.delivered[0]!.response).toBe("reply");
```

## API

| `defineConnector({ … })` |                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`                   | Connector name — diagnostics + extension routing.                                                                              |
| `start(ctx)`             | **Required.** Subscribe your source; push via `ctx.inbound`. May return a teardown.                                            |
| `deliver(d)`             | _Optional._ Receive each completed turn's raw output.                                                                          |
| `stream(t)`              | _Optional._ Receive each connector-initiated turn live (`events`, `text()`, `result`, `origin` — the inbound that started it). |
| `confirm(p)`             | _Optional._ Present confirmations; answer via `ctx.confirmed`.                                                                 |
| `app`                    | Target app id. Default: the gateway's sole app, resolved lazily.                                                               |
| `session`                | Default session id. Default: `connector:<name>`.                                                                               |
| `ephemeral`              | `runOnce` per event instead of a held session.                                                                                 |

`ctx` also carries `writable(defaults?)` (the pipe-friendly twin of `inbound`),
`confirmed(reply)`, `status(s)`, `gateway` (the escape hatch: `apps()`, `as()`),
and the operation facets — `log` / `trace` / `metrics` / `run`.

| `ctx.inbound({ … })` |                                                                    |
| -------------------- | ------------------------------------------------------------------ |
| `sessionId`          | Route to a session (per chat/thread/user).                         |
| `identity`           | Verified `IngressIdentity` — open through the `as()` door.         |
| `session`            | `createSession` contribution: `title`, `metadata`, `initialProps`. |
| `send`               | Per-event send options (`output`, `allowedTools`, `tools`, …).     |
| `source`             | Provenance, stamped at `metadata.source` on the user message.      |

## Reaching connectors from the host

`gateway.connectors` is the harness: `get` / `list` / `status` for diagnostics,
`register` / `unregister` for dynamic membership, and **proactive outbound** (a
notification with no agent turn behind it) through a handle's `deliver`:

```ts
gateway.connectors.get("telegram")?.deliver({
  sessionId: "tg:8842",
  response: "Heads up — your 9am visit was rescheduled.",
});
```

## Design notes

- **No delivery riders in the base.** Cadence buffering, content policy, rate
  limiting, retry backoff — deliberately out; compose them around `deliver`.
- **Identity vs provenance.** `identity` is _who acts_ (verified, opens the
  session as that principal); `source` is _where it came from_ (stamped
  metadata). Sender gating (allowlists) is deliberately NOT API surface — it's
  a `gateway.guard()` on `connectors:inbound`, where the rest of your policy
  already lives.
- **Per-message actor stamping** (a second user speaking mid-session) waits on
  interceptIngress (#302); `identity` covers the session-opening half today.
- **No model-facing send tool, deliberately.** A `send_via_connector` tool
  would let a model in one session write into another session's external
  conversation while that session's transcript records nothing — the channel
  and its durable record fork. The model-tier primitive for reaching a
  connector-bound conversation is _messaging that session_; its reply then
  flows out through the connector's own outbound, transcript intact. The
  registry's `deliver` is host-facing on purpose: notifications, not
  conversational acts.

_ADR 58 (connectors) · ADR 100 (the identity door) · ADR 104 (the gateway built-in)_

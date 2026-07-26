# @agentick/connector

**Bind an external event source to an agent session — as ONE server-side
gateway extension.**

A connector is an **ingress binding**: an external source (Telegram,
iMessage, a webhook, an MQ consumer, a cron tick, …) holds a session and
turns each inbound event into an agentic action. **It's just a session
under the hood** — the whole point is `session.send`. It is pure
composition over primitives that already exist (ADR 58): no connector
subsystem, no bespoke `sendToSession` verb, no client-side
`ConnectorSession`.

```ts
// The base contract: external source → session action.
export function defineConnector(spec: {
  name: string;
  platform: ConnectorPlatform;
  config?: ConnectorConfig;
}): GatewayExtension;
```

## Ingress is the base; the reply path is optional

The `emit-inbound` half of a platform is **required**; `deliver` and
`presentConfirmation` are **optional**. A one-way source (webhook, queue
consumer, cron) implements only inbound and never delivers back — that is
first-class, not a degenerate case.

| Direction                    | When wired                         | Composition                                           |
| ---------------------------- | ---------------------------------- | ----------------------------------------------------- |
| **inbound** (required)       | always                             | event → `apps().getSession()` → `session.send({ … })` |
| **outbound** (optional)      | platform has `deliver`             | `subscribeBus` execution end → hand raw output over   |
| **confirmations** (optional) | platform has `presentConfirmation` | elicitation channel → prompt → `respond(…)`           |
| **teardown**                 | always                             | `onClose` → `platform.stop()`                         |

## Quick start

Implement the thin `ConnectorPlatform` adapter for your wire (or use the
`fakeConnectorPlatform` from `/testing`), then install on a gateway.

```ts
import { createGateway } from "@agentick/gateway";
import { defineConnector } from "@agentick/connector";

const gateway = await createGateway({
  extensions: [defineConnector({ name: "telegram", platform })],
});
const app = await gateway.createApp({ rootElement: <Agent />, options: { model } });
```

The connector routes to a stable session (`connector:telegram` by
default). A port that maps each chat/topic to its own session stamps
`InboundMessage.sessionId`.

### One-way ingress (no reply)

```ts
const webhook: ConnectorPlatform = {
  name: "webhook",
  start(handle) {
    server.on("POST /hook", (req) => handle.emitInbound({ text: req.body.text }));
  },
  stop() {
    server.close();
  },
  // no `deliver`, no `presentConfirmation` → inbound-only
};
```

### Outbound (optional)

Implement `deliver` to receive the agent's output when an execution
completes. It is handed **raw** — no cadence, no filtering, no chunking.
A platform that wants those composes `@agentick/formatters`
(`summarizedFormatter` / `textOnlyFormatter`) + `splitMessage` from
`@agentick/utils` itself.

```ts
const platform: ConnectorPlatform = {
  // …
  deliver({ sessionId, response, output }) {
    telegram.sendMessage(chatId, response);
  },
};
```

### Confirmations (optional)

Implement `presentConfirmation` to opt into tool-approval / elicitation
routing. The connector formats the request; you present it and relay the
user's reply via the handle.

```ts
const platform: ConnectorPlatform = {
  // …
  presentConfirmation(prompt) {
    telegram.sendMessage(chatId, prompt.message); // "Delete everything?"
  },
};
// When the user replies:
handle.respondConfirmation({ correlationId, text: "yes" });
// → session.elicitation.respond({ outcome: "accepted", value: true })
```

`"yes" / "y" / "ok" / "go ahead"` (and `"yes …"`) → `value: true`;
anything else → `value: false` (a yes/no answer, not a dismissal).

## Config

```ts
config: {
  appId?: string;                // defaults to the gateway's sole app
  sessionId?: string;            // defaults to `connector:<name>`
  allowlist?: readonly string[]; // drop inbound whose senderId isn't listed
}
```

## API

- **`defineConnector(spec): GatewayExtension`** — install via
  `createGateway({ extensions: [...] })`.
- **`ConnectorPlatform`** — `start` / `stop` required; `deliver` /
  `presentConfirmation` optional. `ConnectorHandle` (given at `start`):
  `emitInbound`, `respondConfirmation`, `reportStatus`.
- **`parseTextConfirmation` / `formatConfirmationMessage`** — the thin
  confirmation pure functions, exported for platform ports.
- **`/testing`** — `fakeConnectorPlatform({ oneWay? })`: a working
  in-memory platform recording `delivered` / `confirmations` with
  `emit` / `reply` / `replyLatest` / `report` drivers.

## Patterns

- **One session per source (default)** vs **one session per chat/topic** —
  stamp `InboundMessage.sessionId` in your port for the latter.
- **Provenance vs identity** — `InboundMessage.source` is stamped at
  `metadata.source` (typed via the `MessageSource` augmentation seam),
  _unauthenticated provenance_, distinct from the authenticated actor
  (`RuntimeContextUser`). See Status.
- **Platform-side delivery sophistication** — cadence, content policy,
  chunking, retry live in the platform port (compose `formatters-next` +
  `splitMessage`), not the base. See Roadmap.

## Status

Base package: **shipping**. Composes a real gateway + app + session end
to end, verified against a `fakeConnectorPlatform` — inbound → `send` +
`metadata.source`, one-way ingress (no deliver), optional outbound
hand-off, optional confirmation routing.

**Identity — service account now, per-message actor backfilled.** A
connector attributes inbound to its construction-bound service-account
principal, carrying the unauthenticated platform handle as
`MessageSource` provenance (strictly more than v1's zero identity). The
single site where an authenticated `RuntimeContextUser` will be stamped
is marked `TODO(#302: per-message actor stamping)` in
`define-connector.ts` at the `session.send` call — it backfills when
`interceptIngress` lands (ADR 34 / #302).

## Roadmap & known gaps

- **Delivery sophistication is deferred** — cadence strategies
  (immediate/on-idle/debounced), content-policy filtering, rate limiting,
  and retry backoff were premature v1 ports. They land once we have the
  lay of the land, likely as platform-port helpers or an opt-in rider —
  NOT baked into the base. `summarizedFormatter` / `textOnlyFormatter`
  (formatters-next) and `splitMessage` (utils-next) already ship
  standalone for a port to compose.
- **Platform ports** — `@agentick/connector-telegram` /
  `@agentick/connector-imessage` are deferred (gated on their
  SDKs). This package ships the base + a fake platform.
- **Authenticated per-message actor** — gated on #302 (see Status).
- **Ingress action beyond `send`** — the action defaults to
  `session.send`; the shape leaves the seam open for
  `session.dispatch` / `app.run` routing later (not built yet).

## Verified by

- `src/__tests__/connector.spec.tsx` — the flow through a real
  gateway/app/session with `fakeConnectorPlatform`: inbound → `send` +
  `metadata.source`; one-way ingress (no deliver); optional outbound
  hand-off; confirmation present → `respond` (yes=true / no=false).
- `src/__tests__/confirmations.spec.ts` — the confirmation pure functions.

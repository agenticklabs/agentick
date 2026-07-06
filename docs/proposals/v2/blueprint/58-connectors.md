# ADR 58 — Connectors: an external event source bound to an agentic action, as one gateway-extension shape

**Status:** PROPOSED 2026-07-06 (Fable, for Ryan). Fork-1 (identity) proceeding on
**ship-now + backfill actors** per the cut-ASAP directive — confirm or redirect.
**Amended 2026-07-06** (Ryan): generalized from "chat surface" to **ingress edge** — see
the amendment at the end. The base contract stays; outbound becomes optional.
**Depends on:** ADR 50 (GatewayExtension / GatewayInstaller), ADR 42/45 (runtime context,
actor slot), the ElicitationHarness (confirmation channel), #210 (splitMessage → utils-next)
**Gated (actor attribution ONLY):** #146 / #302 / ADR 34 (`interceptIngress`,
`IngressIdentity → RuntimeContextUser`)
**Closes:** #154 (design). **Supersedes:** the v1 `GatewayPlugin` ↔ `ConnectorPlatform`
dualism.

## TL;DR

A **connector binds a chat surface (Telegram, iMessage, …) to an agent session**: inbound
platform messages → `session.send`; outbound agent output → platform-native delivery. In
v2 a connector is **a server-side `GatewayExtension` that composes existing primitives** —
no new subsystem, no new supertype, no bespoke inbound verb:

- **inbound** → `installer.gateway.apps().getSession().send()` (the session verb is already
  live; `SessionHarnessProtocol.send()` is callable in-process — no wire hop);
- **confirmations** → subscribe the elicitation channel via `subscribeBus`, format the
  request for the platform, route the reply through `session.elicitation.respond`
  (`session/respondToElicitation` is already wired,
  `gateway/src/wire/session-extension.ts:117`);
- **the four v1 client-side behaviors** (delivery cadence, content policy, rate-limit,
  retry) become small composed helpers, not a framework tier.

This **collapses the v1 dualism** onto one shape: v1 shipped connectors two incompatible
ways — a server-side `GatewayPlugin` (Telegram: `ctx.sendToSession` /
`ctx.respondToConfirmation`, re-implementing the four behaviors ad hoc) and a client-side
`ConnectorPlatform` + `ConnectorSession` (iMessage, over a `ConnectorBridge`). The
client-side `ConnectorSession` **cannot be rebuilt in v2** (`client-next` is a low-level RPC
client — `grep MessageLog|ToolConfirmations packages-next/client/src` = zero; the v1
`ConnectorSession` composed `@agentick/client`'s `MessageLog`+`ToolConfirmations` which do
not exist here). So **both platforms become the one server-side gateway-extension shape**;
the `GatewayPlugin` path dies.

## The contract

```ts
// @agentick/connector-next (base) — the composition primitive
export function defineConnector(spec: {
  name: string;
  platform: ConnectorPlatform;          // thin adapter: start/stop/emit-inbound/deliver-outbound
  config?: ConnectorConfig;             // delivery strategy, content policy, rate/retry, allowlist
}): GatewayExtension;                    // target: "gateway"
```

`defineConnector`'s `install(installer)` (the `GatewayExtension` hook, ADR 50
`spec/src/protocol/app-extension.ts:359`):

- resolves the target app/session via `installer.gateway.apps()` →
  `AppHarnessProtocol.getSession()/createSession()` (`app-harness.ts:240,258`);
- starts `platform.start(...)`; on inbound, wraps text into a user message stamped with
  `metadata.source` (see MessageSource) and calls `session.send({ messages })`;
- `subscribeBus`-subscribes the session's elicitation channel; on an elicitation request,
  formats it for the platform (approve/deny → inline keyboard; free-form → text prompt) and
  routes the reply via `session.elicitation.respond`;
- registers outbound delivery through the composed helpers below;
- `onClose` → `platform.stop()`.

**`ConnectorPlatform`** stays a thin adapter (`start`/`stop`/`status` + emit-inbound /
deliver-outbound); **`ConnectorBridge` is dropped** (it existed only to decouple the
now-retired client-side `ConnectorSession`). Fork 4 resolved: thin platform, no bridge.

## The four v1 behaviors — composed, not a tier

| Behavior | v1 home | v2 home (resolved) |
| --- | --- | --- |
| **Delivery cadence** (`immediate`/`on-idle`/`debounced`) | `DeliveryBuffer` (`connector/src/delivery-buffer.ts:20`) | Port `DeliveryBuffer` into `connector-next` — a debounce over `subscribeBus` events (`poke` on content, `markIdle` on `execution_end`). No cadence primitive exists in pubsub/subscriptions (checked); a generic `utils-next` debounce is a candidate enabler, not required. |
| **Content policy** (`full`/`text-only`/`summarized`) | `content-pipeline.ts` + `ToolSummarizer` | **`formatters-next`** — pure content→content is `createFormatter` territory. Ship `summarizedFormatter` / `textOnlyFormatter`. |
| **Rate limit** (inbound sliding window) | `RateLimiter` (`delivery-buffer.ts:107`) | Inbound **procedure middleware** wrapping the `session.send` call; keep `RateLimiter` as a portable helper. |
| **Retry** (outbound backoff) | `_deliverWithRetry` (`connector-session.ts:291`) | Connector-local backoff helper — it's a **platform-SDK-call** retry, not an Agentick wire (`client-extensions-next/retry` is the wrong layer). utils-next has no retry primitive today; a generic one is a candidate enabler. |

`splitMessage` (Telegram 4096 cap) is already canonical in v1 `@agentick/shared`; v2 has no
`shared`, so it ports to `utils-next` (#210, filed). Confidence: high on all homes.

## MessageSource — an augmentation seam, not a foundational field

Inbound messages carry provenance (`imessage:{type,handle}`, `telegram:{chatId}`). v1 used
an augmentable `MessageSource`/`MessageSourceTypes` registry; `grep MessageSource
packages-next` = zero. `MessageMetadata` (`spec-next/data/entries.ts:38`) already has an
open index (`[key:string]: unknown`), so `metadata.source` is buildable today.

**Resolution (overriding the survey's "typed field on MessageMetadata" lean):** per the
framework principle *spec does NOT hardcode foundational slots* (CLAUDE.md; the
`HookBridges`/`RenderContext`/`ProviderOptions` empty-seed pattern), `MessageSource` is an
**empty-seed augmentable interface in `spec-next`** (`data/message-source.ts`) that platform
packages augment (`declare module` — `connector-imessage-next` adds its `imessage` slot),
stamped at `metadata.source`. This keeps a connector-provenance concept **out** of the
foundational message shape while staying typed + discoverable through the augmentation. It
is **provenance, distinct from identity** — `RuntimeContextUser` (ADR 45, `runtime-next`) is
the authenticated actor; `MessageSource` is "which surface/handle this came from."

## Identity model — service account now, per-message actor backfilled (#302)

A connector holds a **construction-bound service-account principal** (ADR 48 §5
immutability). Each inbound message *should* carry a **per-message actor** (the Telegram
user / iMessage handle) as a `RuntimeContextUser` on the session runtime context. Token →
principal exists at the transport edge (`transport-websocket/src/server/server.ts:87`;
`connection-context.ts:45,98`), **but a connector is a server-side gateway-extension, not a
token-presenting wire client** — it must *stamp* an actor onto each `session.send` on behalf
of a platform user, and that stamping seam (`interceptIngress`, `IngressIdentity →
RuntimeContextUser`) is **deferred to #302 / ADR 34** (ADR 50 amendment §1,
`50-gateway-extensions.md:24-40`).

**Fork 1 — RESOLVED as ship-now + backfill** (cut-ASAP; confirm): connector-next +
telegram/imessage land with the service-account principal; inbound messages attribute to
the service account, with `MessageSource` provenance carrying the *unauthenticated* platform
handle. A **loud `TODO(#302: per-message actor stamping)`** marks the single site where an
authenticated `RuntimeContextUser` actor will be stamped once `interceptIngress` lands. This
is **parity+**: v1 connectors had *zero* identity (Telegram `allowedUsers` is a whitelist
gate, not identity), so the service-account model with provenance is strictly more than v1,
not a regression. Only the **authenticated per-user actor** waits on #302 — the connectors
themselves ship now.

## Package layout

`connector-next` (base — `defineConnector`, `ConnectorPlatform`, `ConnectorConfig`, the
ported `DeliveryBuffer`/`RateLimiter`/retry helpers) + `connector-telegram-next` +
`connector-imessage-next`. None exist (confirmed). Each is the full new-package checklist
(package.json/tsconfigs/index, changeset linked array, typedoc entry, vitepress
PACKAGE_GROUPS, README with tiered examples, `pnpm install`). The Telegram port additionally
**collapses the GatewayPlugin↔ConnectorPlatform dualism** onto the single extension shape.

## Rejected

- **A bespoke `GatewayInstallerHost.sendToSession` / `respondToConfirmation` verb.** The
  audit flagged these as "missing," but they're reachable by composition —
  `installer.gateway.apps()` → `getSession().send()` and the elicitation channel. Adding a
  verb duplicates the session/elicitation surface. Compose.
- **Rebuilding the client-side `ConnectorSession` on `client-next`.** `MessageLog` /
  `ToolConfirmations` do not exist there; `client-extensions-next` is cache/offline/retry/
  telemetry. Server-side gateway-extension is the only coherent v2 home.
- **`MessageSource` as a typed field on `MessageMetadata`.** Hardcodes a connector concept
  into the foundational message shape — against the empty-seed principle. Augment instead.
- **A connector "subsystem"/supertype.** It's a composition of gateway-extension + session
  send + elicitation channel + formatters + a debounce + a rate-limit middleware. No tier.

## Scope

Design only (this ADR). Implementation = `connector-next` base + the two platform ports,
gated on the platform SDKs; the **authenticated per-message actor** is gated on #302 (the
base connector + service-account attribution are not). Land `summarizedFormatter` in
`formatters-next` and `splitMessage` in `utils-next` (#210) as the shared prerequisites.

## Open fork still worth your eye

Fork 1 (block vs. ship-now-backfill) is proceeding as **ship-now-backfill**. If you'd rather
the authenticated-actor story be correct from day one, we block connectors on #302 and they
slip past it — say so and I'll flip the identity section.

## Amendment 2026-07-06 — connectors are the ingress EDGE (reply-optional, action-pluggable)

The body above frames a connector as a **chat surface** with inbound + outbound. That is
one *instance* of a more general primitive, and the general one is what the base package
must model. Ryan's framing: **anything that ingresses can be a connector** — an event
queue, a webhook, a bus subscriber, a cron trigger. There is **no reason to require a
reply.** A connector is fundamentally *an external event source bound to an agentic
action*; the outbound/delivery half is the **conversational specialization**, not part of
the core.

### The decomposition

| Axis | Options |
| --- | --- |
| **Trigger** — what ingresses | chat surface · webhook · event-queue / MQ consumer · bus subscription · cron / scheduler (#159) · file-watch |
| **Action** — what the ingress drives | `session.send` (conversational append) · `session.dispatch` (fire a procedure — a non-conversational *agentic process*) · `app.run` (one-shot workflow) · spawn |
| **Outbound** — the reply/emit path | reply to the source (chat) · emit to a *different* sink (fan-out) · **none** (one-way) |

**One-way is the base case; bidirectional chat is the specialization.** A webhook that
fires a workflow and returns nothing, an MQ consumer that dispatches a procedure per
message, a cron trigger that spawns a one-shot run — all are connectors with `Outbound =
none` and `Action ≠ send`. That is **reactive / event-driven agents as a first-class
shape**: an event fires, an agent runs, maybe it writes to a sink, nobody is chatting.

### The unification (why this matters beyond chat)

This collapses three things we were treating separately — **connectors, the scheduler's
event-source extension (#159), and webhooks are the same primitive**: a `GatewayExtension`
whose `install()` binds an external event source to a session action. "Connector" stays the
right general name — it *connects an external system to agentick*; chat is one instance.

### Contract impact (broaden the framing — NOT a new tier)

The ADR-58 contract is already almost this general; it was framed conversationally. The
adjustments, all additive:

- **`ConnectorPlatform.deliver` is OPTIONAL.** Emit-inbound is required (it's the source);
  deliver-outbound is opt-in. `install()` only wires the `DeliveryBuffer` / content-policy /
  confirmation subscription when `deliver` is present. No `deliver` ⇒ clean inbound-only.
- **The ingress action is pluggable.** Default `session.send`; the seam must not *preclude*
  `session.dispatch` / `app.run`. (Only the `send` default lands now; the seam stays clean.)
- **Core names/docs are not "conversational."** The base contract is "external source →
  session action"; the chat delivery machinery is the optional layer it always was.
- **Identity is unchanged:** a one-way source still holds the construction-bound
  service-account principal; a per-event actor (if any) rides the event and backfills via
  #302 — same `TODO(#302)` seam.

**Steel-man (why no new subsystem):** we do *not* introduce an `IngressSource` supertype or
a parallel tier. The existing `ConnectorPlatform` *is* the ingress source; making its egress
optional + keeping the action seam open covers webhooks/queues/cron without a new abstraction.
Compose, don't tier.

### Rider issues (file after the base lands)

- `connector-webhook-next` (HTTP ingress → session action, one-way or request/response).
- Event-queue / bus-subscription connector (one-way, `dispatch`/`run` action).
- Wire the scheduler (#159) as a cron-trigger connector rather than a separate mechanism.
- The `dispatch` / `run` ingress actions (only `send` ships in the base).

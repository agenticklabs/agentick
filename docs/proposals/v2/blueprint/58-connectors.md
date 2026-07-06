# ADR 58 — Connectors: a chat surface bound to a session, as one gateway-extension shape

**Status:** PROPOSED 2026-07-06 (Fable, for Ryan). Fork-1 (identity) proceeding on
**ship-now + backfill actors** per the cut-ASAP directive — confirm or redirect.
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

/**
 * `MessageSource` — an empty-seed augmentation slot for message
 * **provenance**.
 *
 * Inbound messages that enter a session from an external chat surface
 * (Telegram, iMessage, a web widget, …) carry a record of WHICH surface
 * and WHICH handle they came from. That record is provenance — it is
 * stamped at `MessageMetadata.source` (the `[key: string]: unknown` open
 * index on {@link MessageMetadata} already permits the key; this type is
 * what makes it *typed* and *discoverable*).
 *
 * **Empty-seed, per ADR 27 (modular built-ins).** Mirroring the
 * `HookBridges` / `ProviderOptions` / `EventScopeExtensions` pattern, the
 * spec ships an empty surface and platform packages contribute slots via
 * TypeScript module augmentation. The spec hardcodes no platform shape:
 *
 * ```ts
 * // in @agentick/connector-telegram
 * declare module "@agentick/spec" {
 *   interface MessageSource {
 *     readonly telegram?: { readonly chatId: number; readonly userId?: number };
 *   }
 * }
 *
 * // in @agentick/connector-imessage
 * declare module "@agentick/spec" {
 *   interface MessageSource {
 *     readonly imessage?: { readonly type: "dm" | "group"; readonly handle: string };
 *   }
 * }
 * ```
 *
 * Adopters who install a platform package see its slot typed on
 * `metadata.source`; adopters who don't, never see it.
 *
 * **Convention: stamp at `metadata.source`.** A connector wraps inbound
 * platform text into a `SendMessageInput` (or the projected
 * {@link MessageEntry}) with `metadata: { source: { <platform>: … } }`.
 * Because `MessageSource` is a module-augmentable empty-seed interface it
 * cannot itself be a typed field on the foundational
 * {@link MessageMetadata} shape without hardcoding a connector concept
 * into the message model — so it lives in the open metadata bag and this
 * type documents the shape a reader casts to.
 *
 * **Provenance, NOT identity.** `MessageSource` answers "which surface /
 * handle did this arrive on"; it is *unauthenticated* transport
 * coordinates. It is deliberately distinct from `RuntimeContextUser`
 * (ADR 45, `@agentick/runtime`) — the authenticated actor a piece of
 * work runs *on behalf of*. A connector today stamps `MessageSource`
 * provenance while attributing the work to its construction-bound
 * service-account principal; the per-message authenticated actor is
 * backfilled when `interceptIngress` lands (ADR 34 / #302). Do not
 * conflate the two: one is where it came from, the other is who it's for.
 *
 * @see docs/proposals/v2/blueprint/58-connectors.md §MessageSource
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageSource {}

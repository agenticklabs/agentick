/**
 * Client hooks (ADR 83 §"Wire dispatch through the seam") — the typed
 * `WireMethods` → `onBefore…` / `onAfter…` derivation, the client-side
 * twin of the server's `CommandRegistry` → `CommandHooks`
 * (`@agentick/runtime`). ONE derivation, both sides: this reuses the
 * SAME context-agnostic `HooksOf` / `RegistrarsOf` generics from
 * `../hooks/derivation.js` — no duplication.
 *
 * The client hook MIRRORS the session op it initiates. A client is the
 * side that INITIATES the send the session executes, so its outbound
 * hook for `session/send` is `onBeforeSessionSend` — the same name as
 * the session's op hook, because it IS that send observed from the
 * initiating end. No `wire:` prefix here.
 *
 * The `Wire` qualifier belongs to the GATEWAY, not the client. It exists
 * only at the gateway's wire-dispatch boundary, where the inbound
 * `wire:session/send` op and the folded `session:send` op genuinely
 * COLLIDE under live inheritance and must stay distinguishable. The
 * client has no such collision — no `session:send` op of its own — so it
 * keeps the plain name.
 *
 * @see docs/proposals/v2/blueprint/83-one-interceptor-primitive.md
 */

import type { HooksOf, RegistrarsOf } from "../hooks/derivation.js";
import type { WireMethods, WireMethod } from "../wire/params.js";

/**
 * Ambient context every client hook receives as its second arg — the
 * wire method being dispatched plus the caller's `AbortSignal` (if any).
 * The client-side analogue of the server's `RuntimeContext`, kept
 * deliberately thin: the client has no fiber, no op tree — just the
 * method + signal that frame the request.
 */
export interface ClientHookContext {
  readonly method: WireMethod;
  readonly signal?: AbortSignal;
}

/**
 * Adapt the wire method registry into the shape `HooksOf` / `RegistrarsOf`
 * expect (`{ input; output }`). `params` → `input`, `result` → `output`;
 * the key is the method id verbatim, so `session/send` `Pascal`s to
 * `SessionSend` (no prefix) — mirroring the session op the client
 * initiates.
 */
type WireAsCommandReg = {
  [K in keyof WireMethods]: {
    input: WireMethods[K]["params"];
    output: WireMethods[K]["result"];
  };
};

/**
 * The declarative client-hook surface — `{ onBeforeSessionSend?,
 * onAfterSessionSend?, … }`, one before/after pair per wire method.
 * The type `client.hook(config)` accepts.
 */
export type ClientHooks = HooksOf<WireAsCommandReg, ClientHookContext>;

/**
 * The imperative registrar surface — the same names as {@link ClientHooks}
 * valued as `(fn) => Unsubscribe` methods. Reached via the `client.hooks`
 * Proxy: `client.hooks.onBeforeSessionSend(fn)`.
 */
export type ClientRegistrars = RegistrarsOf<WireAsCommandReg, ClientHookContext>;

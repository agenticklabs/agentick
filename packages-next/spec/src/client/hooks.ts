/**
 * Client wire hooks (ADR 83 §"Wire dispatch through the seam") — the
 * typed `WireMethods` → `onBeforeWire…` / `onAfterWire…` derivation, the
 * client-side twin of the server's `CommandRegistry` → `CommandHooks`
 * (`@agentick/runtime-next`). ONE derivation, both sides: this reuses the
 * SAME context-agnostic `HooksOf` / `RegistrarsOf` generics from
 * `../hooks/derivation.js` — no duplication.
 *
 * The `wire:` prefix is the whole point. A wire method (`session/send`)
 * derives `onBeforeWireSessionSend`, NOT `onBeforeSessionSend` — that
 * latter name belongs to the SERVER's `session:send` op hook. The prefix
 * keeps the two hop-hooks distinct in the type surface while letting the
 * SAME name (`onBeforeWireSessionSend`) address BOTH wire hops (the
 * client request leaving · the gateway wire dispatch arriving) — the
 * symmetry the ADR turns on.
 *
 * @see docs/proposals/v2/blueprint/83-one-interceptor-primitive.md
 */

import type { HooksOf, RegistrarsOf } from "../hooks/derivation.js";
import type { WireMethods, WireMethod } from "../wire/params.js";

/**
 * Ambient context every client wire hook receives as its second arg —
 * the wire method being dispatched plus the caller's `AbortSignal` (if
 * any). The client-side analogue of the server's `RuntimeContext`, kept
 * deliberately thin: the client has no fiber, no op tree — just the
 * method + signal that frame the request.
 */
export interface ClientHookContext {
  readonly method: WireMethod;
  readonly signal?: AbortSignal;
}

/**
 * Adapt the wire method registry into the shape `HooksOf` / `RegistrarsOf`
 * expect (`{ input; output }`) AND apply the `wire:` key prefix in one
 * mapped type. `params` → `input`, `result` → `output`; `session/send`
 * → `wire:session/send`, so `Pascal` yields `WireSessionSend`.
 */
type WireAsCommandReg = {
  [K in keyof WireMethods as `wire:${K & string}`]: {
    input: WireMethods[K]["params"];
    output: WireMethods[K]["result"];
  };
};

/**
 * The declarative client wire-hook surface — `{ onBeforeWireSessionSend?,
 * onAfterWireSessionSend?, … }`, one before/after pair per wire method.
 * The type `client.hook(config)` accepts.
 */
export type WireHooks = HooksOf<WireAsCommandReg, ClientHookContext>;

/**
 * The imperative registrar surface — the same names as {@link WireHooks}
 * valued as `(fn) => Unsubscribe` methods. Reached via the `client.hooks`
 * Proxy: `client.hooks.onBeforeWireSessionSend(fn)`.
 */
export type WireRegistrars = RegistrarsOf<WireAsCommandReg, ClientHookContext>;

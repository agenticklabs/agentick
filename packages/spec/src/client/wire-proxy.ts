/**
 * The **session wire proxy** — the mapped type that DERIVES the client session
 * handle's namespace methods directly from the `WireMethods` registry (B2 slice
 * 4, `docs/proposals/v2/client-handles.md` §"SLICE-4 SPEC v2"). The other half of
 * "handle = WIRE PROXY + VIEW FACTORY".
 *
 * A wire row `"<ns>/<method>": { params; result }` whose params carry a bound
 * `sessionId` becomes `session.<ns>.<method>(params-minus-sessionId) =>
 * Promise<result>`. The type is the SINGLE SOURCE OF TRUTH for what the client
 * can call: only server-typed rows EXIST on it, so a typo (`session.billing.aprove`)
 * is a compile error, not a 404, and the runtime Proxy in
 * `@agentick/client-core` is CAST to this type — it never widens it.
 *
 * ## Why this shape (the IntelliSense contract — Ryan 2026-07-22)
 *
 * Every construct here is KEY-DRIVEN so autocomplete stays exact:
 *   - `session.` enumerates the namespaces (keys of {@link SessionWireNamespaces}),
 *   - `session.<ns>.` enumerates that namespace's methods,
 *   - params + result hover-type from the row.
 *
 * There is deliberately **NO index signature, NO `any`, NO `Record<string, Fn>`**
 * anywhere on this surface — each of those collapses autocomplete to "any string"
 * and is rejected. The `${infer …}` template-literal splits and key remaps keep
 * the key set finite and finite-hoverable. Type-level tests
 * (`spec/src/__tests__/wire-proxy.type.spec.ts`) pin namespace enumeration,
 * per-row param/result inference, and typo-rejection so IntelliSense dying in a
 * future refactor breaks CI rather than vibes.
 *
 * @see docs/proposals/v2/client-handles.md §"SLICE-4 SPEC v2"
 * @see docs/proposals/v2/guide-wire-and-client.md §1
 */

import type { WireMethod, WireParams, WireResult } from "../wire/params.js";

/**
 * A params object with the bound `sessionId` projected out — the handle carries
 * addressing, so callers never pass it (`session.billing.approve({ orderId })`).
 * Homomorphic (`Omit` = `Pick<…, Exclude<…>>`) so per-member JSDoc on the params
 * interface survives to hover.
 */
export type OmitSessionId<P> = Omit<P, "sessionId">;

/**
 * The wire methods ADDRESSED BY a session — params carry a bound `sessionId`
 * and are NOT app-addressed (no `appId`). The `appId` guard is what separates a
 * session SUB-namespace (`knobs/set`, `billing/approve`) from an app-scoped
 * method that merely references a session (`app/get_session`, whose primary
 * address is the app). `initialize`, `ping`, `sub/*`, `auth/*`, `_extensions/*`
 * have no `sessionId` at all, so they never surface either.
 *
 * A `gateway/*` row that names a session is filtered one step later, by
 * {@link SessionWireNamespace}, not here — the gateway is the runtime ROOT, so
 * there is no `gatewayId` param for a guard to key on the way `appId` works.
 */
export type SessionScopedMethod = {
  [M in WireMethod]: WireParams<M> extends { readonly sessionId: string }
    ? WireParams<M> extends { readonly appId: string }
      ? never
      : M
    : never;
}[WireMethod];

/** The namespace segment (`"knobs"`) of a `"<ns>/<method>"` wire id. */
export type WireNamespaceOf<M extends string> = M extends `${infer NS}/${string}` ? NS : never;

/**
 * Every session-scoped namespace EXCEPT the RESOURCE-HANDLE namespaces —
 * `gateway` / `app` / `session` are addressed by their own handles, so none of
 * them is ever a session SUB-namespace.
 *
 * `session/*` rows are the session handle's OWN hand-written methods (`send`,
 * `dispatch`, …), not a `session.session`. `app/*` rows are already filtered
 * upstream by the `appId` guard. `gateway/*` needs naming HERE because the
 * gateway is the runtime root: a row like `gateway/destroy_session` names a
 * session as its argument while being addressed by the gateway, and there is no
 * `gatewayId` param for an upstream guard to key on — so without this exclusion
 * a root-addressed verb would surface as `session.gateway.destroy_session`,
 * which reverses what it is for (reaching a session WITHOUT naming its app).
 */
export type SessionWireNamespace = Exclude<
  WireNamespaceOf<SessionScopedMethod>,
  "session" | "gateway"
>;

/**
 * The methods of one namespace `NS` as params-object functions with `sessionId`
 * bound out and the result typed from the row. Key-remapped off the template
 * split, so the key set is exactly `NS`'s methods (no index signature).
 */
export type WireNamespaceMethods<NS extends string> = {
  [M in SessionScopedMethod as M extends `${NS}/${infer Method}` ? Method : never]: (
    params: OmitSessionId<WireParams<M & WireMethod>>,
  ) => Promise<WireResult<M & WireMethod>>;
};

/**
 * The full derived wire-proxy surface: one object per {@link SessionWireNamespace},
 * each carrying that namespace's derived methods. Intersected into `SessionHandle`
 * (minus the namespaces a rich sub-handle already owns), it is what makes
 * `session.<ns>.<method>(…)` typed end-to-end with zero client code.
 */
export type SessionWireNamespaces = {
  [NS in SessionWireNamespace]: WireNamespaceMethods<NS>;
};

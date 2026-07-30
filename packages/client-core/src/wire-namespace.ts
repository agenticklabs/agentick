/**
 * Wire-namespace SYNTHESIS — the one place a `session.<ns>.<method>(params)`
 * call is turned into `client.request("<ns>/<method>", { sessionId, ...params })`.
 *
 * Two consumers, one synthesis:
 *   - {@link makeWireNamespace} — a WHOLE namespace nobody registered a rich
 *     sub-handle for (`session.billing`). Every accessed method synthesizes; the
 *     mapped `SessionWireNamespaces` type is the guard against typos.
 *   - {@link wireFallthrough} — one level DOWN: a registered sub-handle
 *     (`session.timeline`) that owns SOME of its namespace's rows and leaves the
 *     rest to the wire. The handle's own members always win; the declared
 *     leftovers synthesize; everything else is `undefined`.
 *
 * @see packages/spec/src/client/wire-proxy.ts — the type half of the same seam
 * @verifiedBy packages/client-core/src/__tests__/wire-namespace.spec.ts
 */

import type { ClientProtocol, WireMethod } from "@agentick/spec";

/** The client surface a synthesized wire call needs — just the request seam. */
export interface WireCallClient {
  request: ClientProtocol["request"];
}

/** The synthesized call for one `<namespace>/<method>` row, `sessionId` bound in. */
type WireCall = (params?: Record<string, unknown>) => Promise<unknown>;

function wireCall(
  client: WireCallClient,
  sessionId: string,
  namespace: string,
  method: string,
): WireCall {
  const wireMethod = `${namespace}/${method}` as WireMethod;
  return (params?: Record<string, unknown>) =>
    client.request(wireMethod, { sessionId, ...(params ?? {}) } as never);
}

/**
 * Synthesize a namespace object for `namespace` whose every accessed method `m`
 * issues `client.request("<namespace>/<m>", { sessionId, ...params })`. No
 * per-method knowledge is needed — a typo can't compile (the mapped type is the
 * guard), and an unknown-at-runtime method is rejected by the server. Method
 * functions are memoized so `ns.m === ns.m`.
 */
export function makeWireNamespace(
  client: WireCallClient,
  sessionId: string,
  namespace: string,
): unknown {
  const methodCache = new Map<string, WireCall>();
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      let fn = methodCache.get(prop);
      if (fn === undefined) {
        fn = wireCall(client, sessionId, namespace, prop);
        methodCache.set(prop, fn);
      }
      return fn;
    },
  });
}

/**
 * Wrap a registered sub-handle so the REST of its wire namespace stays reachable
 * (`session.timeline.compact(…)` alongside the hand-written
 * `session.timeline.history(…)`). Precedence, in order:
 *
 *   1. **The handle's own member wins — always.** `Reflect.has` is the `in`
 *      operator, so inherited/prototype methods count: a class-based handle is
 *      served exactly like an object literal. This holds EVEN when a wire row of
 *      the same name exists, and that shadowing is deliberate, not accidental:
 *      `state.get(key)` / `skills.get(name)` / `prompts.get(name)` are SYNC
 *      snapshot reads with a different contract from the async `state/get`,
 *      `skills/get`, `prompts/get` rows. The handle's contract is the published
 *      one; the row stays shadowed.
 *   2. Otherwise, a DECLARED row in `wireMethods` synthesizes its wire call
 *      (memoized, so the method's identity is stable across reads).
 *   3. Otherwise `undefined` — the same answer a plain object gives.
 *
 * Rule 3 is why `wireMethods` is an explicit list rather than blind synthesis:
 * a proxy that answered every name with a function would make every handle
 * duck-type as `Respondable`/`Enumerable` (`isRespondable`, `isEnumerable` test
 * `typeof x.respond === "function"`), breaking the runtime feature detection
 * generic tooling binds on. An UNLISTED row is merely
 * unreachable (the status quo); a LISTED one that the server doesn't serve fails
 * loudly at call time.
 *
 * Reads resolve against the TARGET, and a method comes back BOUND to it, because
 * the alternative calls the handle's methods with `this` = the proxy — which is a
 * hard `TypeError` the moment a class-based handle touches a `#private` field.
 * Both the bound methods and the synthesized calls are memoized, so member
 * identity is stable across reads and a
 * `useSyncExternalStore(h.subscribe, h.list)` binding does not resubscribe on
 * every render.
 */
export function wireFallthrough<T extends object>(
  handle: T,
  client: WireCallClient,
  sessionId: string,
  namespace: string,
  wireMethods: readonly string[],
): T {
  const rows = new Set(wireMethods);
  const memo = new Map<string, unknown>();
  return new Proxy(handle, {
    get(target, prop) {
      if (typeof prop !== "string") return Reflect.get(target, prop);
      if (memo.has(prop)) return memo.get(prop);
      if (Reflect.has(target, prop)) {
        const own = Reflect.get(target, prop);
        if (typeof own !== "function") return own; // getters stay live — never memoized
        const bound = (own as (...a: unknown[]) => unknown).bind(target);
        memo.set(prop, bound);
        return bound;
      }
      if (!rows.has(prop)) return undefined;
      const fn = wireCall(client, sessionId, namespace, prop);
      memo.set(prop, fn);
      return fn;
    },
    has(target, prop) {
      return Reflect.has(target, prop) || (typeof prop === "string" && rows.has(prop));
    },
  });
}

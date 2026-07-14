/**
 * Client sub-handle registry (ADR 87) — the client-side twin of the server's
 * `HookBridges` assembly. Harness `/client` packages call
 * {@link registerSessionHandleExtension} (a side-effect on import) to contribute a
 * typed sub-handle (`session.tasks`, `session.knobs`, …); `makeSessionHandle`
 * spreads the registered factories onto the handle as LAZY getters, so a
 * sub-handle (which may open a channel subscription) is built only when first
 * touched, and cached thereafter. Client-core stays agnostic — it holds the
 * registry, not the slots.
 *
 * @see docs/proposals/v2/blueprint/87-client-sub-handles.md
 * @verifiedBy packages-next/client/src/__tests__/session-handle-extensions.spec.ts
 */

import type { ClientProtocol } from "@agentick/spec-next";

/** Builds one sub-handle for a session. Registered by a harness `/client` package. */
export type SessionSubHandleFactory = (client: ClientProtocol, sessionId: string) => unknown;

const registry = new Map<string, SessionSubHandleFactory>();

/**
 * Register a per-session sub-handle under `name` (e.g. `"tasks"`, `"knobs"`).
 * Called ONCE per harness client package at import time; the matching
 * `declare module "@agentick/spec-next" { interface SessionHandleExtensions … }`
 * types the slot. Idempotent-by-last-write; a second registration of the same
 * name wins (dev/HMR-friendly).
 */
export function registerSessionHandleExtension(name: string, make: SessionSubHandleFactory): void {
  registry.set(name, make);
}

/** Test/introspection hook — the currently-registered sub-handle names. */
export function registeredSessionHandleExtensions(): readonly string[] {
  return [...registry.keys()];
}

/**
 * Define a lazy, cached getter on `handle` for every registered sub-handle.
 * Called by `makeSessionHandle` after the base handle is built. The factory runs
 * on first property access (opening any subscription then, not at handle
 * construction), and the result is memoized for the handle's lifetime.
 */
export function applySessionHandleExtensions(
  handle: object,
  client: ClientProtocol,
  sessionId: string,
): void {
  for (const [name, make] of registry) {
    if (name in handle) continue; // never shadow a real handle member
    let built: unknown;
    let done = false;
    Object.defineProperty(handle, name, {
      configurable: true,
      enumerable: true,
      get() {
        if (!done) {
          built = make(client, sessionId);
          done = true;
        }
        return built;
      },
    });
  }
}

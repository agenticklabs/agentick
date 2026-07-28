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
 * @verifiedBy packages/client-core/src/__tests__/session-handle-extensions.spec.ts
 * @verifiedBy packages/client-core/src/__tests__/sub-handle-import-diagnostics.spec.ts
 */

import { AgentickError, registerAgentickError, type ClientProtocol } from "@agentick/spec";

/** Builds one sub-handle for a session. Registered by a harness `/client` package. */
export type SessionSubHandleFactory = (client: ClientProtocol, sessionId: string) => unknown;

const registry = new Map<string, SessionSubHandleFactory>();

/**
 * Register a per-session sub-handle under `name` (e.g. `"tasks"`, `"knobs"`).
 * Called ONCE per harness client package at import time; the matching
 * `declare module "@agentick/spec" { interface SessionHandleExtensions … }`
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

// ============================================================================
// Diagnostics — the forgotten `/client` import
// ============================================================================

/**
 * Slot name → the `/client` subpath whose import registers it.
 *
 * A DIAGNOSTICS DICTIONARY: plain string literals, so client-core carries the
 * knowledge without ever importing a harness package (the dependency graph stays
 * one-way — harness `/client` → client-core, never back). It is consulted on
 * exactly ONE path: a session-handle property access that found no registered
 * slot and no base member. A registered slot is served by the handle's own getter
 * and never reaches it.
 *
 * Kept honest by the anti-rot test in `@agentick/client`: that bundle imports
 * every built-in `/client` subpath, so it can assert this dictionary and the live
 * registry agree in both directions.
 */
const SUB_HANDLE_IMPORTS: Readonly<Record<string, string>> = {
  clientToolCalls: "@agentick/tool-executor/client",
  elicitations: "@agentick/elicitation/client",
  gates: "@agentick/gates/client",
  knobs: "@agentick/knobs/client",
  // `live` is an OPTIONAL extension — not in the `@agentick/client` bundle, but
  // an adopter who reaches for `session.live` deserves the same loud failure.
  live: "@agentick/live/client",
  prompts: "@agentick/prompts/client",
  resources: "@agentick/resources/client",
  skills: "@agentick/skills/client",
  state: "@agentick/state/client",
  tasks: "@agentick/tasks/client",
  timeline: "@agentick/timeline/client",
  tools: "@agentick/tool-executor/client",
};

/**
 * The slot → `/client` import-specifier dictionary the session handle uses to
 * turn a forgotten harness import into a named failure. Exported for the
 * anti-rot test in `@agentick/client` (and for adopters building their own
 * "which harnesses are installed?" diagnostics).
 */
export function knownSessionHandleExtensionImports(): Readonly<Record<string, string>> {
  return SUB_HANDLE_IMPORTS;
}

/**
 * Thrown when a KNOWN sub-handle slot is read on a client that never registered
 * it — the second line of defense behind installing `@agentick/client`, which
 * registers them all. Raised at ACCESS time from the handle's proxy, because the
 * alternative is wire-namespace synthesis: it succeeds silently and then fails at
 * the first call with an unrelated-looking `method not found`.
 *
 * A plain `Error` subclass (via {@link AgentickError}): it is thrown from a
 * property getter, not carried on an Effect failure channel, and it never
 * crosses the wire — it is a local wiring mistake, not a server outcome.
 */
export class SessionSubHandleNotRegistered extends AgentickError {
  readonly _tag = "SessionSubHandleNotRegistered" as const;
  /** The slot that was read (`"tools"`). */
  readonly slot: string;
  /** The import that registers it (`"@agentick/tool-executor/client"`). */
  readonly importSpecifier: string;
  constructor(args: { readonly slot: string; readonly importSpecifier: string }) {
    super(
      `session.${args.slot} is not registered. Install @agentick/client — it carries ` +
        `every built-in capability's client surface, with nothing to register. If you ` +
        `are on @agentick/client-core deliberately, add: ` +
        `import "${args.importSpecifier}".`,
    );
    this.slot = args.slot;
    this.importSpecifier = args.importSpecifier;
  }
}
registerAgentickError("SessionSubHandleNotRegistered", SessionSubHandleNotRegistered);

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

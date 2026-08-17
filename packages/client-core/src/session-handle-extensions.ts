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

import { wireFallthrough } from "./wire-namespace.js";

/** Builds one sub-handle for a session. Registered by a harness `/client` package. */
export type SessionSubHandleFactory = (client: ClientProtocol, sessionId: string) => unknown;

/** What a harness declares about its slot beyond the factory. */
export interface SessionSubHandleOptions {
  /**
   * The method names of this slot's WIRE namespace (`"timeline"` → the
   * `timeline/*` rows) that should fall through to the wire when the handle
   * itself does not define them — the runtime twin of the per-namespace type
   * merge on `SessionHandle`. Declare the namespace's rows in full and let
   * precedence sort it out: a row the handle already implements stays shadowed
   * by the handle (see {@link wireFallthrough}).
   *
   * A LIST, not blind synthesis, because a proxy that answered every name would
   * make every handle duck-type as `Respondable`/`Enumerable`. Type it against
   * the namespace so a typo or a removed row is a compile error:
   *
   * ```ts
   * wireMethods: ["commands", "compact", "history"] satisfies readonly (keyof
   *   WireNamespaceMethods<"timeline">)[]
   * ```
   *
   * Omitted → no fallthrough (the slot's own members are the whole surface).
   */
  readonly wireMethods?: readonly string[];
}

interface RegistryEntry {
  readonly make: SessionSubHandleFactory;
  readonly options: SessionSubHandleOptions;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Register a per-session sub-handle under `name` (e.g. `"tasks"`, `"knobs"`).
 * Called ONCE per harness client package at import time; the matching
 * `declare module "@agentick/spec" { interface SessionHandleExtensions … }`
 * types the slot. Idempotent-by-last-write; a second registration of the same
 * name wins (dev/HMR-friendly).
 */
export function registerSessionHandleExtension(
  name: string,
  make: SessionSubHandleFactory,
  options: SessionSubHandleOptions = {},
): void {
  registry.set(name, { make, options });
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
 * Tear down every sub-handle that was actually BUILT, in build order. Returns
 * the errors thrown (empty when clean) rather than throwing, so the caller can
 * finish its own teardown — `session.close()` still has a `session/close` RPC to
 * send. Idempotent: a second call is a no-op.
 */
export type SessionSubHandleTeardown = () => readonly unknown[];

/**
 * Define a lazy, cached getter on `handle` for every registered sub-handle.
 * Called by `makeSessionHandle` after the base handle is built. The factory runs
 * on first property access (opening any subscription then, not at handle
 * construction), and the result is memoized until IT closes. A built sub-handle
 * whose harness declared `wireMethods` is wrapped in the namespace
 * {@link wireFallthrough} proxy before it is handed out.
 *
 * `close()` on a sub-handle is a release, not a poison pill: it resets the
 * slot's memo, so the next access builds a fresh, working instance. Session
 * handles are memoized per client (one per session), so a slot closed by one
 * consumer is a slot every later visit to that session would otherwise inherit
 * dead — the invariant is that a lazy slot on a shared handle stays
 * re-openable.
 *
 * Returns the {@link SessionSubHandleTeardown} for the handles this call
 * installs. It closes what was BUILT and nothing else — an untouched getter is
 * never materialized by teardown, so closing a session does not open the
 * subscriptions it is about to abandon.
 */
export function applySessionHandleExtensions(
  handle: object,
  client: ClientProtocol,
  sessionId: string,
): SessionSubHandleTeardown {
  const built: unknown[] = [];
  for (const [name, entry] of registry) {
    if (name in handle) continue; // never shadow a real handle member
    let instance: unknown;
    let done = false;
    Object.defineProperty(handle, name, {
      configurable: true,
      enumerable: true,
      get() {
        if (!done) {
          const made = entry.make(client, sessionId);
          const closable = made as { close?: (...args: unknown[]) => unknown };
          if (typeof closable.close === "function") {
            const close = closable.close;
            closable.close = function (this: unknown, ...args: unknown[]) {
              done = false;
              return close.apply(this ?? made, args);
            };
          }
          const rows = entry.options.wireMethods;
          instance =
            rows !== undefined && rows.length > 0 && typeof made === "object" && made !== null
              ? wireFallthrough(made, client, sessionId, name, rows)
              : made;
          done = true;
          built.push(instance);
        }
        return instance;
      },
    });
  }

  let torndown = false;
  return () => {
    if (torndown) return [];
    torndown = true;
    const errors: unknown[] = [];
    for (const instance of built) {
      const close = (instance as { close?: unknown }).close;
      if (typeof close !== "function") continue;
      try {
        (close as () => void).call(instance);
      } catch (err) {
        errors.push(err);
      }
    }
    return errors;
  };
}

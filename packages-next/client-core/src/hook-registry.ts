/**
 * `ClientHookRegistry` — the runtime store behind `client.hook()` /
 * `client.hooks` (ADR 83 §"Wire dispatch through the seam"). Holds the
 * dynamically-registered client hooks keyed by the Pascal command suffix
 * (`"SessionSend"`), read LIVE per request by the client's request
 * pipeline.
 *
 * Keying by the command suffix (not the raw method) lets registration
 * (`parseHookKey("onBeforeSessionSend") → "SessionSend"`) and dispatch
 * (`commandForMethod("session/send") → "SessionSend"`) meet on the SAME
 * key via the SAME shared derivation (`@agentick/spec-next`) — one
 * derivation, both call sites.
 *
 * @see docs/proposals/v2/blueprint/83-one-interceptor-primitive.md
 */

import { deriveHookNames, parseHookKey } from "@agentick/spec-next";
import type { AfterHook, BeforeHook, ClientHookContext, Unsubscribe } from "@agentick/spec-next";

type BeforeFn = BeforeHook<unknown, ClientHookContext>;
type AfterFn = AfterHook<unknown, ClientHookContext>;

/**
 * Resolve a wire method (`"session/send"`) to the Pascal command suffix
 * the registry keys on (`"SessionSend"`). Runs the SAME
 * {@link deriveHookNames} used to derive the hook names, and slices the
 * `onBefore` prefix off — so a method and its hooks always meet on one
 * key. No `wire:` prefix: the client hook mirrors the session op it
 * initiates (`onBeforeSessionSend`), so the key must match the plain
 * derived name. The `Wire*` qualifier is the gateway boundary's concern.
 */
export function commandForMethod(method: string): string {
  const [beforeName] = deriveHookNames(method);
  return beforeName.slice("onBefore".length);
}

export class ClientHookRegistry {
  private readonly before = new Map<string, Set<BeforeFn>>();
  private readonly after = new Map<string, Set<AfterFn>>();

  /**
   * Register one hook by its declarative key
   * (`onBeforeSessionSend` / `onAfterSessionSend`). Stores it under the
   * parsed command suffix. Returns an {@link Unsubscribe} removing
   * exactly this registration (idempotent). A non-hook or `around`-kind
   * key is an inert no-op — the client hook seam is before/after only.
   */
  register(hookKey: string, fn: unknown): Unsubscribe {
    const parsed = parseHookKey(hookKey);
    if (parsed === undefined) return () => {};
    const map =
      parsed.kind === "before" ? this.before : parsed.kind === "after" ? this.after : undefined;
    if (map === undefined) return () => {};

    const command = parsed.command;
    let set = map.get(command);
    if (set === undefined) {
      set = new Set();
      map.set(command, set);
    }
    const entry = fn as BeforeFn & AfterFn;
    set.add(entry);

    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const current = map.get(command);
      if (current === undefined) return;
      current.delete(entry);
      if (current.size === 0) map.delete(command);
    };
  }

  /** True when no hooks are registered — the request pipeline's fast-path guard. */
  isEmpty(): boolean {
    return this.before.size === 0 && this.after.size === 0;
  }

  /** Before-hooks registered for `command`, in registration order. */
  beforeHooks(command: string): readonly BeforeFn[] {
    const set = this.before.get(command);
    return set === undefined ? EMPTY_BEFORE : [...set];
  }

  /** After-hooks registered for `command`, in registration order. */
  afterHooks(command: string): readonly AfterFn[] {
    const set = this.after.get(command);
    return set === undefined ? EMPTY_AFTER : [...set];
  }
}

const EMPTY_BEFORE: readonly BeforeFn[] = [];
const EMPTY_AFTER: readonly AfterFn[] = [];

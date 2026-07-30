/**
 * `findSession` — resolve a session id to its live
 * {@link SessionHarnessProtocol} by walking the gateway's apps.
 *
 * Session ids are gateway-unique but app-owned: only the owning
 * {@link AppHarnessProtocol} can hand back the live harness, so every wire
 * handler that takes a `sessionId` param has to traverse `gateway.apps()`.
 * Three packages had hand-rolled that walk (gateway's session extension,
 * `@agentick/knobs`, `@agentick/completions`), and two of them raised
 * `AppNotFoundError` with the SESSION id in the `appId` slot because their
 * authors believed no error covered the case. {@link SessionNotFoundError}
 * covers it exactly; this is the one implementation that throws it.
 *
 * Pure over the `gateway` slot of {@link WireExtensionContext} — takes the
 * narrowest structural view so a handler can pass its `ctx` directly:
 *
 * ```ts
 * const sess = ctx.session ?? findSession(ctx, params.sessionId);
 * ```
 *
 * (`ctx.session` is already resolved by the dispatcher for methods whose
 * params carry `sessionId`; the fallback covers hosts that don't pre-resolve.)
 *
 * @throws {SessionNotFoundError} when no app owns the id.
 */

import { SessionNotFoundError } from "../errors/lifecycle.js";
import type { AppHarnessProtocol } from "../protocol/app-harness.js";
import type { SessionHarnessProtocol } from "../protocol/session-harness.js";

/** The one slot {@link findSession} reads — a `WireExtensionContext` satisfies it. */
export interface SessionResolutionContext {
  readonly gateway: { apps(): readonly AppHarnessProtocol[] };
}

export function findSession(
  ctx: SessionResolutionContext,
  sessionId: string,
): SessionHarnessProtocol {
  for (const app of ctx.gateway.apps()) {
    const sess = app.getSession(sessionId);
    if (sess) return sess;
  }
  throw new SessionNotFoundError({ sessionId });
}

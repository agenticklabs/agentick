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

import { AppAmbiguousError, AppNotFoundError, SessionNotFoundError } from "../errors/lifecycle.js";
import type { AppHarnessProtocol } from "../protocol/app-harness.js";
import type { SessionHarnessProtocol } from "../protocol/session-harness.js";

/** The one slot {@link findSession} reads — a `WireExtensionContext` satisfies it. */
export interface SessionResolutionContext {
  readonly gateway: { apps(): readonly AppHarnessProtocol[] };
}

/** A resolved session together with the app that owns it. */
export interface SessionOwner {
  readonly session: SessionHarnessProtocol;
  readonly app: AppHarnessProtocol;
}

/**
 * The live walk, answering WHICH app owns the id as well — what a verb needs
 * when it must reach the session through its owning app's door rather than
 * calling the harness directly (`session/close`).
 *
 * @throws {SessionNotFoundError} when no app holds the id LIVE.
 */
export function findSessionOwner(ctx: SessionResolutionContext, sessionId: string): SessionOwner {
  for (const app of ctx.gateway.apps()) {
    const session = app.getSession(sessionId);
    if (session) return { session, app };
  }
  throw new SessionNotFoundError({ sessionId });
}

export function findSession(
  ctx: SessionResolutionContext,
  sessionId: string,
): SessionHarnessProtocol {
  return findSessionOwner(ctx, sessionId).session;
}

/**
 * Resume a session no app holds live — `undefined` when no app can (no durable
 * record, or the id already ended). Resume never creates.
 */
export async function resumeSession(
  ctx: SessionResolutionContext,
  sessionId: string,
): Promise<SessionHarnessProtocol | undefined> {
  for (const app of ctx.gateway.apps()) {
    const resumed = await app.resumeSession(sessionId);
    if (resumed) return resumed;
  }
  return undefined;
}

export interface OpenSessionOptions {
  /** `open(2)` `O_CREAT`: a total miss creates the session instead of throwing. */
  readonly create?: boolean;
  /** The app a created session belongs to. Required only on a gateway holding ≠ 1 app. */
  readonly appId?: string;
  /** Owning principal stamped on a created session (ADR 48). */
  readonly principal?: string;
}

export interface OpenSessionResult {
  readonly session: SessionHarnessProtocol;
  /** True iff this open created the session (cf. HTTP 201). */
  readonly created: boolean;
}

/**
 * Open a session by id — `open(2)` semantics: return it live, REMOUNT it when
 * an app can rehydrate it (a paged-out session, or a durable record from a
 * previous process; see {@link AppHarnessProtocol.resumeSession}), and with
 * `create` CREATE it on a total miss.
 *
 * **Only the verbs that DO work on a session's behalf may open** —
 * `session/send` (with `create`: a send names the conversation it is about, so
 * a miss is a session that does not exist YET) and `session/dispatch` (without:
 * work on a nonexistent session is an error). Observation verbs
 * (`sub/subscribe`, `session/compile`, `session/list_tools`,
 * `session/model_info`, …) stay on {@link findSession} and 404 against a
 * paged-out session, deliberately: a remount mounts an agent tree and costs the
 * memory the reaper just reclaimed, so a reconnecting UI that subscribes to
 * fifty thread ids must not be able to page all fifty back in. `session/abort`
 * is live-only for a second reason — a hibernated session has nothing in
 * flight to cancel, so remounting one to abort it would be work in service of a
 * no-op.
 *
 * Whether an open was a registry hit or a remount is residency — the
 * framework's business, observable on the `app:resume-session` span, and
 * deliberately NOT in the result: `created` is the one existence fact a caller
 * may act on.
 *
 * @throws {SessionNotFoundError} on a total miss without `create`.
 * @throws {AppNotFoundError} when `appId` names no app on this gateway.
 * @throws {AppAmbiguousError} when a miss must create and no app is implied.
 */
export async function openSession(
  ctx: SessionResolutionContext,
  sessionId: string,
  options: OpenSessionOptions = {},
): Promise<OpenSessionResult> {
  for (const app of ctx.gateway.apps()) {
    const live = app.getSession(sessionId);
    if (live) return { session: live, created: false };
  }
  const resumed = await resumeSession(ctx, sessionId);
  if (resumed) return { session: resumed, created: false };
  if (!options.create) throw new SessionNotFoundError({ sessionId });
  const session = await creationApp(ctx, options.appId).createSession({
    sessionId,
    ...(options.principal !== undefined ? { principal: options.principal } : {}),
  });
  return { session, created: true };
}

function creationApp(ctx: SessionResolutionContext, appId?: string): AppHarnessProtocol {
  const apps = ctx.gateway.apps();
  if (appId !== undefined) {
    const named = apps.find((app) => app.id === appId);
    if (!named) throw new AppNotFoundError({ appId });
    return named;
  }
  if (apps.length !== 1) throw new AppAmbiguousError({ appIds: apps.map((app) => app.id) });
  return apps[0]!;
}

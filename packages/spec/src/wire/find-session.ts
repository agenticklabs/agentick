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
 * Resolve a session id, REMOUNTING it when the live walk misses and an app can
 * rehydrate it (a paged-out session, or a durable record from a previous
 * process). See {@link AppHarnessProtocol.resumeSession} for what an app is
 * willing to bring back.
 *
 * **Only the verbs that DO work on a session's behalf may use this** —
 * `session/send` and `session/dispatch`. Observation verbs (`sub/subscribe`,
 * `session/compile`, `session/list_tools`, `session/model_info`, …) stay on
 * {@link findSession} and 404 against a paged-out session, deliberately: a
 * remount mounts an agent tree and costs the memory the reaper just reclaimed,
 * so a reconnecting UI that subscribes to fifty thread ids must not be able to
 * page all fifty back in. `session/abort` is live-only for a second reason — a
 * hibernated session has nothing in flight to cancel, so remounting one to abort
 * it would be work in service of a no-op.
 *
 * @throws {SessionNotFoundError} when the id is neither live nor resumable.
 */
export async function findSessionOrResume(
  ctx: SessionResolutionContext,
  sessionId: string,
): Promise<SessionHarnessProtocol> {
  for (const app of ctx.gateway.apps()) {
    const live = app.getSession(sessionId);
    if (live) return live;
  }
  const resumed = await resumeSession(ctx, sessionId);
  if (resumed) return resumed;
  throw new SessionNotFoundError({ sessionId });
}

/**
 * The RESUME door on its own — for a caller that has already missed the live
 * walk and wants the session brought back if any app can (`undefined` if none
 * can; resume never creates).
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

/** Which door a verb had to walk through to reach its session. */
export type SessionDoor = "live" | "resumed" | "created";

export interface SessionDoorResult {
  readonly session: SessionHarnessProtocol;
  readonly door: SessionDoor;
}

/** What the CREATE door needs beyond the id — see {@link resolveSessionDoor}. */
export interface SessionDoorInput {
  /** The app a miss creates in. Required only on a gateway holding ≠ 1 app. */
  readonly appId?: string;
  /** Owning principal stamped on a created session (ADR 48). */
  readonly principal?: string;
}

/**
 * All three doors — live, resume, CREATE — resolved atomically, reporting which
 * one was taken.
 *
 * **`session/send` only** (docs/proposals/v2/session-doors.md §3): a send is
 * existence-creating because the id it names is the conversation it is about, so
 * a miss is a session that does not exist YET rather than an error. Every other
 * verb stays on {@link findSession} / {@link findSessionOrResume} — that is what
 * keeps reads from creating, and it is the invariant a client-side
 * `get → create` dance could not hold (the door must be resolved inside the verb
 * or the reaper interleaves).
 *
 * @throws {AppNotFoundError} when `appId` names no app on this gateway.
 * @throws {AppAmbiguousError} when a miss must create and no app is implied.
 */
export async function resolveSessionDoor(
  ctx: SessionResolutionContext,
  sessionId: string,
  input: SessionDoorInput = {},
): Promise<SessionDoorResult> {
  for (const app of ctx.gateway.apps()) {
    const live = app.getSession(sessionId);
    if (live) return { session: live, door: "live" };
  }
  const resumed = await resumeSession(ctx, sessionId);
  if (resumed) return { session: resumed, door: "resumed" };
  const session = await creationApp(ctx, input.appId).createSession({
    sessionId,
    ...(input.principal !== undefined ? { principal: input.principal } : {}),
  });
  return { session, door: "created" };
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

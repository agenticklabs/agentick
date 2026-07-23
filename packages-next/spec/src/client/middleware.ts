/**
 * `ClientMiddleware` — the ONE client-side interception seam (B2 slice 4,
 * `docs/proposals/v2/client-handles.md` §7). The command EQUIVALENT of the
 * server's command middleware in SHAPE, not machinery: no journal, no bus, no
 * phase contract — the server owns durability/observability; a client middleware
 * is ergonomic interception around the two req-res wire primitives (commands +
 * read RPCs).
 *
 * An AROUND middleware (chain-of-responsibility): it receives the request
 * `params`, a `next` it may call (once, zero, or many times) to continue the
 * chain, and a `ctx` naming the wire `method` and the bound `sessionId`. It
 * covers auth/header injection, logging, retry policy, optimistic-UI bracketing,
 * telemetry propagation, and request capture/replay — written ONCE at
 * {@link ClientProtocol.use} and applied to EVERY derived method, including
 * verticals that don't exist yet (the derived-from-wire rule makes this
 * checkable).
 *
 * Subscriptions get a frame TAP, not middleware (a fold's input is a stream, not
 * a call) — that stays internal to the read views.
 *
 * @see docs/proposals/v2/client-handles.md §7
 */

/** Ambient context every {@link ClientMiddleware} receives as its third arg. */
export interface ClientMiddlewareContext {
  /** The wire method being dispatched (`"knobs/set"`, `"billing/approve"`, …). */
  readonly method: string;
  /**
   * The addressed session id, lifted from the request params when present
   * (`params.sessionId`). Undefined for non-session-scoped methods
   * (`gateway/*`, `initialize`, …).
   */
  readonly sessionId?: string;
  /** The caller's `AbortSignal`, when one was passed to the request. */
  readonly signal?: AbortSignal;
}

/** Continue the middleware chain with (possibly transformed) `params`. */
export type ClientMiddlewareNext = (params: unknown) => Promise<unknown>;

/**
 * A client middleware. `params`/result are `unknown` on purpose: a middleware
 * written once (`client.use(...)`) covers every wire method uniformly — narrow
 * inside on `ctx.method` when a middleware cares about a specific shape.
 */
export type ClientMiddleware = (
  params: unknown,
  next: ClientMiddlewareNext,
  ctx: ClientMiddlewareContext,
) => Promise<unknown>;

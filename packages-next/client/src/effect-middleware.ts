/**
 * `effectMiddleware()` — adapter that lets extension authors write
 * client request middleware against the Effect-native `BaseHarness`
 * signature instead of the default Promise-native shape.
 *
 * The canonical client middleware is Promise-based (most adopters
 * write trivial wrappers); Effect-flavored authors get an opt-in via
 * this adapter.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Why the client is Promise-native"
 */

import { Effect } from "effect";
import type { RequestInput, RequestMiddleware, WireMethod, WireResult } from "@agentick/spec-next";

export type EffectRequestMiddleware = <M extends WireMethod>(
  req: RequestInput<M>,
  next: (req: RequestInput<M>) => Effect.Effect<WireResult<M>, unknown, never>,
) => Effect.Effect<WireResult<M>, unknown, never>;

/**
 * Adapt an Effect-flavored middleware to a Promise-flavored
 * `RequestMiddleware`. Runs the inner Effect with the default runtime
 * and bridges to Promise at the boundary.
 */
export function effectMiddleware(mw: EffectRequestMiddleware): RequestMiddleware {
  return <M extends WireMethod>(
    req: RequestInput<M>,
    next: (req: RequestInput<M>) => Promise<WireResult<M>>,
  ) => {
    const nextEffect: (req: RequestInput<M>) => Effect.Effect<WireResult<M>, unknown, never> = (
      r,
    ) =>
      Effect.tryPromise({
        try: () => next(r),
        catch: (e) => e,
      }) as Effect.Effect<WireResult<M>, unknown, never>;
    return Effect.runPromise(mw(req, nextEffect));
  };
}

/**
 * Pipeline composition — Promise-native chain-of-responsibility for
 * client request middleware, and an AsyncIterable-stream pipeline for
 * subscribe middleware.
 *
 * Outer→inner composition rule: the first extension in the array is
 * outermost (runs first; sees the call before downstream middleware).
 * Implemented via `Array.prototype.reduceRight`, identical to
 * `MiddlewareChain.compose` on the server side.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Extensions"
 */

import type {
  ClientExtension,
  EventFrame,
  RequestInput,
  RequestMiddleware,
  SubscribeInput,
  SubscribeMiddleware,
  WireMethod,
  WireResult,
} from "@agentick/spec";

/**
 * Compose the request middleware pipeline.
 *
 * @param extensions  Extensions in adopter-listed order (first = outermost).
 * @param terminal    The terminal handler — typically
 *                    `(req) => transport.request(req.method, req.params, req.signal)`.
 */
export function composeRequest(
  extensions: readonly ClientExtension[],
  terminal: <M extends WireMethod>(req: RequestInput<M>) => Promise<WireResult<M>>,
): <M extends WireMethod>(req: RequestInput<M>) => Promise<WireResult<M>> {
  const middlewares = extensions.filter(
    (e): e is ClientExtension & { request: RequestMiddleware } => !!e.request,
  );
  if (middlewares.length === 0) return terminal;

  // Reduce right so the first listed extension ends up outermost.
  return middlewares.reduceRight<
    <M extends WireMethod>(req: RequestInput<M>) => Promise<WireResult<M>>
  >(
    (next, ext) =>
      <M extends WireMethod>(req: RequestInput<M>) =>
        ext.request(req, next as (r: RequestInput<M>) => Promise<WireResult<M>>),
    terminal,
  );
}

/**
 * Compose the subscribe middleware pipeline.
 */
export function composeSubscribe(
  extensions: readonly ClientExtension[],
  terminal: (input: SubscribeInput) => AsyncIterable<EventFrame>,
): (input: SubscribeInput) => AsyncIterable<EventFrame> {
  const middlewares = extensions.filter(
    (e): e is ClientExtension & { subscribe: SubscribeMiddleware } => !!e.subscribe,
  );
  if (middlewares.length === 0) return terminal;

  return middlewares.reduceRight<(input: SubscribeInput) => AsyncIterable<EventFrame>>(
    (next, ext) => (input) => ext.subscribe(input, next),
    terminal,
  );
}

/**
 * `AsyncStream<Item, Result>` — the streaming edge's JS facade type (ADR
 * 77, the dual-typed edge). The streaming dual of `Promise<A>`.
 *
 * A streaming operation composes internally as one Effect fiber (its
 * canonical form emits items through a sink and returns a summary). At
 * the entity edge it is projected to native JavaScript — an
 * `AsyncIterable` of items that ALSO carries a `result` Promise for the
 * final summary, plus `abort`. Every streaming harness surface returns
 * this shape; the runtime bridge that produces it (`runHarnessStream`,
 * the streaming sibling of `runHarnessProtocol`) is written once and
 * reused at each edge — the same way `runHarnessProtocol` / `Promise<A>`
 * serve every non-streaming edge.
 *
 * The two shapes derive from ONE underlying run: iterating the items does
 * not change the summary, and awaiting `result` does not steal items from
 * a concurrent iterator (reference bridges assume single-iterator
 * consumption). `abort` cancels the in-flight work — best effort.
 *
 * Unlike the Promise edge, there is no clean type-level derivation
 * (`PromiseView`'s analogue): the facade method `x(input): AsyncStream`
 * and its Effect twin `x(input, sink): Effect<Result, E>` differ in
 * arity, so the facade method is hand-declared on the protocol while the
 * twin lives on the harness's `.fx`. They share the implementation (the
 * bridge), not a mapped type.
 *
 * @see docs/proposals/v2/blueprint/77-operation-spine-and-dual-typed-edge.md
 */
export interface AsyncStream<Item, Result> extends AsyncIterable<Item> {
  /** The final summary of the run — resolves when the stream completes. */
  readonly result: Promise<Result>;
  /** Abort the in-flight run. Best-effort — work may have already completed. */
  abort(reason?: string): void;
}

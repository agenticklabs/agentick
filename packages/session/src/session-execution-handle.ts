/**
 * `SessionExecutionHandle` constructor.
 *
 * v1 used a custom `EventBuffer` to support dual consumption (iterate
 * events + await result). v2's bus is already pub/sub; we materialize
 * the AsyncIterable by subscribing to a filtered session-scoped event
 * stream and pair it with a Promise resolved by the loop's terminal.
 */

import { Chunk, Effect, Fiber, Stream } from "effect";
import type { ProtocolEvent, SendResult, SessionExecutionHandle, EventBus } from "@agentick/spec";

export interface SessionExecutionHandleArgs {
  readonly executionId: string;
  readonly bus: EventBus;
  readonly resultPromise: Promise<SendResult>;
  readonly abort: (reason?: string) => Promise<void>;
}

export function createSessionExecutionHandle(
  args: SessionExecutionHandleArgs,
): SessionExecutionHandle {
  const { executionId, bus, resultPromise, abort } = args;

  let status: "running" | "completed" | "error" | "aborted" = "running";

  // Resolve the status transition based on the result promise outcome.
  // The user typically awaits `.result`; this side-channel keeps
  // `handle.status` accurate even when they don't.
  resultPromise.then(
    () => {
      if (status === "running") status = "completed";
    },
    () => {
      if (status === "running") status = "error";
    },
  );

  // Per-handle subscription to bus events scoped to this execution.
  // Multiple iterators on the same handle each get their own buffered
  // stream — the bus is multi-subscriber by design.
  const makeAsyncIterator = (): AsyncIterator<ProtocolEvent> => {
    const stream = bus.subscribe({ scope: { executionId } });
    const stopWhenSettled = new Promise<void>((resolve) => {
      resultPromise.finally(() => resolve());
    });
    const sentinel = Symbol("session-stream-done");
    const racing = Stream.race(
      stream,
      Stream.fromEffect(
        Effect.promise(() => stopWhenSettled).pipe(
          Effect.map(() => sentinel as unknown as ProtocolEvent),
        ),
      ),
    );

    const queue: ProtocolEvent[] = [];
    const resolvers: Array<(r: IteratorResult<ProtocolEvent>) => void> = [];
    let done = false;

    const fiber = Effect.runFork(
      Stream.runForEach(racing, (event) =>
        Effect.sync(() => {
          if (done) return;
          if ((event as unknown) === sentinel) {
            done = true;
            for (const r of resolvers.splice(0)) {
              r({ value: undefined as unknown as ProtocolEvent, done: true });
            }
            return;
          }
          const r = resolvers.shift();
          if (r) r({ value: event, done: false });
          else queue.push(event);
        }),
      ),
    );

    return {
      async next() {
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false };
        }
        if (done) return { value: undefined as unknown as ProtocolEvent, done: true };
        return new Promise<IteratorResult<ProtocolEvent>>((resolve) => {
          resolvers.push(resolve);
        });
      },
      async return() {
        done = true;
        await Effect.runPromise(Fiber.interrupt(fiber));
        for (const r of resolvers.splice(0)) {
          r({ value: undefined as unknown as ProtocolEvent, done: true });
        }
        return { value: undefined as unknown as ProtocolEvent, done: true };
      },
    };
  };

  const handle: SessionExecutionHandle = {
    executionId,
    result: resultPromise,
    get status() {
      return status;
    },
    abort: async (reason?: string) => {
      await abort(reason);
      if (status === "running") status = "aborted";
    },
    [Symbol.asyncIterator]: () => makeAsyncIterator(),
  };

  // Reference Chunk so the import doesn't get tree-shaken — used in
  // future variants for batched event collection.
  void Chunk;

  return handle;
}

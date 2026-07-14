/**
 * `SessionExecutionHandle` constructor — direct emit chain (no bus
 * subscription).
 *
 * Each handle owns a private event queue. The session pushes StreamEvents
 * onto the queue via the returned `emit` callback. The handle's
 * AsyncIterator pulls from the queue (or awaits the next push when empty).
 *
 * Per-session cost is O(1) per event — no cross-session iteration, no
 * bus-subscriber count blow-up at scale (compare: 1000 sessions × bus
 * subscribers = 1M filter calls/sec; this approach = 100K direct method
 * calls/sec, no cross-session interference).
 *
 * Bus envelopes still fire in parallel for observability (via
 * `emitDeltaLazy`); `app.events()` subscribers (devtools, telemetry)
 * see them. The handle iterator is the in-band consumer-facing channel;
 * the bus is the out-of-band fan-out channel. Two independent paths.
 *
 * The handle stamps `id`, `sequence`, `timestamp`, `sessionId`,
 * `executionId` on every emit. Callers pass typed StreamEvent payloads
 * minus those fields.
 */

import { ulid } from "@agentick/runtime-next";
import type { SendResult, SessionExecutionHandle, StreamEvent } from "@agentick/spec-next";

/**
 * Loose shape — what the caller passes to `emit`. The handle fills in
 * the missing context fields. Distributive Omit preserves the
 * discriminated-union shape across StreamEvent variants.
 */
type DistributiveOmit<T, K extends string | number | symbol> = T extends unknown
  ? Omit<T, K>
  : never;
type EmitInput = DistributiveOmit<
  StreamEvent,
  "id" | "sequence" | "timestamp" | "sessionId" | "executionId"
>;

export interface SessionExecutionHandleArgs {
  readonly sessionId: string;
  readonly executionId: string;
  readonly resultPromise: Promise<SendResult>;
  readonly abort: (reason?: string) => Promise<void>;
}

export type { EmitInput as SessionEmitInput };

export interface CreatedHandle {
  readonly handle: SessionExecutionHandle;
  /**
   * Push a typed event onto the iterator. Stamps the missing context
   * fields (id, sequence, timestamp, sessionId, executionId).
   * Monotonic sequence assigned per-call.
   */
  readonly emit: (event: EmitInput) => void;
  /** Complete the iterator. Called after the final `result` event. */
  readonly close: () => void;
}

export function createSessionExecutionHandle(args: SessionExecutionHandleArgs): CreatedHandle {
  const { sessionId, executionId, resultPromise, abort } = args;

  let status: "running" | "completed" | "error" | "aborted" = "running";
  resultPromise.then(
    () => {
      if (status === "running") status = "completed";
    },
    () => {
      if (status === "running") status = "error";
    },
  );

  // Single private queue + resolver list. Multiple iterators on the
  // same handle share the same queue — events flow to whichever iterator
  // is currently awaiting next(). v1 semantics; multi-subscriber fan-out
  // can be layered later if needed.
  const queue: StreamEvent[] = [];
  const resolvers: Array<(r: IteratorResult<StreamEvent>) => void> = [];
  let done = false;
  let sequence = 0;

  const emit: (event: EmitInput) => void = (event) => {
    if (done) return;
    sequence += 1;
    const full = {
      ...event,
      id: ulid(),
      sequence,
      timestamp: new Date().toISOString(),
      sessionId,
      executionId,
    } as StreamEvent;
    const r = resolvers.shift();
    if (r) r({ value: full, done: false });
    else queue.push(full);
  };

  const close = (): void => {
    if (done) return;
    done = true;
    for (const r of resolvers.splice(0)) {
      r({ value: undefined as unknown as StreamEvent, done: true });
    }
  };

  const makeAsyncIterator = (): AsyncIterator<StreamEvent> => ({
    next(): Promise<IteratorResult<StreamEvent>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
      }
      return new Promise((resolve) => resolvers.push(resolve));
    },
    return(): Promise<IteratorResult<StreamEvent>> {
      close();
      return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
    },
  });

  const handle: SessionExecutionHandle = {
    executionId,
    result: resultPromise,
    get status() {
      return status;
    },
    // `events()` returns the stream — backed by the private
    // queue/resolvers via `makeAsyncIterator`. The handle is not itself
    // iterable; `events()` is the one way to consume the stream.
    events: () => ({ [Symbol.asyncIterator]: makeAsyncIterator }),
    abort: async (reason) => {
      if (status === "running") status = "aborted";
      await abort(reason);
    },
  };

  return { handle, emit, close };
}

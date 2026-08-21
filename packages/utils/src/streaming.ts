/**
 * Async-iterable ↔ web-streams bridges — the runtime behind
 * `SessionExecutionHandle.readable()` / `.pipeTo()`.
 *
 * Deliberately generic over the chunk type: these know nothing about
 * `StreamEvent`. A session handle wraps its `events()` iterable with
 * {@link readableFromAsyncIterable}; `pipeTo` is {@link pipeAsyncIterableTo}.
 * Web streams give backpressure for free — a slow {@link WritableStream}
 * gates `pull`, which gates the iterator, which gates the producer.
 */

/**
 * A WHATWG {@link ReadableStream} over an async iterable, with correct
 * backpressure and cancellation. `pull` advances the iterator one step only
 * when the consumer wants more; `cancel` calls the iterator's `return()` so an
 * abandoned stream tears the source down.
 */
export function readableFromAsyncIterable<T>(iterable: AsyncIterable<T>): ReadableStream<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * A pass-through {@link TransformStream} that enforces a minimum gap between
 * emissions — a `smoothStream`-style pacer. Nothing is dropped: chunks queue
 * and drain no faster than one per `ms`. Composable on any readable
 * (`readable.pipeThrough(throttle(ms))`).
 */
export function throttle<T>(ms: number): TransformStream<T, T> {
  let last = 0;
  return new TransformStream<T, T>({
    async transform(chunk, controller) {
      const wait = last + ms - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
      controller.enqueue(chunk);
    },
  });
}

/** Options for {@link pipeAsyncIterableTo}: the standard pipe options plus `throttleMs`. */
export interface PipeAsyncIterableOptions {
  readonly preventClose?: boolean;
  readonly preventAbort?: boolean;
  readonly preventCancel?: boolean;
  readonly signal?: AbortSignal;
  /** Minimum milliseconds between writes to the destination. Omit for backpressure-only pacing. */
  readonly throttleMs?: number;
}

/**
 * Pipe an async iterable to a {@link WritableStream}, honoring the
 * destination's backpressure. `throttleMs` inserts a {@link throttle} pace on
 * top; the rest of the options mirror `ReadableStream.prototype.pipeTo`.
 */
export function pipeAsyncIterableTo<T>(
  iterable: AsyncIterable<T>,
  destination: WritableStream<T>,
  options: PipeAsyncIterableOptions = {},
): Promise<void> {
  const { throttleMs, ...pipeOptions } = options;
  const source = readableFromAsyncIterable(iterable);
  const readable =
    throttleMs !== undefined && throttleMs > 0
      ? source.pipeThrough(throttle<T>(throttleMs))
      : source;
  return readable.pipeTo(destination, pipeOptions);
}

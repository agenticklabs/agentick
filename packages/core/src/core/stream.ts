import { Context } from "./context";

/**
 * Type guard to check if an object is an async iterable.
 *
 * @param obj - Object to check
 * @returns `true` if the object has `Symbol.asyncIterator`
 *
 * @example
 * ```typescript
 * const result = await someFunction();
 * if (isAsyncIterable(result)) {
 *   for await (const item of result) {
 *     console.log(item);
 *   }
 * }
 * ```
 */
export { isAsyncIterable } from "./procedure";

/**
 * Transform items in an async stream using a mapper function.
 *
 * Preserves the current execution context through all iterations.
 *
 * @typeParam T - Input item type
 * @typeParam R - Output item type
 * @param stream - Source async iterable
 * @param mapper - Function to transform each item
 * @returns Async iterable of transformed items
 *
 * @example
 * ```typescript
 * const numbers = getNumberStream();
 * const doubled = mapStream(numbers, (n) => n * 2);
 * for await (const n of doubled) {
 *   console.log(n);
 * }
 * ```
 *
 * @example Async mapper
 * ```typescript
 * const users = mapStream(userIds, async (id) => {
 *   return await fetchUser(id);
 * });
 * ```
 */
export async function* mapStream<T, R>(
  stream: AsyncIterable<T>,
  mapper: (item: T) => R | Promise<R>,
): AsyncIterable<R> {
  // Ensure we iterate inside the current context
  const ctx = Context.tryGet();
  const iterator = stream[Symbol.asyncIterator]();

  try {
    while (true) {
      const next = ctx ? await Context.run(ctx, () => iterator.next()) : await iterator.next();

      if (next.done) break;

      const mapped = ctx
        ? await Context.run(ctx, async () => mapper(next.value))
        : await mapper(next.value);

      yield mapped;
    }
  } finally {
    if (iterator.return) {
      if (ctx) await Context.run(ctx, () => iterator.return!());
      else await iterator.return();
    }
  }
}

/**
 * Perform side effects on each stream item without modifying the stream.
 *
 * @typeParam T - Item type
 * @param stream - Source async iterable
 * @param tapper - Side-effect function called for each item
 * @returns Async iterable yielding the original items
 *
 * @example
 * ```typescript
 * const logged = tapStream(events, (event) => {
 *   console.log('Event:', event.type);
 * });
 * for await (const event of logged) {
 *   processEvent(event);
 * }
 * ```
 */
export async function* tapStream<T>(
  stream: AsyncIterable<T>,
  tapper: (item: T) => void | Promise<void>,
): AsyncIterable<T> {
  yield* mapStream(stream, async (item) => {
    await tapper(item);
    return item;
  });
}

/**
 * Tagged stream item from {@link mergeStreams} when using a Record input.
 *
 * @typeParam T - The value type from the stream
 */
export interface StreamTag<T> {
  /** The key from the input Record identifying which stream this came from */
  source: string;
  /** The actual value from the stream */
  value: T;
}

/**
 * Merge multiple async streams into a single stream, yielding items as they arrive.
 *
 * Supports two input formats:
 * - **Array**: Returns items directly (type `T`)
 * - **Record**: Returns tagged items with source key (type `StreamTag<T>`)
 *
 * Handles context propagation, backpressure, and cleanup of all iterators.
 *
 * @typeParam T - Item type
 * @param input - Array of streams or Record mapping names to streams
 * @returns Merged stream of items (or tagged items for Record input)
 *
 * @example Array of streams (untagged)
 * ```typescript
 * const merged = mergeStreams([stream1, stream2, stream3]);
 * for await (const item of merged) {
 *   console.log(item); // Items from any stream, in arrival order
 * }
 * ```
 *
 * @example Record of streams (tagged)
 * ```typescript
 * const tagged = mergeStreams({ a: stream1, b: stream2 });
 * for await (const item of tagged) {
 *   console.log(item.source, item.value); // 'a' or 'b', plus the value
 * }
 * ```
 */
export async function* mergeStreams<T>(
  input: AsyncIterable<T>[] | Record<string, AsyncIterable<T>>,
): AsyncIterable<T | StreamTag<T>> {
  const ctx = Context.tryGet();

  let streams: AsyncIterable<T>[];
  let tags: string[] | null = null;

  if (Array.isArray(input)) {
    streams = input;
  } else {
    tags = Object.keys(input);
    streams = Object.values(input);
  }

  // Wrap iterators to run in context
  const iterators = streams.map((s) => {
    const iter = s[Symbol.asyncIterator]();
    return {
      next: () => (ctx ? Context.run(ctx, () => iter.next()) : iter.next()),
      return: () => (ctx && iter.return ? Context.run(ctx, () => iter.return!()) : iter.return?.()),
      instance: iter,
    };
  });

  try {
    // Map of active promises to their iterator index
    const nextPromises = new Map<number, Promise<IteratorResult<T>>>();

    // Initialize all iterators
    for (let i = 0; i < iterators.length; i++) {
      nextPromises.set(i, iterators[i].next());
    }

    while (nextPromises.size > 0) {
      // Create a race between all active promises
      const racePromises = Array.from(nextPromises.entries()).map(async ([index, promise]) => {
        try {
          const result = await promise;
          return { index, result };
        } catch (error) {
          return { index, error };
        }
      });

      const { index, result, error } = await Promise.race(racePromises);

      if (error) {
        throw error;
      }

      if (result!.done) {
        nextPromises.delete(index);
      } else {
        // If tagged, wrap in tag object. Else yield raw.
        if (tags) {
          yield { source: tags[index], value: result!.value };
        } else {
          yield result!.value;
        }

        // Refill
        nextPromises.set(index, iterators[index].next());
      }
    }
  } finally {
    // Ensure all iterators are closed
    await Promise.all(iterators.map((iter) => iter.return()));
  }
}

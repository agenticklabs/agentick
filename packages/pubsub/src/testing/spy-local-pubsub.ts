/**
 * `spyLocalPubSub<T>()` — call-recording double over the real
 * `LocalPubSub`. Records every published event in chronological
 * order. Useful when testing harnesses that publish across multiple
 * buses (e.g., MCP task notifications fanning into a session bus).
 *
 *   const spy = spyLocalPubSub<TaskEvent>();
 *   harness.attachBus(spy);
 *   harness.fireTaskUpdate({ taskId: "t1", kind: "progress" });
 *   expect(spy.publishCalls).toEqual([
 *     { taskId: "t1", kind: "progress" },
 *   ]);
 *
 * The spy IS a working pubsub — subscribers still receive every
 * event normally. The only addition is the recording side-effect on
 * `publish`. `close()` still drains in-flight events to subscribers.
 */

import type { Stream } from "effect";

import type { CreateLocalPubSubOptions, LocalPubSub } from "../local-pubsub.js";
import { createLocalPubSub } from "../local-pubsub.js";

export interface LocalPubSubSpy<T> extends LocalPubSub<T> {
  /** Recorded events, in publish order. */
  readonly publishCalls: ReadonlyArray<T>;
  /** Synonym for `publishCalls.length`. */
  readonly publishCallCount: number;
  /** Clear the recorded history without affecting subscribers. */
  reset(): void;
}

export function spyLocalPubSub<T>(options: CreateLocalPubSubOptions<T> = {}): LocalPubSubSpy<T> {
  const inner = createLocalPubSub<T>(options);
  const calls: T[] = [];

  return {
    publish(event: T): void {
      calls.push(event);
      inner.publish(event);
    },
    subscribe(filter?: (event: T) => boolean): Stream.Stream<T, never, never> {
      return inner.subscribe(filter);
    },
    close(): Promise<void> {
      return inner.close();
    },
    get subscriberCount() {
      return inner.subscriberCount;
    },
    get publishCalls() {
      return calls;
    },
    get publishCallCount() {
      return calls.length;
    },
    reset() {
      calls.length = 0;
    },
  };
}

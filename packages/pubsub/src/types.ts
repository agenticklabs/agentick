/**
 * Shared types for the pub/sub primitives.
 *
 * `Unsubscribe` is also exported by `@agentick/spec` and
 * `@agentick/utils`, but pubsub-next is intentionally low-level
 * (only depends on `effect`). Re-declaring the type here avoids
 * inverting the dep graph through spec-next.
 */

export type Unsubscribe = () => void;

/**
 * A listener called for each event. When the publisher's payload type
 * `T = void`, the listener is invoked with no argument (`l()`); when
 * `T != void`, it receives the published value (`l(value)`).
 */
export type Listener<T> = [T] extends [void] ? () => void : (value: T) => void;

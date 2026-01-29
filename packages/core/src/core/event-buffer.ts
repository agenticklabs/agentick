/**
 * EventBuffer - Typed event stream with channel-based subscriptions
 *
 * A streaming primitive that combines EventEmitter's channel model with:
 * - **Type-safe channels**: Event `type` property IS the channel name
 * - **Narrowed handlers**: `on('delta', h)` gives handler the narrowed type
 * - **Dual consumption**: Multiple consumers see all events independently
 * - **Replay support**: Late subscribers receive buffered events
 * - **Async iteration**: `for await (const event of buffer)`
 *
 * Events must have a `type` property that acts as the channel discriminator.
 * This aligns with discriminated union patterns common in TypeScript.
 *
 * @module tentickle/core/event-buffer
 */

/**
 * Constraint for events - must have a type discriminator.
 */
export type TypedEvent = { type: string };

/**
 * Maps event union to a record keyed by type.
 * Extracts the specific event shape for each type.
 */
export type EventMap<T extends TypedEvent> = {
  [K in T["type"]]: Extract<T, { type: K }>;
};

/**
 * Handler function for events.
 */
export type EventHandler<T> = (event: T) => void;

/**
 * Unsubscribe function returned by on/once.
 */
export type Unsubscribe = () => void;

/**
 * A waiter for async iteration.
 */
interface Waiter<T> {
  resolve: (event: T) => void;
  reject: (err: Error) => void;
}

/**
 * Wildcard key for subscribers that receive all events.
 */
const WILDCARD = "*" as const;

/**
 * EventBuffer enables typed, channel-based event streaming.
 *
 * The event's `type` property IS the channel. Subscribing to 'delta'
 * means you only receive events where `event.type === 'delta'`.
 *
 * @example Basic usage with channels
 * ```typescript
 * type StreamEvent =
 *   | { type: 'delta'; value: string }
 *   | { type: 'complete'; result: any };
 *
 * const buffer = new EventBuffer<StreamEvent>();
 *
 * // Subscribe to specific channel - handler gets narrowed type
 * buffer.on('delta', (event) => {
 *   console.log(event.value); // TypeScript knows: { type: 'delta', value: string }
 * });
 *
 * // Subscribe to all events
 * buffer.on((event) => {
 *   console.log(event); // StreamEvent union
 * });
 *
 * // Emit - type can be first arg (event.type omitted) or in event object
 * buffer.emit('delta', { value: 'Hello' });
 * buffer.emit({ type: 'complete', result: 42 });
 * ```
 *
 * @example Late subscriber with replay
 * ```typescript
 * buffer.emit('delta', { value: 'first' });
 * buffer.emit('delta', { value: 'second' });
 *
 * // Late subscriber gets all past 'delta' events replayed
 * buffer.onReplay('delta', (e) => console.log(e.value));
 * // logs: 'first', 'second'
 * ```
 *
 * @example Async iteration
 * ```typescript
 * for await (const event of buffer) {
 *   if (event.type === 'complete') break;
 *   console.log(event);
 * }
 * ```
 */
export class EventBuffer<T extends TypedEvent> {
  private buffer: T[] = [];
  private subscribers = new Map<string, Set<EventHandler<any>>>();
  private waiters: Waiter<T>[] = [];
  private _closed = false;
  private _error: Error | null = null;

  // ============================================================================
  // Push Events
  // ============================================================================

  /**
   * Push an event into the buffer.
   * Notifies subscribers for this event's type and wildcard subscribers.
   */
  push(event: T): void {
    if (this._closed) return;

    this.buffer.push(event);

    // Notify type-specific subscribers
    const typeSubscribers = this.subscribers.get(event.type);
    if (typeSubscribers) {
      for (const handler of typeSubscribers) {
        handler(event);
      }
    }

    // Notify wildcard subscribers
    const wildcardSubscribers = this.subscribers.get(WILDCARD);
    if (wildcardSubscribers) {
      for (const handler of wildcardSubscribers) {
        handler(event);
      }
    }

    // Resolve first waiter (FIFO for async iteration)
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve(event);
    }
  }

  /**
   * Emit an event (two-param form: type + event without type property).
   * @returns true if there were listeners
   */
  emit<K extends T["type"]>(
    eventType: K,
    event: Omit<EventMap<T>[K], "type">
  ): boolean;
  /**
   * Emit an event with wildcard (backwards compat with EventEmitter).
   * The event must be a full event object with type property.
   * @returns true if there were listeners
   */
  emit(eventType: "*", event: T): boolean;
  /**
   * Emit an event (one-param form: full event object with type).
   * @returns true if there were listeners
   */
  emit(event: T): boolean;
  emit<K extends T["type"]>(
    eventTypeOrEvent: K | "*" | T,
    maybeEvent?: Omit<EventMap<T>[K], "type"> | T
  ): boolean {
    let event: T;
    if (maybeEvent !== undefined) {
      if (eventTypeOrEvent === WILDCARD) {
        // emit("*", fullEvent) - backwards compat, push as-is
        event = maybeEvent as T;
      } else {
        // Two params: emit('delta', { value: 'hi' })
        event = { type: eventTypeOrEvent, ...maybeEvent } as T;
      }
    } else {
      // One param: emit({ type: 'delta', value: 'hi' })
      event = eventTypeOrEvent as T;
    }
    this.push(event);
    return this.getTotalListenerCount() > 0;
  }

  // ============================================================================
  // Subscribe
  // ============================================================================

  /**
   * Subscribe to events of a specific type.
   * Handler receives the narrowed type for that event.
   * @returns Unsubscribe function
   */
  on<K extends T["type"]>(
    eventType: K,
    handler: EventHandler<EventMap<T>[K]>
  ): Unsubscribe;
  /**
   * Subscribe to all events (wildcard).
   * Pass "*" or no event type for wildcard subscription.
   * @returns Unsubscribe function
   */
  on(eventType: "*", handler: EventHandler<T>): Unsubscribe;
  on(handler: EventHandler<T>): Unsubscribe;
  on<K extends T["type"]>(
    eventTypeOrHandler: K | "*" | EventHandler<T>,
    handler?: EventHandler<EventMap<T>[K]> | EventHandler<T>
  ): Unsubscribe {
    if (typeof eventTypeOrHandler === "function") {
      return this.addSubscriber(WILDCARD, eventTypeOrHandler);
    } else if (eventTypeOrHandler === WILDCARD) {
      // "*" is explicit wildcard
      return this.addSubscriber(WILDCARD, handler as EventHandler<T>);
    } else {
      return this.addSubscriber(eventTypeOrHandler, handler!);
    }
  }

  /**
   * Subscribe for a single event of a specific type.
   * @returns Unsubscribe function
   */
  once<K extends T["type"]>(
    eventType: K,
    handler: EventHandler<EventMap<T>[K]>
  ): Unsubscribe;
  /**
   * Subscribe for a single event (any type).
   * Pass "*" or no event type for wildcard subscription.
   * @returns Unsubscribe function
   */
  once(eventType: "*", handler: EventHandler<T>): Unsubscribe;
  once(handler: EventHandler<T>): Unsubscribe;
  once<K extends T["type"]>(
    eventTypeOrHandler: K | "*" | EventHandler<T>,
    handler?: EventHandler<EventMap<T>[K]> | EventHandler<T>
  ): Unsubscribe {
    if (typeof eventTypeOrHandler === "function") {
      const wrapper: EventHandler<T> = (event) => {
        this.removeSubscriber(WILDCARD, wrapper);
        eventTypeOrHandler(event);
      };
      return this.addSubscriber(WILDCARD, wrapper);
    } else if (eventTypeOrHandler === WILDCARD) {
      const wrapper: EventHandler<T> = (event) => {
        this.removeSubscriber(WILDCARD, wrapper);
        (handler as EventHandler<T>)(event);
      };
      return this.addSubscriber(WILDCARD, wrapper);
    } else {
      const wrapper: EventHandler<EventMap<T>[K]> = (event) => {
        this.removeSubscriber(eventTypeOrHandler, wrapper);
        (handler as EventHandler<EventMap<T>[K]>)(event);
      };
      return this.addSubscriber(eventTypeOrHandler, wrapper);
    }
  }

  /**
   * Unsubscribe a handler from a specific event type.
   * @returns true if handler was found and removed
   */
  off<K extends T["type"]>(
    eventType: K,
    handler: EventHandler<EventMap<T>[K]>
  ): boolean;
  /**
   * Unsubscribe a wildcard handler.
   * Pass "*" or no event type for wildcard.
   * @returns true if handler was found and removed
   */
  off(eventType: "*", handler: EventHandler<T>): boolean;
  off(handler: EventHandler<T>): boolean;
  off<K extends T["type"]>(
    eventTypeOrHandler: K | "*" | EventHandler<T>,
    handler?: EventHandler<EventMap<T>[K]> | EventHandler<T>
  ): boolean {
    if (typeof eventTypeOrHandler === "function") {
      return this.removeSubscriber(WILDCARD, eventTypeOrHandler);
    } else if (eventTypeOrHandler === WILDCARD) {
      return this.removeSubscriber(WILDCARD, handler as EventHandler<T>);
    } else {
      return this.removeSubscriber(eventTypeOrHandler, handler!);
    }
  }

  /**
   * Subscribe to a specific event type and replay all buffered events of that type.
   * @returns Unsubscribe function
   */
  onReplay<K extends T["type"]>(
    eventType: K,
    handler: EventHandler<EventMap<T>[K]>
  ): Unsubscribe;
  /**
   * Subscribe to all events and replay entire buffer.
   * @returns Unsubscribe function
   */
  onReplay(handler: EventHandler<T>): Unsubscribe;
  onReplay<K extends T["type"]>(
    eventTypeOrHandler: K | EventHandler<T>,
    handler?: EventHandler<EventMap<T>[K]>
  ): Unsubscribe {
    if (typeof eventTypeOrHandler === "function") {
      // Replay all buffered events
      for (const event of this.buffer) {
        eventTypeOrHandler(event);
      }
      return this.on(eventTypeOrHandler);
    } else {
      // Replay only events of this type
      for (const event of this.buffer) {
        if (event.type === eventTypeOrHandler) {
          handler!(event as EventMap<T>[K]);
        }
      }
      return this.on(eventTypeOrHandler, handler!);
    }
  }

  // ============================================================================
  // Private Subscription Helpers
  // ============================================================================

  private addSubscriber(key: string, handler: EventHandler<any>): Unsubscribe {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(handler);
    return () => this.removeSubscriber(key, handler);
  }

  private removeSubscriber(key: string, handler: EventHandler<any>): boolean {
    const set = this.subscribers.get(key);
    if (!set) return false;
    const deleted = set.delete(handler);
    if (set.size === 0) {
      this.subscribers.delete(key);
    }
    return deleted;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Close the buffer (no more events).
   * Completes all async iterators gracefully.
   */
  close(): void {
    if (this._closed) return;
    this._closed = true;

    // Complete all waiting iterators
    for (const waiter of this.waiters) {
      waiter.reject(new Error("Buffer closed"));
    }
    this.waiters = [];
  }

  /**
   * Close with an error.
   * All waiting iterators will throw this error.
   */
  error(err: Error): void {
    if (this._closed) return;
    this._error = err;
    this._closed = true;

    for (const waiter of this.waiters) {
      waiter.reject(err);
    }
    this.waiters = [];
  }

  // ============================================================================
  // State
  // ============================================================================

  /** Whether the buffer is closed. */
  get closed(): boolean {
    return this._closed;
  }

  /** Error that closed the buffer (if any). */
  get errorValue(): Error | null {
    return this._error;
  }

  /** Number of buffered events. */
  get length(): number {
    return this.buffer.length;
  }

  /** Total number of active subscribers across all channels. */
  get listenerCount(): number {
    return this.getTotalListenerCount();
  }

  private getTotalListenerCount(): number {
    let count = 0;
    for (const set of this.subscribers.values()) {
      count += set.size;
    }
    return count;
  }

  /** Get listener count for a specific event type. */
  getListenerCount<K extends T["type"]>(eventType: K): number;
  /** Get wildcard listener count. */
  getListenerCount(): number;
  getListenerCount(eventType?: string): number {
    const key = eventType ?? WILDCARD;
    return this.subscribers.get(key)?.size ?? 0;
  }

  /** Get all buffered events (readonly). */
  getBuffer(): readonly T[] {
    return this.buffer;
  }

  /** Get buffered events of a specific type. */
  getBufferByType<K extends T["type"]>(eventType: K): readonly EventMap<T>[K][] {
    return this.buffer.filter((e) => e.type === eventType) as EventMap<T>[K][];
  }

  /** Convert buffer to array (copy). */
  toArray(): T[] {
    return [...this.buffer];
  }

  // ============================================================================
  // Async Iteration
  // ============================================================================

  /**
   * Async iterator that replays all events then waits for new ones.
   *
   * Multiple iterators can exist simultaneously - each sees all events.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
    let index = 0;

    while (true) {
      // Yield buffered events
      while (index < this.buffer.length) {
        yield this.buffer[index];
        index++;
      }

      // If closed, we're done
      if (this._closed) {
        if (this._error) throw this._error;
        return;
      }

      // Wait for next event
      try {
        const event = await new Promise<T>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
        yield event;
        index++;
      } catch {
        // Buffer closed or errored
        if (this._error) throw this._error;
        return;
      }
    }
  }

  /**
   * Create a filtered async iterator for a specific event type.
   */
  async *filter<K extends T["type"]>(
    eventType: K
  ): AsyncGenerator<EventMap<T>[K], void, unknown> {
    for await (const event of this) {
      if (event.type === eventType) {
        yield event as EventMap<T>[K];
      }
    }
  }

  // ============================================================================
  // EventEmitter Aliases
  // ============================================================================

  /** Alias for on() (EventEmitter compatibility) */
  addListener<K extends T["type"]>(
    eventType: K,
    handler: EventHandler<EventMap<T>[K]>
  ): Unsubscribe;
  addListener(handler: EventHandler<T>): Unsubscribe;
  addListener<K extends T["type"]>(
    eventTypeOrHandler: K | EventHandler<T>,
    handler?: EventHandler<EventMap<T>[K]>
  ): Unsubscribe {
    return (this.on as any)(eventTypeOrHandler, handler);
  }

  /** Alias for off() (EventEmitter compatibility) */
  removeListener<K extends T["type"]>(
    eventType: K,
    handler: EventHandler<EventMap<T>[K]>
  ): boolean;
  removeListener(handler: EventHandler<T>): boolean;
  removeListener<K extends T["type"]>(
    eventTypeOrHandler: K | EventHandler<T>,
    handler?: EventHandler<EventMap<T>[K]>
  ): boolean {
    return (this.off as any)(eventTypeOrHandler, handler);
  }

  // ============================================================================
  // Deprecated Aliases (for migration)
  // ============================================================================

  /** @deprecated Use `on()` instead */
  subscribe(handler: EventHandler<T>): Unsubscribe {
    return this.on(handler);
  }

  /** @deprecated Use `onReplay()` instead */
  subscribeWithReplay(handler: EventHandler<T>): Unsubscribe {
    return this.onReplay(handler);
  }
}

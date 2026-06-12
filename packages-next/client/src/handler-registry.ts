/**
 * Lifecycle handler registry with per-event merge rules.
 *
 * Parallel to `HandlerRegistry` in `@agentick/runtime-next` but
 * Promise-native (matching the client's surface) and using per-event
 * merge kinds instead of the universal verdict-merge rule.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Lifecycle handlers"
 */

import type {
  ClientExtension,
  ClientLifecycleEvents,
  LifecycleHandlerFor,
  ReconnectDecision,
} from "@agentick/spec-next";

type HandlerArray<E extends keyof ClientLifecycleEvents> = ReadonlyArray<
  LifecycleHandlerFor<ClientLifecycleEvents[E]>
>;

export class ClientHandlerRegistry {
  private readonly handlers: {
    [E in keyof ClientLifecycleEvents]?: LifecycleHandlerFor<ClientLifecycleEvents[E]>[];
  } = {};

  registerFrom(extension: ClientExtension): void {
    if (!extension.handlers) return;
    for (const key of Object.keys(extension.handlers) as Array<keyof ClientLifecycleEvents>) {
      const handler = extension.handlers[key];
      if (!handler) continue;
      const list = (this.handlers[key] ??= []) as LifecycleHandlerFor<
        ClientLifecycleEvents[typeof key]
      >[];
      list.push(handler as LifecycleHandlerFor<ClientLifecycleEvents[typeof key]>);
    }
  }

  /**
   * Run every registered handler for `event` and return the merged result
   * per the event's declared `MergeKind`. The framework picks the merge
   * function based on the event spec; adopters never see the merge logic.
   */
  async run<E extends keyof ClientLifecycleEvents>(
    event: E,
    input: ClientLifecycleEvents[E]["input"],
    merge: ClientLifecycleEvents[E]["merge"],
  ): Promise<ClientLifecycleEvents[E]["result"] | null> {
    const list = (this.handlers[event] ?? []) as HandlerArray<E>;
    if (list.length === 0) return null;

    switch (merge) {
      case "observer": {
        for (const h of list) await h(input);
        return null;
      }
      case "first-non-null-wins": {
        for (const h of list) {
          const result = await h(input);
          if (result !== null && result !== undefined) {
            return result as ClientLifecycleEvents[E]["result"];
          }
        }
        return null;
      }
      case "any-reconnect-wins": {
        // Specialized to ReconnectDecision. Any handler voting "reconnect" wins;
        // otherwise the last non-null vote (typically "give-up").
        let last: ReconnectDecision | null = null;
        for (const h of list) {
          const result = (await h(input)) as ReconnectDecision | null | undefined;
          if (result === "reconnect") {
            return result as ClientLifecycleEvents[E]["result"];
          }
          if (result !== null && result !== undefined) last = result;
        }
        return last as ClientLifecycleEvents[E]["result"] | null;
      }
      default: {
        // Exhaustiveness guard. If a new merge kind lands without a case,
        // this throws at runtime — explicit failure rather than silent
        // proceed-default.
        const _exhaustive: never = merge;
        throw new Error(`unknown merge kind: ${_exhaustive as string}`);
      }
    }
  }
}

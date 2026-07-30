/**
 * `stubCompletions()` — canned-answer double, no substrate round-trip.
 *
 * Returns an object satisfying {@link CompletionsHarnessProtocol} that serves a
 * fixed map of `name → values`. `resolve` prefix-filters the canned list (so a
 * consumer's "type and see it narrow" assertion still holds) and throws
 * `CompletionNotFound` for an unknown name; `register` mutates the served map so
 * a consumer that registers then resolves still works. No ctx is derived — a
 * stub has no substrate to derive from, which is exactly why a consumer that
 * needs the resolver ctx wants `fakeCompletions()` instead.
 */

import type {
  CompletionResult,
  CompletionResolver,
  CompletionsHarnessProtocol,
  CompletionsResolveInput,
} from "@agentick/spec";
import { CompletionNotFound } from "@agentick/spec";
import type { Unsubscribe } from "@agentick/runtime";
import { createNotifier } from "@agentick/pubsub";

export interface StubCompletionsOptions {
  /** Canned `name → values` map served by `resolve`, prefix-filtered. */
  readonly values?: Readonly<Record<string, readonly string[]>>;
  /** Override the harness id surfaced via `.id`. */
  readonly id?: string;
}

export function stubCompletions(options: StubCompletionsOptions = {}): CompletionsHarnessProtocol {
  const values = new Map(Object.entries(options.values ?? {}));
  const changed = createNotifier();
  const id = options.id ?? "stub-completions";

  return {
    id,
    ready: Promise.resolve(),
    async close(): Promise<void> {
      /* no-op */
    },
    has(name: string): boolean {
      return values.has(name);
    },
    list(): readonly string[] {
      return [...values.keys()].sort();
    },
    subscribeAll(listener: () => void): Unsubscribe {
      return changed.subscribe(listener);
    },
    register(name: string, resolver: CompletionResolver): Unsubscribe {
      // A canned stub has no ctx to invoke a resolver with, so a registration
      // records the NAME only and resolves to the empty list unless the options
      // seeded values for it. Consumers that need the resolver actually called
      // want `fakeCompletions()`.
      void resolver;
      const previous = values.get(name);
      values.set(name, previous ?? []);
      changed.notify();
      return () => {
        values.delete(name);
        changed.notify();
      };
    },
    resolve(name: string, input: CompletionsResolveInput): Promise<CompletionResult> {
      const canned = values.get(name);
      if (canned === undefined) {
        return Promise.reject(new CompletionNotFound({ completionName: name }));
      }
      const matched =
        input.value === "" ? [...canned] : canned.filter((v) => v.startsWith(input.value));
      return Promise.resolve({ values: matched });
    },
  };
}

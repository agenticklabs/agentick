/**
 * `SandboxBridge` — registry of live `SandboxHarness` instances.
 *
 * The bridge is the typed pipe between framework components (e.g.,
 * `<Sandbox>` in reconciler-react) and consumers (tools that call
 * `useSandbox()` to get a harness handle). Framework components
 * register harnesses on mount and unregister on unmount; consumers
 * query by id (or grab the first ready harness when there's only one).
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 */

import type { Unsubscribe } from "@agentick/spec";
import type { SandboxHarness } from "./harness.js";

export interface SandboxRegistration {
  readonly id: string;
  readonly workspacePath: string;
  readonly status: "creating" | "ready" | "degraded" | "failed" | "destroyed";
}

export interface SandboxBridge {
  register(harness: SandboxHarness): Unsubscribe;
  unregister(id: string): void;
  get(id: string): SandboxHarness | undefined;
  list(): readonly SandboxRegistration[];
  /** Notify when an entry is registered / unregistered. */
  subscribe(listener: () => void): Unsubscribe;
}

export function inMemorySandboxBridge(): SandboxBridge {
  const harnesses = new Map<string, SandboxHarness>();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());

  return {
    register(harness): Unsubscribe {
      harnesses.set(harness.sandboxId, harness);
      notify();
      return () => {
        if (harnesses.get(harness.sandboxId) === harness) {
          harnesses.delete(harness.sandboxId);
          notify();
        }
      };
    },
    unregister(id) {
      if (harnesses.delete(id)) notify();
    },
    get(id) {
      return harnesses.get(id);
    },
    list(): readonly SandboxRegistration[] {
      const out: SandboxRegistration[] = [];
      for (const [id, h] of harnesses) {
        out.push({ id, workspacePath: h.workspacePath, status: h.status });
      }
      return out;
    },
    subscribe(listener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

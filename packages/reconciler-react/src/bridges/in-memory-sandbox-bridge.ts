/**
 * In-memory reference implementation of `SandboxBridge`.
 *
 * Tracks live `SandboxHandle` registrations from framework components.
 * Per-id subscribe lets components observe registration/unregistration
 * events (status changes happen at the handle level; the bridge just
 * brokers identity).
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §SandboxBridge
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

import type {
  SandboxBridge,
  SandboxHandle,
  SandboxRegistration,
  Unsubscribe,
} from "@agentick/spec";

export function inMemorySandboxBridge(): SandboxBridge {
  const handles = new Map<string, SandboxHandle>();
  const listeners = new Map<string, Set<() => void>>();

  const notify = (id: string): void => {
    listeners.get(id)?.forEach((l) => l());
  };

  return {
    register(id, handle): Unsubscribe {
      handles.set(id, handle);
      notify(id);
      return () => {
        if (handles.get(id) === handle) {
          handles.delete(id);
          notify(id);
        }
      };
    },
    unregister(id) {
      if (handles.delete(id)) notify(id);
    },
    get(id) {
      return handles.get(id);
    },
    list(): readonly SandboxRegistration[] {
      const out: SandboxRegistration[] = [];
      for (const [id, handle] of handles) {
        out.push({ id, workspacePath: handle.workspacePath });
      }
      return out;
    },
    subscribe(id, listener): Unsubscribe {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(id);
      };
    },
  };
}

/**
 * In-memory credential provider — the bundled ephemeral backend.
 *
 * Lives and dies with the process. That is the whole contract, and it is why the
 * default provider registered by the harness is named for its lifetime
 * (`ephemeral`) rather than its locality: a name suggesting persistence would
 * invite the exact failure this package was reshaped to prevent — a credential
 * silently gone after a restart.
 *
 * Nothing in the framework writes here. It is inert until adopter code does,
 * because a framework that cached verified bearer tokens by default would be a
 * process-local credential map with a blessing.
 */

import type { StoreCtx } from "@agentick/spec";

import { defineCredentialProvider } from "../define-provider.js";
import type { CredentialProvider } from "../provider.js";

/** The namespace the harness pre-registers an in-memory provider under. */
export const EPHEMERAL_NAMESPACE = "ephemeral";

export interface InMemoryCredentialProviderOptions {
  /** Defaults to {@link EPHEMERAL_NAMESPACE}. */
  readonly namespace?: string;
}

export function inMemoryCredentialProvider(
  options: InMemoryCredentialProviderOptions = {},
): CredentialProvider {
  const values = new Map<string, unknown>();
  const listeners = new Set<(key: string) => void>();
  const announce = (key: string): void => {
    for (const listener of listeners) listener(key);
  };

  return defineCredentialProvider({
    namespace: options.namespace ?? EPHEMERAL_NAMESPACE,
    backend: "in-memory",
    get: <T>(key: string, _ctx: StoreCtx): Promise<T | undefined> =>
      Promise.resolve(values.get(key) as T | undefined),
    set: <T>(key: string, value: T, _ctx: StoreCtx): Promise<void> => {
      values.set(key, value);
      announce(key);
      return Promise.resolve();
    },
    delete: (key: string, _ctx: StoreCtx): Promise<boolean> => {
      const removed = values.delete(key);
      if (removed) announce(key);
      return Promise.resolve(removed);
    },
    has: (key: string, _ctx: StoreCtx): Promise<boolean> => Promise.resolve(values.has(key)),
    keys: (_ctx: StoreCtx): Promise<readonly string[]> => Promise.resolve([...values.keys()]),
    onChange: (listener: (key: string) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: () => {
      values.clear();
      listeners.clear();
    },
  });
}

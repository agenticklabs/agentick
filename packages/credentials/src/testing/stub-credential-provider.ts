/**
 * `stubCredentialProvider` — canned-answer test double per the Meszaros
 * taxonomy. Returns pre-seeded values for specific keys; writes and unmapped
 * reads behave as the caller specifies.
 *
 * Use when a consumer-under-test only needs the read path to return something
 * plausible, and a real in-memory provider would be more machinery than the test
 * is about.
 *
 * `unavailableCredentialProvider` is its twin for the failure path: every verb
 * rejects with `CredentialsBackendUnavailable`, which is what a consumer sees
 * when the backing service is down.
 */

import { CredentialsBackendUnavailable, CredentialsWriteFailed } from "@agentick/spec";
import type { StoreCtx } from "@agentick/spec";

import { defineCredentialProvider } from "../define-provider.js";
import type { CredentialProvider } from "../provider.js";

export interface StubCredentialProviderOptions {
  /** The namespace this stub serves. Defaults to `"stub"`. */
  readonly namespace?: string;
  readonly seed: ReadonlyMap<string, unknown> | Record<string, unknown>;
  /** Reject writes. Defaults to `true` — a stub is a read fixture. */
  readonly readOnly?: boolean;
}

export function stubCredentialProvider(options: StubCredentialProviderOptions): CredentialProvider {
  const namespace = options.namespace ?? "stub";
  const readOnly = options.readOnly ?? true;
  const seed =
    options.seed instanceof Map ? new Map(options.seed) : new Map(Object.entries(options.seed));

  const refuse = (key: string): never => {
    throw new CredentialsWriteFailed({
      namespace,
      key,
      cause: new Error("stubCredentialProvider is read-only"),
    });
  };

  return defineCredentialProvider({
    namespace,
    backend: "stub",
    get: <T>(key: string, _ctx: StoreCtx): Promise<T | undefined> =>
      Promise.resolve(seed.get(key) as T | undefined),
    set: <T>(key: string, value: T, _ctx: StoreCtx): Promise<void> => {
      if (readOnly) refuse(key);
      seed.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string, _ctx: StoreCtx): Promise<boolean> => {
      if (readOnly) refuse(key);
      return Promise.resolve(seed.delete(key));
    },
    has: (key: string, _ctx: StoreCtx): Promise<boolean> => Promise.resolve(seed.has(key)),
    keys: (_ctx: StoreCtx): Promise<readonly string[]> => Promise.resolve([...seed.keys()]),
  });
}

export interface UnavailableCredentialProviderOptions {
  readonly namespace?: string;
}

export function unavailableCredentialProvider(
  options: UnavailableCredentialProviderOptions = {},
): CredentialProvider {
  const namespace = options.namespace ?? "unavailable";
  const down = (): never => {
    throw new CredentialsBackendUnavailable({
      backend: "unavailable",
      cause: new Error("stub backend is unavailable"),
    });
  };
  return defineCredentialProvider({
    namespace,
    backend: "unavailable",
    get: () => down(),
    set: () => down(),
    delete: () => down(),
    has: () => down(),
    keys: () => down(),
  });
}

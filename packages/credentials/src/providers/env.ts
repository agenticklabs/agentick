/**
 * Environment-variable credential provider — read-only by default.
 *
 * For headless deployments where credentials arrive from the platform runtime
 * (k8s secrets, Vercel env, a systemd unit). It is also the zero-config adapter
 * for a host that keeps today's `process.env` habit while gaining the seam: the
 * framework's own auth material stops being a bare `process.env.X!` and becomes
 * a namespaced lookup that can later point at Vault without touching callers.
 *
 * Read-only by default because an env-backed write is a lie — it would mutate
 * this process's view and nothing else. `set` is simply absent, so the harness
 * refuses with {@link CredentialOperationUnsupported} rather than appearing to
 * succeed.
 *
 * `AGENTICK_CRED_<NAMESPACE>_<KEY>`, both segments upper-cased with
 * non-alphanumerics collapsed to `_`.
 */

import { CredentialsBackendUnavailable, CredentialsCorrupted } from "@agentick/spec";
import type { StoreCtx } from "@agentick/spec";

import { defineCredentialProvider } from "../define-provider.js";
import type { CredentialProvider } from "../provider.js";

export interface EnvCredentialProviderOptions {
  /** The namespace this provider serves. Required — there is no sensible default. */
  readonly namespace: string;
  /** Variable-name prefix. Defaults to `AGENTICK_CRED`. */
  readonly prefix?: string;
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();

export function envCredentialProvider(options: EnvCredentialProviderOptions): CredentialProvider {
  const prefix = options.prefix ?? "AGENTICK_CRED";
  const namespace = options.namespace;
  const varName = (key: string): string => `${prefix}_${slug(namespace)}_${slug(key)}`;

  const env = (): NodeJS.ProcessEnv => {
    if (typeof process === "undefined" || !process.env) {
      throw new CredentialsBackendUnavailable({
        backend: "env",
        cause: new Error("process.env is not available in this runtime"),
      });
    }
    return process.env;
  };

  return defineCredentialProvider({
    namespace,
    backend: "env",
    get: <T>(key: string, _ctx: StoreCtx): Promise<T | undefined> => {
      const raw = env()[varName(key)];
      if (raw === undefined) return Promise.resolve(undefined);
      try {
        return Promise.resolve(JSON.parse(raw) as T);
      } catch (cause) {
        // A bare secret is the common case and JSON is the documented one; a
        // value that is neither parses as the string it is rather than failing
        // a deployment over quoting.
        if (!raw.trimStart().startsWith("{") && !raw.trimStart().startsWith("[")) {
          return Promise.resolve(raw as unknown as T);
        }
        throw new CredentialsCorrupted({ namespace, key, cause });
      }
    },
    has: (key: string, _ctx: StoreCtx): Promise<boolean> =>
      Promise.resolve(env()[varName(key)] !== undefined),
    keys: (_ctx: StoreCtx): Promise<readonly string[]> => {
      const head = `${prefix}_${slug(namespace)}_`;
      return Promise.resolve(
        Object.keys(env())
          .filter((name) => name.startsWith(head))
          .map((name) => name.slice(head.length)),
      );
    },
  });
}

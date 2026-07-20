/**
 * `envCredentialsStore` — environment-variable backed reference adapter.
 *
 * Useful for headless deployments where credentials come from the
 * platform runtime (Kubernetes secrets mounted as env, Vercel env vars,
 * Docker `--env-file`, systemd `EnvironmentFile`, etc.). The adopter
 * controls which env vars are visible to the process; the store maps
 * `(namespace, key)` to `<PREFIX>_<NAMESPACE>_<KEY>` (uppercase,
 * hyphens / colons replaced with underscores).
 *
 * Values are JSON-encoded — env vars are strings, but the store's
 * interface promises typed values. Adopters who want raw string
 * values store strings as-is and accept the JSON-string round-trip
 * (quoted form).
 *
 * Limitations:
 *
 *   - **Read-only by default.** `set()` and `delete()` MUTATE
 *     `process.env`, which is process-local — changes don't persist
 *     across restarts and aren't visible to sibling processes. Opt
 *     in by passing `{ writable: true }`. Pure read-only deployments
 *     (the typical case) leave this off so accidental writes throw.
 *   - **Enumeration walks `process.env`.** Cheap for small key counts
 *     (the typical case); not suited for thousands of keys.
 *   - **No external-change notification.** `process.env` doesn't emit
 *     change events. The harness's own change fan-out covers
 *     in-process writes; external changes are not observed.
 */

import {
  CredentialsBackendUnavailable,
  CredentialsCorrupted,
  CredentialsWriteFailed,
} from "@agentick/spec-next";
import type { StoreCtx } from "@agentick/spec-next";
import type { CredentialsStore } from "../store.js";

export interface EnvCredentialsStoreOptions {
  /**
   * Prefix prepended to every env-var name. Useful for namespacing
   * agentick env vars away from the platform's other env vars.
   * Defaults to `AGENTICK_CRED`.
   */
  readonly prefix?: string;

  /**
   * Allow `set()` and `delete()` to mutate `process.env`. Defaults
   * to `false` — env stores are typically read-only and accidental
   * writes should be loud.
   */
  readonly writable?: boolean;
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();

const envName = (prefix: string, namespace: string, key: string): string =>
  `${prefix}_${slug(namespace)}_${slug(key)}`;

class EnvCredentialsStore implements CredentialsStore {
  readonly backend = "env" as const;

  private readonly prefix: string;
  private readonly writable: boolean;

  constructor(options: EnvCredentialsStoreOptions = {}) {
    this.prefix = options.prefix ?? "AGENTICK_CRED";
    this.writable = options.writable ?? false;
  }

  // `ctx` is accepted for port conformance and ignored — env vars are a flat
  // process-global namespace with no per-principal scoping. An identity-aware
  // adapter would read `ctx.principal` to select the secret path.
  async get<T>(namespace: string, key: string, _ctx: StoreCtx): Promise<T | undefined> {
    if (typeof process === "undefined" || !process.env) {
      throw new CredentialsBackendUnavailable({
        backend: this.backend,
        cause: new Error("process.env is not available in this runtime"),
      });
    }
    const raw = process.env[envName(this.prefix, namespace, key)];
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      throw new CredentialsCorrupted({ namespace, key, cause: e });
    }
  }

  async set<T>(namespace: string, key: string, value: T, _ctx: StoreCtx): Promise<void> {
    if (!this.writable) {
      throw new CredentialsWriteFailed({
        namespace,
        key,
        cause: new Error(
          "envCredentialsStore is read-only by default; construct with { writable: true } to allow process.env mutation",
        ),
      });
    }
    try {
      process.env[envName(this.prefix, namespace, key)] = JSON.stringify(value);
    } catch (e) {
      throw new CredentialsWriteFailed({ namespace, key, cause: e });
    }
  }

  async delete(namespace: string, key: string, _ctx: StoreCtx): Promise<boolean> {
    if (!this.writable) {
      throw new CredentialsWriteFailed({
        namespace,
        key,
        cause: new Error("envCredentialsStore is read-only; construct with { writable: true }"),
      });
    }
    const name = envName(this.prefix, namespace, key);
    if (!(name in process.env)) return false;
    delete process.env[name];
    return true;
  }

  async has(namespace: string, key: string, _ctx: StoreCtx): Promise<boolean> {
    return envName(this.prefix, namespace, key) in (process.env ?? {});
  }

  async keys(namespace: string, _ctx: StoreCtx): Promise<readonly string[]> {
    const namespacePrefix = `${this.prefix}_${slug(namespace)}_`;
    const out: string[] = [];
    for (const name of Object.keys(process.env ?? {})) {
      if (name.startsWith(namespacePrefix)) {
        // Slug is lossy (collapsing characters to `_`) — adopters who
        // need bijective recovery should use a different backend.
        // The recovered key is the suffix, lowercased back. Good
        // enough for enumeration UIs; not a round-trip-faithful
        // identifier.
        out.push(name.slice(namespacePrefix.length).toLowerCase());
      }
    }
    return out;
  }
}

/**
 * Construct an environment-variable backed credentials store.
 *
 * Mapping: `(namespace, key)` → `<PREFIX>_<NAMESPACE_UPPER>_<KEY_UPPER>`
 * (non-alphanumeric chars replaced with `_`). Defaults to read-only.
 */
export function envCredentialsStore(options?: EnvCredentialsStoreOptions): CredentialsStore {
  return new EnvCredentialsStore(options);
}

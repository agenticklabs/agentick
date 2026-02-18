import type { SecretStore } from "@agentick/shared";

export interface EnvStoreOptions {
  prefix?: string;
}

function toEnvKey(key: string, prefix?: string): string {
  const normalized = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return prefix ? `${prefix}_${normalized}` : normalized;
}

export function createEnvStore(options?: EnvStoreOptions): SecretStore {
  const prefix = options?.prefix?.toUpperCase();

  return {
    backend: "env",

    async get(key) {
      return process.env[toEnvKey(key, prefix)] ?? null;
    },

    async set(key, value) {
      process.env[toEnvKey(key, prefix)] = value;
    },

    async delete(key) {
      const envKey = toEnvKey(key, prefix);
      if (envKey in process.env) {
        delete process.env[envKey];
        return true;
      }
      return false;
    },

    async has(key) {
      return toEnvKey(key, prefix) in process.env;
    },

    async list() {
      const target = prefix ? `${prefix}_` : "";
      if (!target) return Object.keys(process.env);
      return Object.keys(process.env)
        .filter((k) => k.startsWith(target))
        .map((k) => k.slice(target.length).toLowerCase().replace(/_/g, "."));
    },
  };
}

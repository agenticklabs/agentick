import type { SecretStore } from "@agentick/shared";

export function createMemoryStore(initial?: Record<string, string>): SecretStore {
  const secrets = new Map<string, string>(initial ? Object.entries(initial) : []);

  return {
    backend: "memory",

    async get(key) {
      return secrets.get(key) ?? null;
    },

    async set(key, value) {
      secrets.set(key, value);
    },

    async delete(key) {
      return secrets.delete(key);
    },

    async has(key) {
      return secrets.has(key);
    },

    async list() {
      return [...secrets.keys()];
    },
  };
}

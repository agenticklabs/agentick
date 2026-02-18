import type { SecretStore } from "@agentick/shared";
import { exec, execWithStdin } from "./shell.js";

const SERVICE = "agentick";

export interface LibsecretStoreOptions {
  service?: string;
}

export function createLibsecretStore(options?: LibsecretStoreOptions): SecretStore {
  const service = options?.service ?? SERVICE;

  return {
    backend: "libsecret",

    async get(key) {
      const result = await exec("secret-tool", ["lookup", "service", service, "key", key]);
      if (result.exitCode !== 0 || !result.stdout) return null;
      return result.stdout;
    },

    async set(key, value) {
      const result = await execWithStdin(
        "secret-tool",
        ["store", `--label=${service}: ${key}`, "service", service, "key", key],
        value,
      );
      if (result.exitCode !== 0) {
        throw new Error(`libsecret set failed for "${key}": ${result.stderr}`);
      }
    },

    async delete(key) {
      const result = await exec("secret-tool", ["clear", "service", service, "key", key]);
      return result.exitCode === 0;
    },

    async has(key) {
      const result = await exec("secret-tool", ["lookup", "service", service, "key", key]);
      return result.exitCode === 0 && result.stdout !== "";
    },

    async list() {
      const result = await exec("secret-tool", ["search", "service", service]);
      if (result.exitCode !== 0 || !result.stdout) return [];
      const keys: string[] = [];
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/^attribute\.key = (.+)$/);
        if (match) keys.push(match[1]);
      }
      return keys;
    },
  };
}

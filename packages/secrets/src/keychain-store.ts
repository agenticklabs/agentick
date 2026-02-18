import type { SecretStore } from "@agentick/shared";
import { exec } from "./shell.js";

const SERVICE = "agentick";
const MANIFEST_KEY = "__manifest__";

export interface KeychainStoreOptions {
  service?: string;
}

export function createKeychainStore(options?: KeychainStoreOptions): SecretStore {
  const service = options?.service ?? SERVICE;

  async function getManifest(): Promise<string[]> {
    const raw = await rawGet(MANIFEST_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async function saveManifest(keys: string[]): Promise<void> {
    await rawSet(MANIFEST_KEY, JSON.stringify(keys));
  }

  async function rawGet(key: string): Promise<string | null> {
    const result = await exec("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      key,
      "-w",
    ]);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async function rawSet(key: string, value: string): Promise<void> {
    // Delete first to avoid "already exists" error, then add
    await exec("security", ["delete-generic-password", "-s", service, "-a", key]);
    const result = await exec("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      key,
      "-w",
      value,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Keychain set failed for "${key}": ${result.stderr}`);
    }
  }

  async function rawDelete(key: string): Promise<boolean> {
    const result = await exec("security", ["delete-generic-password", "-s", service, "-a", key]);
    return result.exitCode === 0;
  }

  return {
    backend: "keychain",

    async get(key) {
      return rawGet(key);
    },

    async set(key, value) {
      await rawSet(key, value);
      const manifest = await getManifest();
      if (!manifest.includes(key)) {
        manifest.push(key);
        await saveManifest(manifest);
      }
    },

    async delete(key) {
      const deleted = await rawDelete(key);
      if (deleted) {
        const manifest = await getManifest();
        const updated = manifest.filter((k) => k !== key);
        await saveManifest(updated);
      }
      return deleted;
    },

    async has(key) {
      return (await rawGet(key)) !== null;
    },

    async list() {
      return getManifest();
    },
  };
}

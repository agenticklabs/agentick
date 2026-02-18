import type { SecretStore } from "@agentick/shared";
import { exec } from "./shell.js";
import { createKeychainStore } from "./keychain-store.js";
import { createLibsecretStore } from "./libsecret-store.js";
import { createEnvStore } from "./env-store.js";

export type SecretStoreBackend = "keychain" | "libsecret" | "env" | "memory" | "auto";

export interface CreateSecretStoreOptions {
  backend?: SecretStoreBackend;
  service?: string;
  envPrefix?: string;
}

async function isAvailable(cmd: string): Promise<boolean> {
  const result = await exec("which", [cmd]);
  return result.exitCode === 0;
}

async function detectBackend(): Promise<SecretStoreBackend> {
  if (process.platform === "darwin") {
    return "keychain";
  }
  if (process.platform === "linux" && (await isAvailable("secret-tool"))) {
    return "libsecret";
  }
  return "env";
}

export async function createSecretStore(options?: CreateSecretStoreOptions): Promise<SecretStore> {
  const backend =
    options?.backend === "auto" || !options?.backend ? await detectBackend() : options.backend;

  switch (backend) {
    case "keychain":
      return createKeychainStore({ service: options?.service });
    case "libsecret":
      return createLibsecretStore({ service: options?.service });
    case "env":
      return createEnvStore({ prefix: options?.envPrefix });
    case "memory": {
      const { createMemoryStore } = await import("./memory-store.js");
      return createMemoryStore();
    }
    default:
      throw new Error(`Unknown secret store backend: ${backend}`);
  }
}

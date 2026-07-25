/**
 * Bundled reference adapters for {@link CredentialsStore}.
 *
 * First-party additions (`keychainCredentialsStore`,
 * `libsecretCredentialsStore`, `encryptedFileCredentialsStore`,
 * `kvCredentialsStore`) land in follow-up slices.
 */

export { inMemoryCredentialsStore } from "./in-memory.js";
export { envCredentialsStore, type EnvCredentialsStoreOptions } from "./env.js";

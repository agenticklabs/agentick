/**
 * Secret store interface for credential management.
 *
 * Connectors and adapters accept a `SecretStore` for retrieving API keys
 * and tokens at runtime. Implementations are provided by `@agentick/secrets`.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  list(): Promise<string[]>;
  readonly backend: string;
}

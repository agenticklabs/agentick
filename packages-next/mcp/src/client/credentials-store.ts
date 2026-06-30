/**
 * `CredentialsStore<T>` — adopter-supplied persistence for per-server
 * credentials. Backs `OAuthProvider.loadTokens` / `saveTokens` (and
 * future Bearer / API-key variants) without the adopter having to
 * subclass each provider type per storage backend.
 *
 * **Why a separate adapter layer.** `OAuthProvider` is already
 * per-server (each connection's provider has its own loadTokens /
 * saveTokens). For multi-server deployments adopters want ONE
 * credentials backend (localStorage, OS keychain, encrypted DB) keyed
 * by `serverId`. CredentialsStore is that backend abstraction:
 *
 *   - Adopter constructs ONE `CredentialsStore` instance.
 *   - Passes it to `withMCP({ credentialsStore: ..., servers: [...] })`.
 *   - Each server's provider proxies its load/save through the store
 *     keyed by its own serverId.
 *
 * Generic over credential shape — OAuth has `{ access_token,
 * refresh_token, expires_in, ... }` (SDK's `OAuthTokens`); Bearer
 * could have `{ token }`. The default `T = OAuthTokens` keeps the
 * 90% case type-clean; adopters with mixed-auth deployments
 * parameterize explicitly.
 *
 * @see #277 — MCP connection-status surface (parent design)
 */

import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Adopter-pluggable credentials backend. Methods are async because
 * real backends hit IPC / disk / network; in-memory impls resolve
 * synchronously inside Promises.
 *
 * Per-server keyed by `serverId`. The serverId is the canonical
 * `withMCP({ servers: [{ serverId, ... }] })` value the adopter
 * already passes in.
 */
export interface CredentialsStore<T = OAuthTokens> {
  /**
   * Read stored credentials for a server. `undefined` when none
   * exist (never-authenticated, just-deleted, fresh install).
   */
  get(serverId: string): Promise<T | undefined>;

  /**
   * Persist credentials. Called after successful auth or refresh.
   * Implementations MUST overwrite any prior entry for the same
   * `serverId`.
   */
  set(serverId: string, tokens: T): Promise<void>;

  /**
   * Drop credentials for a server. Called by `reauthenticate()`
   * before kicking off a fresh OAuth dance, and by `disconnect()`
   * when the adopter wants to forget the server entirely.
   *
   * Idempotent: deleting an unknown serverId is a no-op.
   */
  delete(serverId: string): Promise<void>;
}

/**
 * In-memory reference implementation. Lost on process exit — useful
 * for tests, ephemeral CLI sessions, and "just see it work"
 * onboarding. Production deployments swap in localStorage, OS
 * keychain, encrypted DB, etc.
 */
export class InMemoryCredentialsStore<T = OAuthTokens> implements CredentialsStore<T> {
  private readonly entries = new Map<string, T>();

  async get(serverId: string): Promise<T | undefined> {
    return this.entries.get(serverId);
  }

  async set(serverId: string, tokens: T): Promise<void> {
    this.entries.set(serverId, tokens);
  }

  async delete(serverId: string): Promise<void> {
    this.entries.delete(serverId);
  }
}

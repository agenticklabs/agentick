/**
 * Bundled `AuthSource` (ADR 34) — static token → identity.
 *
 * Covers the local pole and simple deployments: a fixed table mapping
 * bearer tokens to identities. Real deployments implement `AuthSource`
 * against their IdP (JWT verification, OAuth introspection) — the port
 * is the contract, this is the reference.
 */

import type { AuthSource, IngressIdentity } from "@agentick/spec-next";

export interface StaticTokenAuthSourceOptions {
  /** token → identity (or shorthand: token → principal string). */
  readonly tokens: Readonly<Record<string, IngressIdentity | string>>;
  /**
   * Admit tokenless connections as anonymous (`{}`)? Default FALSE —
   * a configured AuthSource rejects missing credentials.
   */
  readonly allowAnonymous?: boolean;
}

export function staticTokenAuthSource(options: StaticTokenAuthSourceOptions): AuthSource {
  return {
    backend: "static-token",
    authenticate({ token }): Promise<IngressIdentity> {
      if (token === undefined) {
        if (options.allowAnonymous) return Promise.resolve({});
        return Promise.reject(new Error("authentication required: no token presented"));
      }
      const entry = options.tokens[token];
      if (entry === undefined) {
        return Promise.reject(new Error("authentication failed: unknown token"));
      }
      return Promise.resolve(typeof entry === "string" ? { principal: entry } : entry);
    },
  };
}

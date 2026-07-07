/**
 * Bundled `AuthSource` (ADR 34) — static token → identity.
 *
 * Covers the local pole and simple deployments: a fixed table mapping
 * bearer tokens to identities. Real deployments implement `AuthSource`
 * against their IdP (JWT verification, OAuth introspection) — the port
 * is the contract, this is the reference.
 */

import {
  IngressAuthFailed,
  IngressAuthRequired,
  IngressCredentialUnsupported,
  type AuthSource,
  type IngressCredential,
  type IngressIdentity,
} from "@agentick/spec-next";

const BACKEND = "static-token";

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
    backend: BACKEND,
    authenticate(credential: IngressCredential): Promise<IngressIdentity> {
      switch (credential.kind) {
        case "none":
          // No credential presented. Anonymous only when opted in.
          if (options.allowAnonymous) return Promise.resolve({});
          return Promise.reject(new IngressAuthRequired({ backend: BACKEND }));
        case "bearer": {
          const { token } = credential;
          if (token === undefined) {
            if (options.allowAnonymous) return Promise.resolve({});
            return Promise.reject(new IngressAuthRequired({ backend: BACKEND }));
          }
          // Object.hasOwn — a plain index would resolve inherited members
          // ("toString", "constructor", "__proto__") and admit an attacker
          // as anonymous (review finding: prototype-key bypass).
          if (!Object.hasOwn(options.tokens, token)) {
            return Promise.reject(
              new IngressAuthFailed({ backend: BACKEND, reason: "unknown token" }),
            );
          }
          const entry = options.tokens[token]!;
          return Promise.resolve(typeof entry === "string" ? { principal: entry } : entry);
        }
        case "platform":
          // The federated connector path (ADR 61 slice 2). The static
          // token table has no notion of a platform identity — reject
          // rather than silently admit. A connector-flavored AuthSource
          // handles this branch.
          // TODO(#146-slice2): connector AuthSource maps platform id → principal.
          return Promise.reject(
            new IngressCredentialUnsupported({ backend: BACKEND, credentialKind: "platform" }),
          );
      }
    },
  };
}

/**
 * The credentials harness's typed refusals (ADR 107).
 *
 * All three exist so a credential failure is LOUD and located. The failure this
 * package was reshaped to prevent was a silent one: a lookup that returned
 * `undefined` from a process-local map, surfacing much later as a mid-turn tool
 * error with nothing recorded anywhere.
 *
 * Absence of a KEY stays a plain `undefined` — that is a real answer. Absence of
 * a NAMESPACE, a duplicate registration, and an unsupported verb are not.
 */

/**
 * No provider is registered for this namespace.
 *
 * NOT the same as "no credential under that key", which is `undefined`. This
 * says the deployment never wired a source for these credentials at all — a
 * composition bug, not a data one.
 */
export class UnknownCredentialNamespace extends Error {
  readonly _tag = "UnknownCredentialNamespace" as const;
  constructor(
    readonly namespace: string,
    readonly known: readonly string[],
  ) {
    super(
      `credentials: no provider registered for namespace "${namespace}"` +
        (known.length > 0 ? ` (registered: ${known.join(", ")})` : " (none registered)"),
    );
    this.name = "UnknownCredentialNamespace";
  }
}

/**
 * A second provider claimed a namespace that already has one.
 *
 * An error rather than last-wins on purpose: silently shadowing a credential
 * provider is a security event, and the journaled `credentialNamespace`
 * identifies which provider served a read only while a namespace has exactly one
 * owner. Applies across levels too — an app-level provider may not take a
 * namespace the gateway already registered.
 */
export class DuplicateCredentialNamespace extends Error {
  readonly _tag = "DuplicateCredentialNamespace" as const;
  constructor(readonly namespace: string) {
    super(
      `credentials: namespace "${namespace}" is already registered — ` +
        "a namespace has exactly one provider; shadowing one is never implicit",
    );
    this.name = "DuplicateCredentialNamespace";
  }
}

/**
 * The provider serving this namespace does not implement the verb.
 *
 * The honest answer for a minter asked to `set`, or asked for `keys`: there is
 * no set of keys, only keys it would mint. A silent no-op would look like a
 * successful write.
 */
export class CredentialOperationUnsupported extends Error {
  readonly _tag = "CredentialOperationUnsupported" as const;
  constructor(
    readonly namespace: string,
    readonly operation: "set" | "delete" | "keys",
    readonly backend: string,
  ) {
    super(
      `credentials: provider "${backend}" for namespace "${namespace}" ` +
        `does not support ${operation}`,
    );
    this.name = "CredentialOperationUnsupported";
  }
}

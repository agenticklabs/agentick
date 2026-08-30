/**
 * `defineCredentialProvider` — the authoring door, mirroring `defineConnector`
 * (ADR 104/107).
 *
 * Validates at definition time and freezes, so a malformed provider fails where
 * it is written rather than at the first credential read on a live crossing.
 */

import type { CredentialProvider, CredentialProviderSpec } from "./provider.js";

export function defineCredentialProvider(spec: CredentialProviderSpec): CredentialProvider {
  const namespace = spec.namespace?.trim();
  if (!namespace) {
    throw new Error("defineCredentialProvider: `namespace` is required and must be non-empty");
  }
  if (!spec.backend?.trim()) {
    throw new Error(
      `defineCredentialProvider("${namespace}"): \`backend\` is required — it names ` +
        "the source in diagnostics",
    );
  }
  if (typeof spec.get !== "function") {
    throw new Error(
      `defineCredentialProvider("${namespace}"): \`get\` is required. Everything past ` +
        "it is optional; a read-only provider simply omits `set`.",
    );
  }
  return Object.freeze({ ...spec, namespace });
}

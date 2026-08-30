/**
 * The provider contract lives in `@agentick/spec`, beside the harness protocol
 * and for the same reason `ConnectorSpec` does: the gateway and app slots that
 * accept providers must name the type without depending on this package.
 *
 * Re-exported here so an adopter writing a provider imports one thing.
 */

export type { CredentialProvider, CredentialProviderSpec } from "@agentick/spec";

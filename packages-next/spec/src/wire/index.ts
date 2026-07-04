/**
 * Wire types — JSON-RPC 2.0 envelopes, method-bound param shapes,
 * notification shapes, error codes, and the subscription scope
 * discriminator.
 *
 * Spec owns these types. `@agentick/client-next` and every
 * `@agentick/transport-*-next` package imports from here. Zero runtime
 * deps; browser-safe.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export * from "./json-rpc.js";
export * from "./errors.js";
export * from "./scope.js";
export * from "./params.js";
export * from "./notifications.js";
export * from "./validate.js";
export * from "./extension.js";
export * from "./registry.js";
export * from "./authorizer.js";

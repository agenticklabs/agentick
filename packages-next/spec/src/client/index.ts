/**
 * Client protocol — the TypeScript contract a `@agentick/client-next`-
 * style client exposes. Multiple impls conform; the wire defined in
 * `@agentick/spec-next/wire/` is the language-agnostic contract beneath.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export * from "./state.js";
export * from "./transport-error.js";
export * from "./events.js";
export * from "./transport.js";
export * from "./handles.js";
export * from "./elicitation.js";
export * from "./extension.js";
export * from "./hooks.js";
export * from "./signals.js";
export * from "./channel.js";
export * from "./capabilities.js";
export * from "./client-protocol.js";

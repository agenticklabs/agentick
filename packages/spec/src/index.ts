/**
 * @agentick/spec — canonical contract types and protocol interfaces.
 *
 * This package is the firewall between compiler, runtime, executor, and
 * topology wrappers. Zero runtime dependencies. Browser-safe.
 *
 * @see docs/proposals/v2/blueprint/ for the architectural blueprint.
 */

export { SPEC_VERSION, type SpecVersion } from "./version.js";

export * from "./data/index.js";
export * from "./errors/index.js";
export * from "./protocol/index.js";
export * from "./wire/index.js";
export * from "./client/index.js";
export * from "./server/index.js";
export * from "./guards/index.js";
export * from "./hooks/derivation.js";

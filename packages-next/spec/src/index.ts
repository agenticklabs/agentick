/**
 * @agentick/spec-next — canonical contract types and protocol interfaces.
 *
 * This package is the firewall between reconciler, runtime, executor, and
 * topology wrappers. Zero runtime dependencies. Browser-safe.
 *
 * @see docs/proposals/v2/blueprint/ for the architectural blueprint.
 */

export { SPEC_VERSION, type SpecVersion } from "./version.js";

export * from "./data/index.js";
export * from "./protocol/index.js";

/**
 * `@agentick/spec-next/errors` — v2 typed-error infrastructure.
 *
 * Foundation for ADR 41. This barrel exports:
 *
 *   - `AgentickError` (abstract root + `SerializedAgentickError` wire
 *     shape + `isAgentickError` predicate)
 *   - `registerAgentickError` / `lookupAgentickError` — class registry
 *     keyed by `_tag`
 *   - `serializeAgentickError` / `deserializeAgentickError` — JSON
 *     codec round-trip
 *   - `UnknownAgentickError` — fallback for unregistered tags
 *
 * Concrete error classes (per-domain abstract intermediates +
 * leaf classes) land in subsequent commits and re-export from this
 * barrel. This commit lands the base machinery only — no consumer
 * package's error types have been migrated yet.
 *
 * @see docs/proposals/v2/blueprint/41-error-hierarchy.md
 */

export {
  AgentickError,
  type AgentickErrorOptions,
  type AgentickErrorTag,
  type SerializedAgentickError,
  isAgentickError,
} from "./base.js";

export {
  type ConcreteAgentickErrorClass,
  registerAgentickError,
  lookupAgentickError,
  _clearAgentickErrorRegistry,
  _registeredAgentickErrorTags,
} from "./registry.js";

export { deserializeAgentickError, serializeAgentickError } from "./codec.js";

export { UnknownAgentickError } from "./unknown.js";

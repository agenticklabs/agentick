/**
 * `AgentickError` class registry — maps `_tag` discriminators to their
 * class constructors. Powers the JSON codec in `./codec.ts` and
 * provides the lookup mechanism for cluster wire deserialization and
 * MCP error projection.
 *
 * Every concrete error class auto-registers via a side-effect at the
 * bottom of its source file:
 *
 *   ```ts
 *   export class SessionAlreadyExistsError extends SessionError {
 *     readonly _tag = "SessionAlreadyExistsError" as const;
 *     // …
 *   }
 *   registerAgentickError("SessionAlreadyExistsError", SessionAlreadyExistsError);
 *   ```
 *
 * Registration is explicit (caller passes the tag string) — TS class
 * field initializers attach to instances, not the prototype, so no
 * reliable runtime-introspection path exists short of constructing a
 * dummy instance. Explicit is cheaper than wrong-but-clever.
 *
 * Registration runs once per module load. Duplicates throw — two
 * classes claiming the same `_tag` is a programming error caught at
 * import time.
 */

import type { AgentickError, AgentickErrorTag } from "./base.js";

/**
 * Concrete (non-abstract) `AgentickError` subclass constructor. Takes
 * an object-arg specific to the class; the codec passes the parsed
 * payload untyped and trusts the constructor to validate.
 */
export type ConcreteAgentickErrorClass = new (args: never) => AgentickError;

const registry = new Map<AgentickErrorTag, ConcreteAgentickErrorClass>();

/**
 * Register a concrete `AgentickError` subclass under its `_tag`
 * discriminator. Idempotent for the same `(tag, cls)` pair (re-imports
 * during test reload don't throw); throws if another class is already
 * registered under that tag.
 *
 * @param tag Must match the class's `readonly _tag` instance field
 *            literal — the codec relies on this equivalence.
 * @param cls The concrete class constructor.
 */
export function registerAgentickError(
  tag: AgentickErrorTag,
  cls: ConcreteAgentickErrorClass,
): void {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new TypeError(
      `registerAgentickError: tag must be a non-empty string (got ${String(tag)})`,
    );
  }
  const existing = registry.get(tag);
  if (existing && existing !== cls) {
    throw new Error(
      `AgentickError tag '${tag}' is already registered to ${existing.name}; ` +
        `cannot re-register as ${cls.name}`,
    );
  }
  registry.set(tag, cls);
}

/**
 * Look up the constructor registered under a `_tag` string. Returns
 * `undefined` if the tag is unknown — typically meaning the
 * deserializing process is older than the producer and lacks the
 * class. Callers fall back to `UnknownAgentickError`.
 */
export function lookupAgentickError(tag: AgentickErrorTag): ConcreteAgentickErrorClass | undefined {
  return registry.get(tag);
}

/**
 * @internal — testing surface only. Reset the registry. Production
 * code must never call this; once a tag is registered it stays
 * registered for the process lifetime.
 */
export function _clearAgentickErrorRegistry(): void {
  registry.clear();
}

/**
 * @internal — testing surface only. Snapshot the registered tags.
 * Used by conformance tests to verify every consumed tag was
 * registered at module load.
 */
export function _registeredAgentickErrorTags(): readonly AgentickErrorTag[] {
  return Array.from(registry.keys());
}

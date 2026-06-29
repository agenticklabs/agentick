/**
 * JSON codec for `AgentickError`. Serialization is the class's own
 * `toJSON` (called transitively by `JSON.stringify`); deserialization
 * is registry-driven — the `_tag` string indexes into the class
 * registry, the matched class is `new`'d with the residual fields.
 *
 * Used by:
 *   - `@agentick/cluster-next` wire round-trip (ADR 35 §"InboxError
 *     round-trip fidelity", Phase 3.2 (4) / #189).
 *   - MCP error projection in `@agentick/mcp-next/server` for mapping
 *     tagged failures to JSON-RPC error responses.
 *
 * Both call sites share the same registry; no protocol-version bump
 * because the on-the-wire shape (`{_tag, message, ...fields}`) hasn't
 * changed — only the local instance type does.
 */

import { AgentickError, type SerializedAgentickError } from "./base.js";
import { lookupAgentickError } from "./registry.js";
import { UnknownAgentickError } from "./unknown.js";

/**
 * Project an `AgentickError` instance to its JSON-safe shape. Trivial
 * delegation to `err.toJSON()`; exposed as a named function for
 * symmetry with `deserializeAgentickError` and so callers don't have
 * to inline the type assertion.
 */
export function serializeAgentickError(err: AgentickError): SerializedAgentickError {
  return err.toJSON();
}

/**
 * Reconstruct an `AgentickError` instance from its JSON shape. Looks
 * up the class by `_tag`; unknown tags resolve to
 * `UnknownAgentickError` so no data is lost.
 *
 * Throws if the input isn't an object, or if `_tag` is missing or
 * non-string. Construction failures from the concrete class's
 * constructor (e.g. missing required field) propagate unwrapped.
 */
export function deserializeAgentickError(obj: unknown): AgentickError {
  if (typeof obj !== "object" || obj === null) {
    throw new TypeError(`Cannot deserialize non-object as AgentickError (got ${typeof obj})`);
  }
  const o = obj as Record<string, unknown>;
  const tag = o._tag;
  if (typeof tag !== "string" || tag.length === 0) {
    throw new TypeError(
      `AgentickError JSON missing required string '_tag' field (got ${typeof tag})`,
    );
  }
  const Cls = lookupAgentickError(tag);
  if (!Cls) {
    return new UnknownAgentickError({ originalTag: tag, payload: o });
  }
  // Strip the discriminator and the inherited `message` slot before
  // handing to the constructor; the class's field initializer sets
  // `_tag`, and the constructor builds `message` from the domain
  // fields it owns.
  const { _tag: _t, message: payloadMessage, ...fields } = o;
  const instance = new Cls(fields as never);
  // If the wire carried a `message` that differs from what the
  // constructor produced (e.g. localized variant, or a tag-only
  // payload with no fields to reconstruct from), restore it. Mutating
  // `message` is safe — it's a standard own property on Error.
  if (typeof payloadMessage === "string" && instance.message !== payloadMessage) {
    (instance as { message: string }).message = payloadMessage;
  }
  return instance;
}

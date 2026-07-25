/**
 * `UnknownAgentickError` — fallback class for deserialized payloads
 * whose `_tag` isn't registered locally.
 *
 * Occurs when:
 *   - A cluster broker forwards an error from a newer-version node to
 *     an older-version one that doesn't have the class yet.
 *   - The MCP wire ships an error from a server using a newer schema
 *     than the client has loaded.
 *   - Test code injects a synthetic JSON payload with a tag that no
 *     module has registered.
 *
 * Preserves the original payload verbatim so debugging and re-forwarding
 * lose no data. Surviving forwarders re-emit it under the original tag
 * via the custom `toJSON` — the wire stays round-trip lossless across
 * intermediate nodes that don't know the type.
 */

import { AgentickError, type SerializedAgentickError } from "./base.js";
import { registerAgentickError } from "./registry.js";

export class UnknownAgentickError extends AgentickError {
  readonly _tag = "UnknownAgentickError" as const;

  /** The `_tag` string carried in the original payload. */
  readonly originalTag: string;

  /** The original payload, preserved as-is. */
  readonly payload: Readonly<Record<string, unknown>>;

  constructor(args: {
    readonly originalTag: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  }) {
    const payloadMessage =
      typeof args.payload.message === "string" ? args.payload.message : "(no message)";
    super(`unknown agentick error '${args.originalTag}': ${payloadMessage}`, { cause: args.cause });
    this.originalTag = args.originalTag;
    this.payload = args.payload;
  }

  /**
   * Override the default projection — re-emit the original payload
   * under its original tag so this error round-trips losslessly
   * through intermediate nodes that don't know the type. The local
   * `_tag` is purely a runtime-discrimination concern; on the wire it
   * appears as the producer's tag.
   */
  override toJSON(): SerializedAgentickError {
    return { ...this.payload, _tag: this.originalTag, message: this.message };
  }
}

registerAgentickError("UnknownAgentickError", UnknownAgentickError);

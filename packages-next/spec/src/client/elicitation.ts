/**
 * Client-side elicitation surface.
 *
 * The server publishes elicitation prompts on
 * `session:channel:elicitation`. The client receives them as
 * `ClientElicitation` values via `SessionHandle.elicitations()` and
 * replies by calling `SessionHandle.respondToElicitation(...)` (which
 * routes through the new `session/respond_to_elicitation` wire method
 * to the server's `bridges.elicitation.respond()`).
 *
 * This is the canonical client path for every "ask the user X" step
 * the framework supports — tool confirmation, MCP elicitation,
 * sandbox permissions, agent-side asks. Renderers dispatch on
 * `elic.hints?.kind` to pick a domain-specific UI.
 *
 * @see ../../../elicitation/README.md
 */

// ============================================================================
// ClientElicitation — parsed inbound request from the server
// ============================================================================

/**
 * Parsed view of a single inbound elicitation request envelope. The
 * fields below mirror the wire payload structure, plus
 * `correlationId` / `replyTo` lifted from the envelope's `metadata`
 * and `receivedAt` stamped by the client.
 *
 * Generic `TValue` carries the schema's `Output` type for adopters
 * who infer types via Standard-Schema utilities on the client side.
 * Defaults to `unknown` — the wire schema is JSON Schema, so static
 * inference requires the adopter to bring its own typing.
 */
export interface ClientElicitation<TValue = unknown> {
  /**
   * Correlation key carried on the wire envelope's metadata. Required
   * for `respondToElicitation` — the server's elicitation harness uses
   * it to resolve the pending Deferred.
   */
  readonly correlationId: string;
  /**
   * Server-side reply-to inbox address. Opaque to the client; the
   * gateway uses it internally when routing the response. Surfaced
   * here for completeness and for adopters who want to bypass the
   * convenience wire method.
   */
  readonly replyTo: string;
  /** Wire mode discriminator. `"form"` is the only implemented mode today. */
  readonly mode: "form" | "url";
  /** Human-readable prompt — `payload.message` on the wire. */
  readonly message: string;
  /**
   * JSON Schema projection of the server's `StandardSchemaV1`. Present
   * on form-mode requests; clients use it to render schema-driven UI.
   * Absent on URL mode.
   */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** URL-mode target. Absent on form-mode requests. */
  readonly url?: string;
  /** URL-mode persistent id for completion notifications. */
  readonly elicitationId?: string;
  /**
   * Free-form UX hints. `hints.kind` is the documented router key —
   * `"tool_confirmation"`, `"sandbox_permission"`, `"mcp_elicitation"`,
   * etc. See `ElicitationHints` on the server-side protocol for the
   * documented convention set.
   */
  readonly hints?: Readonly<Record<string, unknown>>;
  /**
   * Domain metadata stamped onto the envelope by the requesting
   * harness — telemetry shapes like `ToolConfirmationRequest` /
   * `SandboxPermissionRequest` live here.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Client-stamped receive time (`Date.now()`). */
  readonly receivedAt: number;
  /**
   * Suppresses TypeScript variance complaints on consumers that
   * specialize `TValue`. The field is never populated — it's a
   * type-only marker. Cast to `ClientElicitation<MyValue>` to narrow.
   */
  readonly _value?: TValue;
}

// ============================================================================
// ClientElicitationHandle — yielded value with typed convenience methods
// ============================================================================

/**
 * Convenience wrapper around a {@link ClientElicitation}. Adds typed
 * `.accept`/`.decline`/`.cancel` shortcuts that route through the
 * session's `respondToElicitation` — eliminates the boilerplate of
 * threading `correlationId` from one expression into another.
 */
export interface ClientElicitationHandle<TValue = unknown> extends ClientElicitation<TValue> {
  /** Send `{ outcome: "accepted", value }`. */
  accept(value: TValue): Promise<void>;
  /** Send `{ outcome: "declined", reason? }`. */
  decline(reason?: string): Promise<void>;
  /** Send `{ outcome: "cancelled", reason? }`. */
  cancel(reason?: string): Promise<void>;
}

// ============================================================================
// Stream type
// ============================================================================

/**
 * AsyncIterable of inbound elicitations for a single session.
 * Yields each request as a {@link ClientElicitationHandle}. Closing
 * the stream unsubscribes from the underlying session-events
 * subscription.
 */
export interface ClientElicitationStream extends AsyncIterable<ClientElicitationHandle<unknown>> {
  close(): Promise<void>;
}

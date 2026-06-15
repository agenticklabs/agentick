/**
 * ElicitationHarnessProtocol — substrate-level "ask the user for a
 * structured response" primitive.
 *
 * Generalizes the request/response pattern v1's `ToolConfirmationCoordinator`
 * established. Every harness that needs a synchronous user-in-the-loop
 * step — tool confirmation, MCP `elicitation/create`, agent-side ask,
 * approval workflows — funnels through this one named protocol so the
 * wire envelope, channel name, correlation engine, and timeout/abort
 * semantics live in exactly one place.
 *
 *   Wire channel       — published on a well-known channel by the
 *                        concrete impl (the canonical channel name
 *                        lives in the harness package, not spec —
 *                        spec defines the protocol shape only). The
 *                        wire envelope's `payload.schema` is a
 *                        projected JSON Schema, NOT the live
 *                        `StandardSchemaV1` (functions are not
 *                        serializable across transports).
 *   Validation         — every request carries a `StandardSchemaV1`
 *                        describing the expected reply value. The
 *                        harness validates incoming responses against
 *                        the schema before resolving the caller's
 *                        promise; invalid replies surface as
 *                        `{ outcome: "failed", failure.kind:
 *                        "schema_violation" }` rather than a thrown
 *                        error. Async validators are awaited.
 *   Resolution path    — one code path. `respond()` is a typed
 *                        convenience that routes through the inbox
 *                        (`request-response` envelope), so in-process
 *                        and cross-process responses share the same
 *                        `BaseHarness.dispatchMessage` auto-intercept
 *                        → `RequestResponseRegistry.resolve` path.
 *                        First-write-wins on the registry: duplicate
 *                        responses to a resolved correlationId are
 *                        silent no-ops.
 *
 * MCP alignment — `accepted | declined | cancelled` mirror MCP
 * 2025-11-25 elicitation result outcomes verbatim. `failed` is the
 * agentick-specific terminal for transport/timing/schema failures the
 * MCP spec doesn't surface, discriminated by `failure.kind`.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { StandardSchemaV1 } from "../data/standard-schema.js";

// ============================================================================
// Request / response shapes
// ============================================================================

/**
 * Wire payload for an outbound elicitation request. Published by the
 * harness on its canonical channel (the envelope's `metadata` carries
 * the `correlationId` + `replyTo` per the request/response substrate
 * contract).
 *
 * The generic parameter `TSchema` lets the protocol carry the precise
 * Standard-Schema instance through to the caller so the response value
 * is statically typed as `StandardSchemaV1.InferOutput<TSchema>`.
 *
 * Note on UI routing: there is intentionally no `kind?: string` field.
 * Use `hints.kind` if a client-side router needs a discriminator —
 * hints are opaque to the harness and are the right home for
 * client-only metadata. The schema's shape itself is the authoritative
 * description of what is being asked.
 */
export interface ElicitationRequest<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  /**
   * Human-readable prompt shown to the user. Matches MCP's `message`.
   */
  readonly message: string;
  /**
   * Standard-Schema validator describing the expected reply value.
   * Drives BOTH:
   *   - Schema-driven UI rendering on the client. The wire envelope
   *     carries a JSON Schema projection (`toJsonSchema()` is applied
   *     at the publish boundary); subscribers never see the live
   *     validator function.
   *   - Server-side validation of the incoming response payload before
   *     the calling fiber sees it. Async validators are awaited.
   */
  readonly schema: TSchema;
  /**
   * Free-form UX hints (button labels, placeholders, icons, client
   * router discriminators). Opaque to the harness; passed through to
   * subscribers verbatim. By convention, `hints.kind` (string) is the
   * client-side router key.
   */
  readonly hints?: Readonly<Record<string, unknown>>;
  /**
   * Domain metadata stamped on the wire envelope. Logging, MCP wire
   * mapping, and audit trails consume this — the harness itself never
   * inspects it.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Inbound response payload — what a client extension (devtools UI,
 * MCP host, CLI prompt) posts via `respond()` to unblock a pending
 * elicitation.
 */
export interface ElicitationResponse {
  /**
   * Echoes the `correlationId` stamped on the outbound request
   * envelope's metadata. Routes the response to the pending Deferred.
   */
  readonly correlationId: string;
  /**
   * The client's outcome. `"accepted"` MUST carry a `value` matching
   * the request's schema; the harness re-validates and downgrades to
   * `{ outcome: "failed", failure.kind: "schema_violation" }` if
   * validation fails.
   */
  readonly outcome: "accepted" | "declined" | "cancelled";
  /** User-supplied value (present iff `outcome === "accepted"`). */
  readonly value?: unknown;
  /**
   * Human-readable explanation, optional for any outcome. Surfaces on
   * the final {@link ElicitationResult.reason}.
   */
  readonly reason?: string;
}

// ============================================================================
// Result discriminated union
// ============================================================================

/**
 * Failure detail for the `"failed"` outcome. The `kind` discriminator
 * distinguishes the source: transport-timing (`timeout`), caller-driven
 * abort (`aborted`), or schema-validation failure on an otherwise
 * accepted response (`schema_violation`).
 *
 * Issues only populate for `schema_violation`. The shape mirrors
 * `StandardSchemaResult.issues` — a path + message tuple.
 */
export interface ElicitationFailure {
  readonly kind: "timeout" | "aborted" | "schema_violation";
  /** Human-readable explanation, when one is available. */
  readonly reason?: string;
  /**
   * Schema validation issues. Populated only when
   * `kind === "schema_violation"`.
   */
  readonly issues?: ReadonlyArray<{
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
    readonly message: string;
  }>;
}

/**
 * Discriminated result handed to the caller of
 * {@link ElicitationHarnessProtocol.elicit}.
 *
 * The discriminator collapses the failure modes — callers branch on
 * "did the user accept" first; all non-accepted outcomes carry an
 * optional `reason`, and the `"failed"` arm carries a structured
 * `failure` for programmatic dispatch.
 *
 * The harness never throws for user-driven outcomes (`declined`,
 * `cancelled`) nor for transport/timing/schema failures — every
 * terminal flows through this union.
 */
export type ElicitationResult<TValue = unknown> =
  | { readonly outcome: "accepted"; readonly value: TValue }
  | { readonly outcome: "declined"; readonly reason?: string }
  | { readonly outcome: "cancelled"; readonly reason?: string }
  | { readonly outcome: "failed"; readonly failure: ElicitationFailure };

// ============================================================================
// Protocol
// ============================================================================

/**
 * Inferred `Output` type of a Standard-Schema. Defined inline so this
 * file doesn't pull the full helper namespace.
 */
type InferOutput<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

export interface ElicitationHarnessProtocol {
  /**
   * Harness identifier. Composes into the inbox address as
   * `elicitation:{id}` — external actors post `request-response`
   * envelopes here to unblock a pending elicitation. The same
   * address backs the typed convenience method {@link respond}.
   */
  readonly id: string;

  /**
   * Resolves once the harness has finished async construction (inbox
   * registration). Callers MUST `await ready` before issuing
   * `respond()` to ensure the auto-intercept is wired.
   */
  readonly ready: Promise<void>;

  /**
   * Ask the user for a structured response. Publishes the request on
   * the harness's canonical channel, awaits a correlated reply (or
   * timeout / abort), and validates the reply against the request's
   * schema before resolving.
   *
   *   timeoutMs   — bound on the wait. Defaults to the harness's
   *                 `defaultTimeoutMs` if omitted. On expiry the
   *                 caller receives
   *                 `{ outcome: "failed", failure.kind: "timeout" }`.
   *   signal      — external abort. The caller receives
   *                 `{ outcome: "failed", failure.kind: "aborted",
   *                 failure.reason }` on abort.
   *
   * Never throws for user-driven outcomes (declined / cancelled) nor
   * for transport/schema failures — every terminal flows through the
   * discriminated union so callers do not need try/catch for "user
   * said no."
   */
  elicit<TSchema extends StandardSchemaV1>(
    request: ElicitationRequest<TSchema>,
    opts?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ElicitationResult<InferOutput<TSchema>>>;

  /**
   * Typed convenience for delivering a client's response to a pending
   * elicitation. Internally routes through the inbox as a
   * `request-response` envelope, so this method shares its resolution
   * code path with cross-process responses arriving over a cluster
   * substrate. First-write-wins: a duplicate `respond()` on an
   * already-resolved correlationId is a silent no-op. Unknown
   * correlationIds are non-fatal (the elicitation already terminated
   * via timeout/abort).
   */
  respond(response: ElicitationResponse): Promise<void>;

  /**
   * Close the harness. Cancels every in-flight elicitation — each
   * resolves to `{ outcome: "failed", failure.kind: "aborted",
   * failure.reason: "harness_closed" }`. Idempotent.
   */
  close(): Promise<void>;
}

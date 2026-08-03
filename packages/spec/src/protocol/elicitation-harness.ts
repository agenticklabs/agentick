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
 *   Mode               — `"form"` (default) or `"url"`. Mirrors the
 *                        MCP draft elicitation spec. URL mode's
 *                        `accepted` outcome signals the user
 *                        consented to navigate to the URL; the actual
 *                        out-of-band completion arrives via a
 *                        separate notification (OAuth flow, payment,
 *                        credential entry) — that completion is the
 *                        OAuth-via-elicit story (#134b), layered on
 *                        top of this primitive.
 *   Wire channel       — published on a well-known channel by the
 *                        concrete impl (the canonical channel name
 *                        lives in the harness package, not spec —
 *                        spec defines the protocol shape only). The
 *                        wire envelope's `payload.schema` is a
 *                        projected JSON Schema, NOT the live
 *                        `StandardSchemaV1` (functions are not
 *                        serializable across transports).
 *   Validation         — every form-mode request carries a
 *                        `StandardSchemaV1` describing the expected
 *                        reply value. The harness validates incoming
 *                        responses against the schema before resolving
 *                        the caller's promise; invalid replies surface
 *                        as `{ outcome: "failed", failure.kind:
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
 * MCP alignment — `accepted | declined | cancelled` mirror MCP draft
 * elicitation `accept | decline | cancel` action outcomes verbatim.
 * The `form` mode and the JSON-Schema-driven request shape match
 * MCP's `elicitation/create` request directly; transports / adapters
 * map field names (`outcome` ↔ `action`, `value` ↔ `content`,
 * `schema` ↔ `requestedSchema`) at the wire edge.
 * URL mode is a draft-spec feature; protocol shape is staged so the
 * MCP integration is a wiring change, not an API break.
 * `failed` is the agentick-specific terminal for transport/timing
 * /schema failures the MCP spec doesn't surface, discriminated by
 * `failure.kind`.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see https://modelcontextprotocol.io/specification/draft/client/elicitation
 */

import type { Effect } from "effect";

import type { StandardSchemaV1 } from "../data/standard-schema.js";

// ============================================================================
// Hints — typed convention (open-ended)
// ============================================================================

/**
 * Free-form UX hints the harness passes through to subscribers
 * verbatim. The fields below are conventions — clients that recognize
 * them render accordingly; clients that don't ignore them. Always
 * optional. Always extensible via the index signature.
 *
 * The harness itself NEVER inspects these — the typed interface is
 * here so consumers (`agentick`, devtools, MCP adapters, custom
 * clients) have something to type against without locking the
 * protocol to a fixed shape.
 */
export interface ElicitationHints {
  /**
   * Client-side router key. Examples: `"tool_confirmation"`,
   * `"mcp_elicitation"`, `"approval_gate"`. Clients dispatch on this
   * to pick a custom renderer. The schema's shape remains the
   * authoritative description of WHAT is being asked.
   */
  readonly kind?: string;
  /** Heading text shown separately from `message` (subtitle / detail). */
  readonly title?: string;
  /** Placeholder rendered on the primary input control. */
  readonly placeholder?: string;
  /**
   * The action label rendered on the primary accept button. Defaults
   * are client-defined ("Submit", "OK", "Approve"). Servers MAY
   * override per prompt.
   */
  readonly acceptLabel?: string;
  /** Label on the explicit decline action. */
  readonly declineLabel?: string;
  /** Label on the cancel/dismiss action. */
  readonly cancelLabel?: string;
  /**
   * Marks the prompt destructive — clients can use this to render a
   * red/warning style on the accept button (e.g., "Delete file?").
   */
  readonly destructive?: boolean;
  /** Free-form extension slot for client-specific hints. */
  readonly [extra: string]: unknown;
}

// ============================================================================
// Request shape — discriminated by `mode`
// ============================================================================

/**
 * Form-mode elicitation request — the default and only currently
 * supported mode. Mirrors MCP's `mode: "form"` semantics: the harness
 * asks for a structured response validated by the request's schema.
 *
 * `mode` is OPTIONAL — omitting it defaults to form. This matches
 * MCP's backwards-compat behavior where a missing `mode` field is
 * treated as form mode.
 */
export interface FormElicitationRequest<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  readonly mode?: "form";
  /** Human-readable prompt shown to the user. Matches MCP's `message`. */
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
   *
   * Note on MCP alignment: MCP restricts `requestedSchema` to flat
   * objects with primitive properties + enum/oneOf for selects. The
   * agentick harness does NOT enforce that restriction — adopters
   * targeting MCP clients are responsible for keeping their schemas
   * inside MCP's subset.
   */
  readonly schema: TSchema;
  /**
   * Free-form UX hints. See {@link ElicitationHints} for documented
   * conventions (`kind`, `title`, `acceptLabel`, etc.).
   */
  readonly hints?: ElicitationHints;
  /**
   * Domain metadata stamped on the wire envelope. Logging, MCP wire
   * mapping, and audit trails consume this — the harness itself never
   * inspects it.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Optional back-reference to a {@link TasksHarnessProtocol} task id
   * that owns this elicit. When set, the published wire envelope
   * carries the same field so per-task UI surfaces (devtools task
   * panels, agentick-react task hooks) can filter elicits by
   * association rather than seeing a global firehose.
   *
   * Mirrors MCP's `_meta["io.modelcontextprotocol/related-task"].taskId`
   * convention (#173) — the MCP bridge extracts inbound elicits'
   * related-task meta and stamps this field on the harness request.
   *
   * Pure routing hint; the harness performs no lifetime coupling
   * (the elicit does NOT auto-cancel if the task terminates — that
   * coupling is the caller's policy decision).
   */
  readonly relatedTaskId?: string;
}

/**
 * URL-mode elicitation request — directs the user to an external URL
 * for an out-of-band interaction (OAuth, payment, credential entry).
 * Mirrors MCP draft `mode: "url"`.
 *
 * URL mode's `accepted` outcome means the user consented to open the
 * URL — NOT that the out-of-band interaction completed. Completion
 * arrives via a separate notification path layered on top of this
 * consent signal (OAuth flows wire this via `notifications/elicitation/
 * complete`-style notifications; #134b).
 */
export interface UrlElicitationRequest {
  readonly mode: "url";
  /** Human-readable explanation of why the URL is being opened. */
  readonly message: string;
  /**
   * The URL the user should navigate to. MUST be a valid URL. MCP's
   * draft elicitation spec imposes strict safety requirements
   * (HTTPS, no pre-authenticated tokens, no end-user PII in the URL) —
   * URL-mode adopters MUST honor those.
   */
  readonly url: string;
  /**
   * Stable identifier for the URL flow. Used by completion
   * notifications to route the out-of-band result back. Distinct from
   * the registry-level correlationId (which scopes the elicit() Promise).
   * Mirrors MCP's `elicitationId`.
   */
  readonly elicitationId: string;
  readonly hints?: ElicitationHints;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Optional back-reference to a {@link TasksHarnessProtocol} task id
   * that owns this elicit — same semantics as the form-mode field.
   * URL-mode elicits originating from a task (e.g. OAuth prompted by
   * a long-running tool task) carry this so per-task surfaces can
   * surface the consent prompt inline.
   */
  readonly relatedTaskId?: string;
}

/**
 * Discriminated union of supported elicitation request shapes. Form
 * mode is the default.
 */
export type ElicitationRequest<TSchema extends StandardSchemaV1 = StandardSchemaV1> =
  | FormElicitationRequest<TSchema>
  | UrlElicitationRequest;

// ============================================================================
// Response shape
// ============================================================================

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
   * the request's schema (form mode); the harness re-validates and
   * downgrades to `{ outcome: "failed", failure.kind:
   * "schema_violation" }` if validation fails. For URL mode (when
   * implemented), accepted carries no value — the user consented to
   * the URL open; the actual completion arrives via a separate
   * notification.
   */
  readonly outcome: "accepted" | "declined" | "cancelled";
  /** User-supplied value (form-mode accepted only). */
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
   * Cluster-portable inbox address — `${surface}:${scopeId}` per the
   * BaseHarness convention. Other harnesses send `elicit-request`
   * inbox messages here to drive an elicit on this harness without an
   * in-process object reference; cluster-aware substrates route by
   * the same address to whichever node owns the harness.
   *
   * Exposed on the protocol (not just the concrete class) so adopter
   * impls — fakes, stubs, future cluster-shimmed variants — carry
   * the same surface.
   */
  readonly address: string;

  /**
   * Ask the user for a structured response. Publishes the request on
   * the harness's canonical channel, awaits a correlated reply (or
   * timeout / abort), and validates the reply against the request's
   * schema before resolving.
   *
   * Form mode (default) returns `ElicitationResult<TValue>` where
   * `TValue` is inferred from the request's `schema`. URL mode (when
   * implemented) returns `ElicitationResult<undefined>` because the
   * `accepted` outcome only signals consent to open the URL — actual
   * completion arrives via a separate notification.
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
   * for transport/schema/timing failures — every semantic terminal
   * flows through the result union.
   */
  elicit<TSchema extends StandardSchemaV1>(
    request: FormElicitationRequest<TSchema>,
    opts?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ElicitationResult<InferOutput<TSchema>>>;
  elicit(
    request: UrlElicitationRequest,
    opts?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ElicitationResult<undefined>>;

  /**
   * Effect-canonical twin of {@link elicit} — the same operation, un-run.
   *
   * Published because a caller that is ALREADY inside an operation must be
   * able to keep the elicit under it. `elicit()` resolves through
   * `runHarnessProtocol`, which starts a root fiber inheriting no FiberRef, so
   * the op's ambient `RuntimeContext` is empty and `inheritScope` has nothing
   * to merge: an elicit raised from a tool handler landed with neither
   * `executionId` nor `tickId` while the `tool:command:dispatch` that caused it
   * carried both. Handing out the un-run Effect lets the caller run it on a
   * runtime captured in-fiber (`runHarnessProtocolOn`) so the op nests instead
   * of orphaning.
   *
   * A protocol that publishes only the Promise face structurally forces every
   * in-process caller onto a severing root — the same defect `HarnessEdge`
   * exists to prevent for command-shaped harnesses. This harness declares no
   * commands (it hand-builds its Operation), so the twin is hand-written.
   *
   * @see packages/session/src/__tests__/dispatch-scope-inheritance.spec.tsx
   */
  elicitFx<TSchema extends StandardSchemaV1>(
    request: ElicitationRequest<TSchema> | UrlElicitationRequest,
    opts?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Effect.Effect<
    ElicitationResult<InferOutput<TSchema>> | ElicitationResult<undefined>,
    unknown,
    never
  >;

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

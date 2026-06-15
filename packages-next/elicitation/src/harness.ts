/**
 * ElicitationHarness — substrate-level "ask user X" primitive.
 *
 * Extends {@link BaseHarness} so every elicitation participates in the
 * runtime's request/response correlation engine + journaling + bus
 * envelope contract. The harness is intentionally thin: it owns the
 * channel name, the wire payload shape, and the schema-validation
 * step. The hard work (correlation, timeout, abort) is inherited from
 * `BaseHarness.request()` → `RequestResponseRegistry`.
 *
 *   Wire payload    — `payload.schema` is a JSON Schema (projection
 *                     of the request's `StandardSchemaV1` via
 *                     `toJsonSchema()`). Functions are not
 *                     serializable across transports; subscribers
 *                     see the schema in wire form, the server side
 *                     keeps the live validator for re-validation.
 *   Validation      — accepted responses are run through the live
 *                     Standard-Schema. Sync AND async validators are
 *                     supported (the harness awaits Promise verdicts).
 *                     Validation failures surface as `{ outcome:
 *                     "failed", failure.kind: "schema_violation",
 *                     failure.issues }` — never throw.
 *   respond()       — typed convenience that routes through the inbox
 *                     as a `request-response` envelope. In-process
 *                     and cross-process resolution flow through ONE
 *                     code path (`BaseHarness.dispatchMessage`
 *                     auto-intercept → `requests.resolve`).
 *   close()         — cancels every in-flight elicitation
 *                     (`{ outcome: "failed", failure.kind: "aborted",
 *                     failure.reason: "harness_closed" }`).
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import { Effect, Either } from "effect";
import { BaseHarness } from "@agentick/runtime-next";
import type { RequestError } from "@agentick/runtime-next";
import type {
  ElicitationFailure,
  ElicitationHarnessProtocol,
  ElicitationRequest,
  ElicitationResponse,
  ElicitationResult,
  EventBus,
  FormElicitationRequest,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  StandardSchemaResult,
  StandardSchemaV1,
  UnsupportedElicitationModeError,
  UrlElicitationRequest,
} from "@agentick/spec-next";
import { toJsonSchema } from "@agentick/spec-next";

import { ELICITATION_CHANNEL } from "./channel.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// ============================================================================
// Options
// ============================================================================

export interface ElicitationHarnessOptions {
  /**
   * Default wait bound applied when the caller does not pass
   * `timeoutMs`. Defaults to 5 minutes — long enough for a human in
   * the loop, short enough that a forgotten prompt frees the fiber.
   */
  readonly defaultTimeoutMs?: number;
  /**
   * Scope stamped on every published elicitation request envelope.
   * Session-scoped client subscriptions (`client.session(id).elicitations()`)
   * filter on `scope.sessionId`, so per-session elicitation harnesses
   * MUST pass `{ sessionId }` here — otherwise the gateway's
   * subscription router silently drops the envelope. Construction
   * sites in production (`AppHarness.createSession`, `withElicitation`,
   * `buildSessionBridges`) thread the owning session's id through.
   */
  readonly parentScope?: import("@agentick/spec-next").EventScope;
}

// ============================================================================
// Harness
// ============================================================================

export class ElicitationHarness
  extends BaseHarness<"elicitation">
  implements ElicitationHarnessProtocol
{
  private readonly defaultTimeoutMs: number;
  private readonly parentScope: import("@agentick/spec-next").EventScope | undefined;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ElicitationHarnessOptions = {},
  ) {
    super("elicitation", scopeId, journal, bus, inbox);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.parentScope = options.parentScope;
  }

  // ─────────── elicit ───────────

  elicit<TSchema extends StandardSchemaV1>(
    request: FormElicitationRequest<TSchema>,
    opts?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ElicitationResult<InferOutput<TSchema>>>;
  elicit(
    request: UrlElicitationRequest,
    opts?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ElicitationResult<undefined>>;
  async elicit<TSchema extends StandardSchemaV1>(
    request: ElicitationRequest<TSchema>,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ElicitationResult<InferOutput<TSchema>> | ElicitationResult<undefined>> {
    // URL mode is declared in the protocol shape for future MCP
    // integration but not yet wired. Throw a tagged developer-misuse
    // error rather than a result-union outcome — "you used a feature
    // that doesn't exist yet" is not a semantic terminal of an
    // elicitation; it's a wiring gap that needs developer attention
    // with a stack trace. When URL-mode lands this branch is replaced
    // with the real implementation; consumer code pattern-matching
    // against the result union doesn't need to change.
    if (request.mode === "url") {
      throw {
        _tag: "UnsupportedElicitationModeError",
        mode: "url",
        message:
          "URL-mode elicitation is staged on the protocol surface but not " +
          "yet wired. Track progress alongside the MCP integration roadmap.",
      } satisfies UnsupportedElicitationModeError;
    }

    // Form mode below. The discriminator narrowing above guarantees
    // `request` is a `FormElicitationRequest<TSchema>`.
    const formRequest = request;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    // Project the live StandardSchemaV1 to a JSON Schema on the wire.
    // Functions are not serializable; transports MUST NOT see the
    // validator. Server-side keeps `request.schema` for re-validation.
    const wireSchema = toJsonSchema(formRequest.schema);
    const payload: WirePayload = {
      mode: "form",
      message: formRequest.message,
      schema: wireSchema,
      ...(formRequest.hints !== undefined ? { hints: formRequest.hints } : {}),
      ...(formRequest.metadata !== undefined ? { metadata: formRequest.metadata } : {}),
    };

    const effect = this.request<WirePayload, ElicitationResponse>(ELICITATION_CHANNEL, payload, {
      timeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(this.parentScope !== undefined ? { scope: this.parentScope } : {}),
    });

    // `Effect.either` keeps the typed RequestError accessible — bare
    // `Effect.runPromise` would wrap it in a FiberFailure and strip
    // the discriminant. Schema validation may be async, so we leave
    // the Effect pipeline early and finish in async/await space.
    const either = await Effect.runPromise(effect.pipe(Effect.either));
    if (Either.isLeft(either)) {
      return toFailureResult<InferOutput<TSchema>>(either.left);
    }
    const response = either.right;

    if (response.outcome === "accepted") {
      return await this.validateAccepted(formRequest.schema, response);
    }
    // declined | cancelled pass through verbatim.
    return {
      outcome: response.outcome,
      ...(response.reason !== undefined ? { reason: response.reason } : {}),
    };
  }

  // ─────────── respond ───────────

  /**
   * Route the response through this harness's inbox so the same
   * `BaseHarness.dispatchMessage` auto-intercept handles in-process
   * and cross-process replies identically. First-write-wins on the
   * registry — duplicates are silently dropped. Responses arriving
   * after `close()` (when the inbox subscription is gone) are
   * silently swallowed — there's nothing to deliver to and the
   * idempotence contract calls for a no-op terminal.
   */
  async respond(response: ElicitationResponse): Promise<void> {
    const send = this.inbox.send(this.address, {
      type: "request-response",
      correlationId: response.correlationId,
      payload: { correlationId: response.correlationId, response },
    });
    await Effect.runPromise(
      send.pipe(
        Effect.catchAll((err) => {
          // AddressNotFound after close → no-op. Anything else
          // bubbles via failCause so callers see the typed error.
          if (
            typeof err === "object" &&
            err !== null &&
            (err as { _tag?: string })._tag === "AddressNotFound"
          ) {
            return Effect.succeed(undefined);
          }
          return Effect.fail(err);
        }),
      ),
    );
  }

  // ─────────── close ───────────

  /**
   * Override `close()` to cancel every in-flight elicitation. Each
   * pending elicit resolves to `{ outcome: "failed",
   * failure.kind: "aborted", failure.reason: "harness_closed" }`.
   * Cancel happens BEFORE the inbox subscription is torn down so the
   * subscribed registry sees the cancellation route through the
   * normal failure path.
   */
  override async close(): Promise<void> {
    this.requests.cancelAll("harness_closed");
    await super.close();
  }

  // ─────────── diagnostics + inbox ───────────

  /**
   * Concrete-class diagnostic. NOT on the protocol — tests use it to
   * assert in-flight counts; production callers MUST NOT depend on
   * this for control flow. Out of band of any contract.
   */
  pendingCount(): number {
    return this.requests.size();
  }

  /**
   * No subclass-specific inbox messages — `request-response`
   * envelopes are intercepted by `BaseHarness.dispatchMessage` before
   * this method is consulted, and that's the only message type this
   * harness expects. Anything else is a routing bug — fail loud.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: `Unknown elicitation message type: ${String((msg as { type?: string }).type)}`,
    });
  }

  // ─────────── internals ───────────

  private async validateAccepted<TSchema extends StandardSchemaV1>(
    schema: TSchema,
    response: ElicitationResponse,
  ): Promise<ElicitationResult<InferOutput<TSchema>>> {
    // Standard-Schema's contract is `Result | Promise<Result>`. We
    // accept both — async validators (Zod refine, Valibot pipeAsync,
    // ArkType narrow) are fully supported. The await is a no-op for
    // synchronous validators (microtask cost only).
    const verdict = await schema["~standard"].validate(response.value);
    const result = verdict as StandardSchemaResult<InferOutput<TSchema>>;
    if (result.issues && result.issues.length > 0) {
      const failure: ElicitationFailure = {
        kind: "schema_violation",
        reason: result.issues.map((i) => i.message).join("; "),
        issues: result.issues as ElicitationFailure["issues"],
      };
      return { outcome: "failed", failure };
    }
    return {
      outcome: "accepted",
      value: result.value as InferOutput<TSchema>,
    };
  }
}

// ============================================================================
// Internal helpers + types
// ============================================================================

interface WirePayload {
  readonly mode: "form";
  readonly message: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly hints?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

type InferOutput<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

function toFailureResult<TValue>(err: RequestError): ElicitationResult<TValue> {
  if (err._tag === "RequestTimeoutError") {
    return { outcome: "failed", failure: { kind: "timeout" } };
  }
  // RequestAbortedError + RequestCancelledError collapse to the same
  // "aborted" failure — the registry distinguishes signal-driven
  // aborts from explicit cancel(), but consumers don't care which.
  return {
    outcome: "failed",
    failure: {
      kind: "aborted",
      ...(err.reason !== undefined ? { reason: stringifyReason(err.reason) } : {}),
    },
  };
}

function stringifyReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

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
import {
  BaseHarness,
  runHarnessProtocol,
  ulid,
  type BaseHarnessOptions,
  type Middleware,
} from "@agentick/runtime";
import { reasonOf, omitUndefined } from "@agentick/utils";
import type { RequestError } from "@agentick/runtime";
import type {
  ChannelSnapshotProvider,
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
  Operation,
  OperationJournal,
  StandardSchemaResult,
  StandardSchemaV1,
  UrlElicitationRequest,
} from "@agentick/spec";
import { HandlerError, toJsonSchema } from "@agentick/spec";

import { ELICITATION_CHANNEL, type ElicitationSnapshotFrame } from "./channel.js";
import type { ElicitRequestInboxPayload } from "./inbox-protocol.js";

// ============================================================================
// Command lifecycle hooks (ADR 80/83) — typed CommandRegistry augmentation.
// ============================================================================
//
// The elicit round-trip now routes through `runOperation` (see `elicitOp`), so
// it mints a typed `onBefore…` / `onAfter…` hook pair via the derived
// `CommandHooks` surface. ONE op models the WHOLE request→await→response
// round-trip: the `before` face is the outbound request (transform the prompt,
// or veto); the `after` face is the resolved `ElicitationResult` (observe /
// transform the reply). Form and URL modes share this one op — they are two
// modes of the same "ask the user" verb (mirrors MCP `elicitation/create`), so
// `request.mode` on the input discriminates.
//
// The registry key is the canonical `elicitation:elicit` form (the `:command:`
// infix `deriveHookNames` strips), so it derives to
// `onBeforeElicitationElicit` / `onAfterElicitationElicit`.
//
// WIRE (ADR 51): unlike a purely in-process command, an elicit INHERENTLY
// crosses to the client — the op body's inner `this.request(ELICITATION_CHANNEL,
// …)` publishes the prompt on the bus and awaits the client's `respond()`. The
// HOOKS, however, run server-side around that round-trip: `onBefore…` fires
// before the request envelope is published, `onAfter…` after the reply resolves
// locally. So the op is hookable server-side even though its effect is a wire
// crossing; the op itself is NOT wire-addressable (no `CommandDescriptor` — the
// elicit is DRIVEN locally and only its payload projects to the client).
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "elicitation:elicit": { input: ElicitationRequest; output: ElicitationResult };
  }
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// ============================================================================
// Options
// ============================================================================

/**
 * `extends BaseHarnessOptions` so every substrate slot the base accepts —
 * `parentScope`, `principal`, telemetry, metadata, the interceptor fold — arrives
 * without being re-declared here and re-forwarded by hand. Standing alone, this
 * interface silently dropped every base option a caller passed, and each one had to
 * be rediscovered the next time something needed it.
 */
export interface ElicitationHarnessOptions extends BaseHarnessOptions {
  /**
   * Default wait bound applied when the caller does not pass
   * `timeoutMs`. Defaults to 5 minutes — long enough for a human in
   * the loop, short enough that a forgotten prompt frees the fiber.
   */
  readonly defaultTimeoutMs?: number;
  /**
   * Scope stamped on every published elicitation request envelope.
   * Session-scoped client subscriptions (`client.session(id).elicitations`)
   * filter on `scope.sessionId`, so per-session elicitation harnesses
   * MUST pass `{ sessionId }` here — otherwise the gateway's
   * subscription router silently drops the envelope. Construction
   * sites in production (`AppHarness.createSession`, `withElicitation`,
   * `buildSessionBridges`) thread the owning session's id through.
   */
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment) — the
   * parent scope's resolved interceptors (guards, `.use` transforms, AND
   * declarative command hooks adapted to op-scoped middleware), folded in at
   * construction and forwarded to {@link BaseHarness} so ancestor-scope
   * interceptors wrap this harness's ops. Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4) — the AppHarness (this per-session
   * harness is constructed by the app). Keeps inheritance live so a LATER
   * `app.use()` / `app.guard()` / `app.hook()` reaches this harness's ops, not
   * just the construction snapshot. Forwarded to {@link BaseHarness}.
   */
  readonly interceptorParent?: BaseHarness;
}

// ============================================================================
// Harness
// ============================================================================

export class ElicitationHarness
  extends BaseHarness<"elicitation">
  implements ElicitationHarnessProtocol, ChannelSnapshotProvider
{
  private readonly defaultTimeoutMs: number;

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
    super("elicitation", scopeId, journal, bus, inbox, options);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  elicit<TSchema extends StandardSchemaV1>(
    request: ElicitationRequest<TSchema>,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ElicitationResult<InferOutput<TSchema>> | ElicitationResult<undefined>> {
    // Model the whole request→await→response round-trip as ONE
    // `elicitation:elicit` operation so the ADR-83 interceptor seam fires
    // around it (guards / `.use()` middleware / the derived command hooks):
    //
    //   onBeforeElicitationElicit(request) — before the request is published:
    //                                        transform the prompt, or veto.
    //   onAfterElicitationElicit(result)   — when the reply resolves locally:
    //                                        observe / transform the terminal.
    //
    // The op input is the SEMANTIC request (carrying `mode`); a before-hook's
    // reshaped request is what the body dispatches. `opts` (timeout / signal)
    // is per-call transport config — NOT part of the hookable request — so it
    // rides the closure. Both form + url variants share this ONE op (see the
    // CommandRegistry note above). `respond()` stays outside: it is the reply
    // DELIVERY that unblocks the awaiting body — the "after" side of the op —
    // not a separate operation.
    return this.elicitOp<ElicitationResult<InferOutput<TSchema>> | ElicitationResult<undefined>>(
      request,
      (req) => {
        if (req.mode === "url") {
          return this.elicitUrl(req, opts);
        }
        return this.elicitForm(req as FormElicitationRequest<TSchema>, opts);
      },
    );
  }

  /**
   * Wrap an elicit round-trip in {@link BaseHarness.runOperation} so it fires
   * the ADR-83 interceptor seam and the full phase contract (`requested` →
   * `before` → terminal), exactly as every other harness command does. Mints a
   * fresh `opId` per call (`elicitation:elicit:<ulid>`) — an elicit carries no
   * caller-supplied idempotency key, so each invocation is its own operation
   * (no journal replay). The op `name` follows the executor convention
   * (`<surface>:command:<verb>`), which {@link deriveHookNames} strips to the
   * `elicitation:elicit` CommandRegistry key.
   *
   * The op scope reuses this harness's `parentScope` (the owning session's
   * `{ sessionId }` in production) so the op's `requested` / `before` /
   * `terminal` envelopes carry the same scope as the inner request envelope the
   * body publishes — session-scoped subscribers see one coherent scope.
   *
   * The `body` is UNCHANGED from the pre-wrap surface: the same `elicitForm` /
   * `elicitUrl` promise, dispatched on the (possibly hook-reshaped) request.
   * Wrapping is purely additive — with no guards/hooks registered,
   * `runOperation` composes to a pass-through around the identical body. The
   * body is long-lived (it awaits the client reply); that is fine —
   * `runOperation` bodies may be long, and interruption already works.
   */
  private elicitOp<R>(
    request: ElicitationRequest,
    run: (request: ElicitationRequest) => Promise<R>,
  ): Promise<R> {
    return runHarnessProtocol(this.elicitOpFx(request, run));
  }

  /**
   * The un-run operation Effect behind {@link elicitOp} — the composable form.
   *
   * Why this is separate: `runHarnessProtocol` starts a ROOT fiber, which
   * inherits no FiberRef, so the op's ambient `RuntimeContext` is EMPTY and
   * `inheritScope` has nothing to merge. An elicit raised from a tool handler
   * therefore landed with neither `executionId` nor `tickId` even though the
   * `tool:command:dispatch` it came from carried both — measured in
   * `session/__tests__/dispatch-scope-inheritance.spec.tsx`.
   *
   * The `scope: this.parentScope ?? {}` below is NOT the cause and was wrongly
   * blamed at first: `inheritScope(ambient, own)` merges ambient UNDER own and
   * drops undefined, so a construction-bound scope that declares no
   * `executionId` / `tickId` never erases an inherited one. The empty ambient
   * was the whole problem.
   *
   * Handing the caller the Effect lets them run it on a runtime captured
   * IN-FIBER (`runHarnessProtocolOn`), which carries that fiber's FiberRefs —
   * so the op nests under the dispatch instead of orphaning.
   */
  elicitOpFx<R>(
    request: ElicitationRequest,
    run: (request: ElicitationRequest) => Promise<R>,
  ): Effect.Effect<R, unknown, never> {
    const op: Operation<ElicitationRequest, R> = {
      opId: `elicitation:elicit:${ulid()}`,
      surface: "elicitation",
      name: "elicitation:command:elicit",
      scope: this.parentScope ?? {},
      input: request,
    };
    return this.runOperation(op, (req) =>
      Effect.tryPromise({
        // `elicitForm` / `elicitUrl` NEVER reject — every terminal
        // (user-driven, transport, timeout, schema) lands on an
        // `ElicitationResult`. The `catch` re-raises verbatim purely to
        // preserve the pre-wrap async surface's contract (a bug that DID
        // throw would have rejected `elicit()` before too).
        try: () => run(req),
        catch: (cause) => cause,
      }),
    );
  }

  /**
   * Effect-canonical twin of {@link elicit} — the same operation, un-run.
   * Compose it in-fiber, or run it on a captured runtime so the op inherits
   * the caller's scope. See {@link elicitOpFx}.
   */
  elicitFx<TSchema extends StandardSchemaV1>(
    request: ElicitationRequest<TSchema> | UrlElicitationRequest,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Effect.Effect<
    ElicitationResult<InferOutput<TSchema>> | ElicitationResult<undefined>,
    unknown,
    never
  > {
    return this.elicitOpFx<ElicitationResult<InferOutput<TSchema>> | ElicitationResult<undefined>>(
      request as ElicitationRequest,
      (req) => {
        if (req.mode === "url") return this.elicitUrl(req, opts);
        return this.elicitForm(req as FormElicitationRequest<TSchema>, opts);
      },
    );
  }

  private async elicitForm<TSchema extends StandardSchemaV1>(
    request: FormElicitationRequest<TSchema>,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ElicitationResult<InferOutput<TSchema>>> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    // Project the live StandardSchemaV1 to a JSON Schema on the wire.
    // Functions are not serializable; transports MUST NOT see the
    // validator. Server-side keeps `request.schema` for re-validation.
    //
    // The harness is transport-agnostic — bus subscribers may be an
    // MCP-server projection (constrained to flat schemas per MCP
    // spec), a React UI (can render anything), devtools, etc. We
    // therefore do NOT enforce MCP-style flatness here. Subscribers
    // that need it call `assertFlatSchema` from this package against
    // the wire JSON Schema before forwarding to their transport.
    const wireSchema = toJsonSchema(request.schema);
    const payload: FormWirePayload = {
      mode: "form",
      message: request.message,
      schema: wireSchema,
      ...omitUndefined({
        hints: request.hints,
        metadata: request.metadata,
        relatedTaskId: request.relatedTaskId,
      }),
    };

    const effect = this.request<FormWirePayload, ElicitationResponse>(
      ELICITATION_CHANNEL,
      payload,
      {
        timeoutMs,
        ...omitUndefined({ signal: opts.signal, scope: this.parentScope }),
      },
    );

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
      return await this.validateAccepted(request.schema, response);
    }
    // declined | cancelled pass through verbatim.
    return {
      outcome: response.outcome,
      ...omitUndefined({ reason: response.reason }),
    };
  }

  private async elicitUrl(
    request: UrlElicitationRequest,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ElicitationResult<undefined>> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    // URL mode carries no schema. The semantic terminal of "accepted"
    // is "the user consented to open the URL" — NOT "the out-of-band
    // interaction completed." Out-of-band completion is a separate
    // notification (TBD). For now, accepted maps to value=undefined;
    // adopters wiring OAuth-style flows (#134b) layer a completion
    // notification on top of this consent signal.
    const payload: UrlWirePayload = {
      mode: "url",
      message: request.message,
      url: request.url,
      elicitationId: request.elicitationId,
      ...omitUndefined({
        hints: request.hints,
        metadata: request.metadata,
        relatedTaskId: request.relatedTaskId,
      }),
    };

    const effect = this.request<UrlWirePayload, ElicitationResponse>(ELICITATION_CHANNEL, payload, {
      timeoutMs,
      ...omitUndefined({ signal: opts.signal, scope: this.parentScope }),
    });

    const either = await Effect.runPromise(effect.pipe(Effect.either));
    if (Either.isLeft(either)) {
      return toFailureResult<undefined>(either.left);
    }
    const response = either.right;

    if (response.outcome === "accepted") {
      // No `value` channel — URL-mode accepted means "user consented
      // to open the URL." Any value the client sent alongside is
      // ignored; the contract is just consent.
      return { outcome: "accepted", value: undefined };
    }
    return {
      outcome: response.outcome,
      ...omitUndefined({ reason: response.reason }),
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
  protected override teardown(): void {
    this.requests.cancelAll("harness_closed");
  }

  // ─────────── channel snapshot (§6.1 — pending-ask enumeration) ───────────

  /**
   * The channel this harness snapshots — {@link ChannelSnapshotProvider}. The
   * session scans its bridges for this and, on `sub/subscribe`, prepends
   * {@link channelSnapshotPayload} as the opening frame a fresh
   * `session:channel:elicitation` subscriber receives before any live delta.
   */
  readonly snapshotChannel = ELICITATION_CHANNEL;

  /**
   * {@link ChannelSnapshotProvider} — every ask currently awaiting a response
   * as the channel's opening frame (§6.1, the live-only defect fix). Projects
   * `BaseHarness.pendingRequests(ELICITATION_CHANNEL)` — the in-flight
   * `request()`s the registry already holds — into a discriminated
   * `kind: "snapshot"` frame. An observation: reads pending state, publishes
   * nothing. Includes tool-confirmation asks (they ride this same channel via
   * `elicit()`), which is correct — a mid-confirmation subscriber sees them.
   */
  channelSnapshotPayload(): ElicitationSnapshotFrame {
    return {
      kind: "snapshot",
      requests: this.pendingRequests(ELICITATION_CHANNEL).map((p) => ({
        correlationId: p.correlationId,
        replyTo: p.replyTo,
        payload: p.payload,
      })),
    };
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
   * Inbox dispatch:
   *
   *   - `request-response` → auto-intercepted by `BaseHarness`. Not
   *     seen here.
   *   - `elicit-request` → cross-harness RPC. Another harness (MCP's
   *     bridge today; future workspace/roots bridges later) sends
   *     this to drive a form- or url-mode elicit through THIS
   *     harness's local code path, then routes the reply back to the
   *     caller's address as a `request-response` envelope keyed by
   *     the supplied `correlationId`. Same protocol cluster-side and
   *     in-process.
   *   - Anything else → routing bug; fail loud.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    if (msg.type === "elicit-request") {
      return this.handleElicitRequest(msg as MessageEnvelope<ElicitRequestInboxPayload>);
    }
    return Effect.fail(
      new HandlerError({
        cause: `Unknown elicitation message type: ${String((msg as { type?: string }).type)}`,
      }),
    );
  }

  /**
   * Run an elicit on behalf of another harness reached via inbox.
   * The caller stamped `replyTo` + `correlationId` on the message;
   * we route the result back as a `request-response` envelope so the
   * caller's `BaseHarness.dispatchMessage` auto-intercept resolves
   * its pending Deferred. Errors during elicit() are mapped to
   * `outcome: "failed"` so the caller always sees a typed terminal.
   */
  private handleElicitRequest(
    msg: MessageEnvelope<ElicitRequestInboxPayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    if (msg.payload === undefined) {
      return Effect.fail(new HandlerError({ cause: "elicit-request envelope missing payload" }));
    }
    const { request, replyTo, correlationId } = msg.payload;
    return Effect.tryPromise<unknown, MessageHandlerError>({
      try: async () => {
        const result =
          request.mode === "url"
            ? await this.elicit(request)
            : await this.elicit(request as FormElicitationRequest<StandardSchemaV1>);
        await Effect.runPromise(
          this.inbox.send(replyTo, {
            type: "request-response",
            correlationId,
            payload: { correlationId, response: result },
          }),
        );
        return undefined;
      },
      catch: (cause): MessageHandlerError => new HandlerError({ cause }),
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

interface FormWirePayload {
  readonly mode: "form";
  readonly message: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly hints?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly relatedTaskId?: string;
}

interface UrlWirePayload {
  readonly mode: "url";
  readonly message: string;
  readonly url: string;
  readonly elicitationId: string;
  readonly hints?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly relatedTaskId?: string;
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
      ...(err.reason !== undefined ? { reason: reasonOf(err.reason) } : {}),
    },
  };
}

// Reason-string conversion lives in @agentick/utils/cause as
// `reasonOf` — single canonical impl. Aligning here also gains the
// `{_tag}` extraction branch (Effect tagged errors no longer round-
// trip as `'{"_tag":"X"}'`).

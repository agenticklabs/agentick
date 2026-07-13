/**
 * `ToolExecutorHarness` — reference implementation of
 * `ToolExecutorProtocol`.
 *
 * Extends `BaseHarness<"tool">` from `@agentick/runtime-next`. Owns:
 *
 *   - an in-memory tool registry (declaration + handlerRef + useDeps),
 *   - a handler resolver (handlerRef → handler + validator),
 *   - a per-call AbortController map for in-flight tracking.
 *
 * Validation, exposure checks, handler invocation, and abort all run
 * inside `runOperation`, so every dispatch produces the canonical
 * phase-contract envelope sequence
 * (`requested → before → terminal`) on `surface: "tool"`.
 *
 * Phase 4a.4 covers the happy path + abort. Confirmation flow (4a.5),
 * middleware + lifecycle handler hooks (4a.6), and inbox dispatcher
 * (4a.7) land in follow-up commits.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import { omitUndefined } from "@agentick/utils-next";
import { buildSessionElicit } from "@agentick/elicitation-next";

import { Cause, Effect, Exit, Option } from "effect";
import { getContext, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import { BaseHarness, type GuardDecider, type Unsubscribe } from "@agentick/runtime-next";
import type {
  AbortInput,
  ChannelPublisher,
  ContentBlock,
  DispatchInput,
  DispatchResult,
  ElicitationHarnessProtocol,
  EventBus,
  EventScope,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  NormalizedToolResult,
  Operation,
  OperationJournal,
  RegisterToolInput,
  RemoveBoundToolsInput,
  Resources,
  ReplaceReconcilerToolsInput,
  SubstrateError,
  TaskHandle,
  TasksHarnessProtocol,
  ToolDeclaration,
  ToolExecutorErrorChannel,
  ToolExecutorFx,
  ToolExecutorProtocol,
  ToolListFilter,
  ToolRegistration,
  ToolResultInput,
  UnregisterToolInput,
} from "@agentick/spec-next";
import { normalizeToolResult } from "@agentick/spec-next";
import { viaToOrigin } from "./provenance.js";
import {
  HandlerError,
  isTaskHandle,
  ToolAbortedError,
  ToolConfirmationTimeoutError,
  ToolHandlerError,
  ToolHandlerMissing,
  ToolNotFoundError,
  ToolPermissionError,
  ToolTaskModeConflictError,
  ToolTimeoutError,
  ToolValidationError,
} from "@agentick/spec-next";

import {
  TOOL_CONFIRMATION_KIND,
  TOOL_CONFIRMATION_REPLY_SCHEMA,
  type ToolConfirmationReply,
} from "./confirmation-schema.js";
import { InMemoryToolRegistry, sameBindingKey } from "./registry.js";
import { fromStandardSchema } from "./validator.js";
import type {
  HandlerResolver,
  HandlerChannelSeed,
  ToolExecutorHarnessOptions,
  ToolHandlerCtx,
  ValidatorResult,
} from "./types.js";

// ADR 80 — contribute this harness's exposed `tool:dispatch` verb to the
// command registry, so `CommandHooks` gains typed `onBeforeToolDispatch` /
// `onAfterToolDispatch` participants (before ← input, after ← the dispatch
// content). One line per verb; both hooks fall out via the mapped type.
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    // `output` is the richer `DispatchResult` the command body actually returns
    // (`this.command<DispatchInput, DispatchResult>` below) — NOT the bare
    // `ContentBlock[]`. This makes `onAfterToolDispatch` transform-SOUND: an
    // after-hook sees and may return a `DispatchResult`, so it can't silently
    // strip `isError`/metadata off `session.dispatch()`.
    "tool:dispatch": { input: DispatchInput; output: DispatchResult };
  }
}

interface InFlightEntry {
  readonly controller: AbortController;
  readonly toolName: string;
}

export class ToolExecutorHarness extends BaseHarness<"tool"> implements ToolExecutorProtocol {
  private readonly registry = new InMemoryToolRegistry();
  private readonly handlerResolver: HandlerResolver;
  private readonly inFlight = new Map<string, InFlightEntry>();
  /** Tool names the host has marked `always` for this session. */
  private readonly alwaysAllowed = new Set<string>();
  private readonly stateStore = new Map<string, unknown>();
  private readonly defaultTimeoutMs?: number;
  private readonly defaultConfirmationTimeoutMs?: number;
  private readonly channelPublisher?: ChannelPublisher;
  private readonly elicitation: ElicitationHarnessProtocol;
  private readonly tasks: TasksHarnessProtocol | undefined;
  private readonly resources: Resources | undefined;
  /**
   * Opaque, harness-agnostic `ctx` extension bag spread onto every
   * handler's `ctx` (ADR 66). Typed by `ToolHandlerCtxExtensions`
   * augmentations; filled by the wiring layer. The executor never
   * inspects it.
   */
  private readonly ctxExtensions: Readonly<Record<string, unknown>>;

  /**
   * Cancel an in-flight dispatch (ADR 51 / ADR 66). A declared command —
   * so the same verb is reachable in-process (this method), over the
   * inbox (a `tool:abort` message auto-routes here via
   * `BaseHarness.dispatchMessage`), and — should a wire seam want it —
   * grantable. The body ({@link abortBody}) fires the AbortController
   * SYNCHRONOUSLY; the command wrapper adds journaling AROUND it, never
   * latency, so cancellation stays immediate.
   */
  readonly abort: (input: AbortInput) => Promise<void>;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ToolExecutorHarnessOptions,
  ) {
    super("tool", scopeId, journal, bus, inbox, { hooks: options.hooks });
    this.handlerResolver = options.handlerResolver;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.defaultConfirmationTimeoutMs = options.defaultConfirmationTimeoutMs;
    this.channelPublisher = options.channelPublisher;
    this.elicitation = options.elicitation;
    this.tasks = options.tasks;
    this.resources = options.resources;
    this.ctxExtensions = options.ctxExtensions ?? {};

    // `abort` as a declared command (ADR 51). Canonical verb `tool:abort`
    // (the inbox message type); the derived Operation name is
    // `tool:command:abort`, matching the sibling hand-rolled ops. Default
    // `addressable` exposure makes it inbox-reachable — that's the whole
    // point: an external actor (the session on user-escape) can cancel an
    // in-flight dispatch by `send`-ing `tool:abort` to this harness's
    // address, no hand-rolled inbox switch required.
    this.abort = this.command<AbortInput, void, never>({
      name: "tool:abort",
      scope: () => ({ sessionId: this.scopeId }),
      handler: (i) => Effect.sync(() => this.abortBody(i)),
    });

    // `dispatch` as a declared command (ADR 51/66). Canonical verb
    // `tool:dispatch`; derived op name `tool:command:dispatch` — identical
    // to the hand-rolled Operation this replaces. The scope thunk carries
    // the caller's work-path coordinates (session/execution/tick off
    // `input.context`) onto every dispatch envelope, matching the prior
    // hand-built scope. Default `addressable` exposure makes the verb
    // inbox-reachable: a `tool:dispatch` message (serializable
    // `DispatchInput`, no `signal`) routes here via
    // `BaseHarness.dispatchMessage`. The public `dispatch` method wraps
    // this to stamp provenance from the dispatch door.
    // Registers the `tool:dispatch` command (reached via `commandEffect`
    // in `dispatchFx`, and inbox/wire dispatch-by-name). The return —
    // the Promise facade — is unused; the public `dispatch` derives from
    // the `.fx` twin instead (facade = runHarnessProtocol(twin)).
    this.command<DispatchInput, DispatchResult, unknown>({
      name: "tool:dispatch",
      // Deterministic opId keyed by the model's stable `toolCallId` (or an
      // explicit `input.opId`) — preserves dispatch's idempotency: a repeat
      // dispatch of the same call replays the cached terminal instead of
      // re-executing a side-effecting tool (ADR 51). Matches the opId the
      // pre-command hand-built Operation used.
      opId: (i) => i.opId ?? `tool:dispatch:${i.toolCallId}`,
      scope: (i) =>
        omitUndefined({
          sessionId: i.context.sessionId,
          executionId: i.context.executionId,
          tickId: i.context.tickId,
        }),
      handler: (i) => this.dispatchBody(i),
    });

    // Eager registrations applied synchronously so callers can dispatch
    // immediately after `await harness.ready`.
    if (options.initialTools) {
      for (const reg of options.initialTools) this.registry.add(reg);
    }
  }

  // ──────────────────────── ToolExecutorProtocol ────────────────────────

  register(input: RegisterToolInput): Promise<void> {
    const name = input.registration.declaration.name;
    const op: Operation<RegisterToolInput, void> = {
      opId: input.opId ?? `tool:register:${name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:register",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.registry.add(i.registration);
        }),
      ),
    );
  }

  unregister(input: UnregisterToolInput): Promise<void> {
    const op: Operation<UnregisterToolInput, void> = {
      opId: input.opId ?? `tool:unregister:${input.name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:unregister",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.registry.remove(i.name);
        }),
      ),
    );
  }

  async list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    // Pure read — bypass runOperation so list() doesn't pollute the
    // journal with no-op envelopes. Conformance only requires correct
    // shape; the bus / journal don't care about reads.
    return this.registry.list(filter);
  }

  removeBoundTools(input: RemoveBoundToolsInput): Promise<void> {
    const op: Operation<RemoveBoundToolsInput, void> = {
      opId: input.opId ?? `tool:remove-bound:${input.binding.scope}:${ulid()}`,
      surface: "tool",
      name: "tool:command:remove-bound-tools",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.registry.removeWhere((b) => sameBindingKey(b, i.binding));
        }),
      ),
    );
  }

  /**
   * The composable `replaceReconcilerTools` Effect — the
   * `.fx.replaceReconcilerTools` twin. Returns `runOperation(op, body)`
   * un-run so the loop composes the reconciler-slice swap in one fiber
   * (its span nests under the tick). {@link replaceReconcilerTools} is
   * the facade.
   *
   * `Effect.try` (not `.sync`) — binding validation throws on mismatch;
   * we surface those as a tagged `ToolValidationError` on the `E` channel
   * (catchable, not a fiber-crashing defect). The registry throws a plain
   * `Error`; we wrap it so the twin's channel is typed for composition
   * (`ToolExecutorErrorChannel`). Valid bindings — every real call —
   * never trigger this.
   */
  private replaceReconcilerToolsFx(
    input: ReplaceReconcilerToolsInput,
  ): Effect.Effect<void, ToolExecutorErrorChannel | SubstrateError, never> {
    const op: Operation<ReplaceReconcilerToolsInput, void, ToolExecutorErrorChannel> = {
      opId: input.opId ?? `tool:replace-reconciler:${input.mountId}:${ulid()}`,
      surface: "tool",
      name: "tool:command:replace-reconciler-tools",
      scope: {},
      input,
    };
    return this.runOperation(op, (i) =>
      Effect.try({
        try: () => this.registry.replaceReconcilerSlice(i.mountId, i.registrations),
        catch: (cause): ToolExecutorErrorChannel =>
          new ToolValidationError({
            toolName: `reconciler-slice:${i.mountId}`,
            issues: [{ message: cause instanceof Error ? cause.message : String(cause) }],
            cause,
          }),
      }),
    );
  }

  replaceReconcilerTools(input: ReplaceReconcilerToolsInput): Promise<void> {
    return runHarnessProtocol(this.replaceReconcilerToolsFx(input));
  }

  /**
   * The composable `compileForTick` Effect — the `.fx.compileForTick`
   * twin. A PURE registry read wrapped in `Effect.sync` (no
   * `runOperation`, no journal/bus envelope) so the loop composes it
   * in-fiber (`yield* toolExecutor.fx.compileForTick(...)`) without a
   * `runPromise` root. The facade {@link compileForTick} stays a bare
   * `async` read — no `runHarnessProtocol` spin-up on this hot per-tick
   * path.
   */
  private compileForTickFx(
    filter?: ToolListFilter,
  ): Effect.Effect<readonly ToolDeclaration[], never, never> {
    return Effect.sync(() => this.registry.compileForTick(filter));
  }

  /**
   * Per-tick compile — precedence-resolved tool set. Pure read,
   * bypasses `runOperation` (no journal pollution). Filter is applied
   * BEFORE precedence resolution so a high-precedence registration
   * that fails the filter doesn't shadow a lower-precedence one that
   * passes — matching only competes among rows the filter admits.
   *
   * Bare `async` (NOT `runHarnessProtocol(this.compileForTickFx(...))`) —
   * the type is `PromiseView`-compatible with the twin, but the hot path
   * skips the Effect-runtime spin-up. See {@link compileForTickFx}.
   */
  async compileForTick(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    return this.registry.compileForTick(filter);
  }

  /**
   * Dispatch a tool call through the declared `tool:dispatch` command.
   * The public in-process gate stamps PROVENANCE (ADR 51 §5/§6): the
   * dispatch DOOR (`input.context.via`) maps to the operation's `origin`
   * — a model-driven tool call is stamped `"model"` (the untrusted
   * capability subject), a host/session dispatch `"host"`. Inbox-delivered
   * `tool:dispatch` messages are stamped by their delivering gate instead
   * (see {@link viaToOrigin}).
   */
  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * loop reaches `toolExecutor.fx.dispatch(...)` to compose a tool call
   * into one fiber tree (Stage 3); the plain `dispatch(...)` Promise below
   * is the derived facade. `dispatch` IS a registry command, but the
   * facade maps the door → origin, which a bare `fxProxy` would drop — so
   * the twin hand-authors over `commandEffect`, preserving the door
   * provenance.
   */
  get fx(): ToolExecutorFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      dispatch: (input) => this.dispatchFx(input),
      replaceReconcilerTools: (input) => this.replaceReconcilerToolsFx(input),
      compileForTick: (filter) => this.compileForTickFx(filter),
    };
  }

  /**
   * The composable `dispatch` Effect — the `.fx.dispatch` twin. Resolves
   * the declared `tool:dispatch` command via `commandEffect`, stamping the
   * origin from the dispatch door (`viaToOrigin(context.via)`), un-run.
   * {@link dispatch} is the facade. The command body's declared `unknown`
   * error is narrowed here to the protocol contract (`ToolExecutorError`):
   * dispatch rejects only with that; handler throws become a
   * `DispatchResult`.
   */
  private dispatchFx(
    input: DispatchInput,
  ): Effect.Effect<DispatchResult, ToolExecutorErrorChannel | SubstrateError, never> {
    return this.commandEffect<DispatchInput, DispatchResult, ToolExecutorErrorChannel>(
      "tool:dispatch",
      input,
      { origin: viaToOrigin(input.context.via) },
    );
  }

  dispatch(input: DispatchInput): Promise<DispatchResult> {
    return runHarnessProtocol(this.dispatchFx(input));
  }

  /**
   * Synchronous abort body — the command handler ({@link abort}) wraps
   * this in journaling. Fires the in-flight AbortController IMMEDIATELY
   * so cancellation is not deferred by the command's phase contract. A
   * real `ToolAbortedError` instance (not a plain tagged object) so both
   * the direct and inbox paths reject the dispatch with
   * `instanceof ToolAbortedError`. No-op for unknown ids.
   *
   * The dispatchBody promise sees the abort + rejects with
   * `ToolAbortedError`; cleanup of `inFlight` is left to the dispatch
   * path's `finally`.
   */
  private abortBody(input: AbortInput): void {
    const entry = this.inFlight.get(input.toolCallId);
    if (!entry) return; // no-op for unknown ids
    entry.controller.abort(
      new ToolAbortedError({ toolCallId: input.toolCallId, reason: input.reason }),
    );
  }

  // ──────────────────────── State store (handler ctx) ────────────────────────

  /**
   * Read state previously set by a tool handler via
   * `ctx.setState(key, value)`. Used by the stateful tool render
   * pattern (`<Tool render={() => …}>`).
   */
  getState(key: string): unknown {
    return this.stateStore.get(key);
  }

  /** Snapshot the entire handler state map. */
  snapshotState(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(this.stateStore.entries());
  }

  // ──────────────────────── lifecycle hooks (4a.6) ────────────────────────
  //
  // `use(middleware)` is inherited from BaseHarness — it's the universal
  // primitive. Subclasses don't re-expose it (would duplicate). Typed
  // call sites pass generics:
  //
  //   tools.use<DispatchInput, DispatchResult>((input, next) => ...);

  /**
   * Register a GUARD on dispatch — a decider that runs BEFORE every
   * dispatch's body and admits or rejects it (ADR 83). Returns a
   * `HandlerVerdict` to influence execution:
   *
   *   - `{ kind: "proceed" }` (or void) — continue normally
   *   - `{ kind: "veto", reason? }` — abort dispatch, terminal:vetoed
   *   - `{ kind: "replace", result, reason? }` — short-circuit with
   *     the supplied result, terminal:replaced
   *   - `{ kind: "defer", retryAfter? }` — terminal:deferred (caller
   *     responsibility to retry)
   *
   * Returns `Unsubscribe`. Multiple guards compose by COMPOSE-ORDER (the
   * outermost decides first) — ADR 83 replaced the old order-independent
   * priority-merge (`veto > replace > defer`) with the composed guard seam.
   *
   * The tool-typed name for the universal `BaseHarness.guardEffect(...)`
   * seam. The handler stays Effect-native (in-fiber verdict). Distinct
   * from the `gate` package (loop continuation) — this is op admission:
   * guard : operation :: gate : loop.
   */
  guardDispatch(handler: GuardDecider<DispatchInput, DispatchResult, unknown>): Unsubscribe {
    return this.guardEffect<DispatchInput, DispatchResult>(handler);
  }

  // ──────────────────────── inbox dispatch ────────────────────────

  /**
   * Inbox fallthrough. `abort` is a declared command (`tool:abort`), so
   * `BaseHarness.dispatchMessage` auto-routes it BEFORE reaching here —
   * no hand-rolled switch. The legacy `confirmation-response` message
   * type retired with the ElicitationHarness refactor (confirmation
   * responses arrive on the elicitation harness's address). Every
   * remaining message type is genuinely unknown ⇒ `HandlerError`.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error(`tool inbox: unknown message type "${msg.type}"`),
      }),
    );
  }

  // ──────────────────────── internals ────────────────────────

  /**
   * Effect-shaped body. Runs inside `runOperation`'s FiberRef scope so
   * Effect-typed handlers see the active `RuntimeContext` via
   * `getContext`. Promise / sync handlers bridge out via `Effect.tryPromise`
   * / `Effect.sync` and receive scope through the explicit `ctx` arg
   * the harness builds from the operation input.
   */
  private dispatchBody(input: DispatchInput): Effect.Effect<DispatchResult, unknown, never> {
    return Effect.gen(this, function* () {
      const reg = this.registry.get(input.name);
      if (!reg) {
        return yield* Effect.fail(
          new ToolNotFoundError({ name: input.name, registered: this.registry.names() }),
        );
      }
      if (!reg.declaration.exposure.includes(input.context.via)) {
        return yield* Effect.fail(
          new ToolPermissionError({
            toolName: input.name,
            via: input.context.via,
            reason: `tool "${input.name}" is not exposed via "${input.context.via}"`,
          }),
        );
      }

      // Pre-flight: explicit `task` overrides that contradict the
      // tool's declared `taskSupport` are surfaced as
      // `ToolTaskModeConflictError` before the handler runs. The
      // matrix:
      //
      //   - `"ref"` + supportMode "unsupported" — the handler is not
      //     expected to produce a TaskHandle; there is no ref to
      //     return.
      //   - `"inline"` + supportMode "required" — the contract says
      //     the tool must run as a task across ticks; awaiting it
      //     inline defeats the point.
      //
      // `"auto"` never conflicts at pre-flight; the executor resolves
      // it on the resolved-value side.
      {
        const supportMode = reg.declaration.annotations?.taskSupport ?? "unsupported";
        const requestedTaskMode = input.task ?? "auto";
        if (requestedTaskMode === "ref" && supportMode === "unsupported") {
          return yield* Effect.fail(
            new ToolTaskModeConflictError({
              toolName: input.name,
              requestedTaskMode: "ref",
              supportMode: "unsupported",
            }),
          );
        }
        if (requestedTaskMode === "inline" && supportMode === "required") {
          return yield* Effect.fail(
            new ToolTaskModeConflictError({
              toolName: input.name,
              requestedTaskMode: "inline",
              supportMode: "required",
            }),
          );
        }
      }

      const entry = this.handlerResolver.resolve(reg.handlerRef);
      if (!entry) {
        return yield* Effect.fail(
          new ToolHandlerMissing({ toolName: input.name, handlerRef: reg.handlerRef }),
        );
      }

      // Validate input. Validator may be sync or async — both shapes
      // sit inside Effect.tryPromise (sync resolves immediately).
      const result = yield* Effect.tryPromise({
        try: async () => entry.validator.validate(input.input),
        catch: (cause): { readonly _tag: "ToolValidationError"; readonly cause: unknown } => ({
          _tag: "ToolValidationError",
          cause,
        }),
      });
      if (isValidationFailure(result)) {
        return yield* Effect.fail(
          new ToolValidationError({ toolName: input.name, issues: result.issues }),
        );
      }
      let validated = result.value;

      // Per-dispatch abort plumbing. Effect-typed handlers also see
      // fiber interrupts; Promise/sync handlers see the AbortSignal.
      const controller = new AbortController();
      this.inFlight.set(input.toolCallId, { controller, toolName: input.name });

      const callerSignal = input.signal;
      const onCallerAbort = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

      // ─── Confirmation gate ──────────────────────────────────────────
      // Tools annotated `requiresConfirmation: true` route through the
      // ElicitationHarness. The wire envelope is the standard elicitation
      // shape (session:channel:elicitation, hints.kind ===
      // "tool_confirmation"); the response is validated against
      // TOOL_CONFIRMATION_REPLY_SCHEMA. The harness retires its own
      // `session:channel:tool_confirmation` channel — one substrate
      // primitive, one wire shape.
      if (
        reg.declaration.annotations?.requiresConfirmation === true &&
        !this.alwaysAllowed.has(input.name)
      ) {
        const confirmationTimeoutMs =
          reg.declaration.annotations.confirmationTimeoutMs ??
          input.confirmationTimeoutMs ??
          this.defaultConfirmationTimeoutMs;

        // The signal flows through to the elicitation registry; an
        // inbox abort or caller signal abort settles the pending
        // elicit with `{ outcome: "failed", failure.kind: "aborted" }`.
        const elicit = this.elicitation.elicit(
          {
            message: `Approve tool "${input.name}"?`,
            schema: TOOL_CONFIRMATION_REPLY_SCHEMA,
            hints: { kind: TOOL_CONFIRMATION_KIND },
            metadata: {
              toolUseId: input.toolCallId,
              toolName: input.name,
              arguments: validated as Record<string, unknown>,
            },
          },
          {
            ...omitUndefined({ timeoutMs: confirmationTimeoutMs }),
            signal: controller.signal,
          },
        );

        // `Effect.promise` bridges the elicit() Promise into the
        // surrounding Effect generator. elicit() never throws for
        // form-mode requests; URL-mode would throw but tool
        // confirmation only ever sends form-mode.
        const elicitResult = yield* Effect.promise(() => elicit);

        // Timeout → caller error so the loop sees it via
        // ToolConfirmationTimeoutError (existing contract).
        if (elicitResult.outcome === "failed" && elicitResult.failure.kind === "timeout") {
          return yield* Effect.fail(
            new ToolConfirmationTimeoutError({
              toolName: input.name,
              ms: confirmationTimeoutMs ?? 0,
            }),
          );
        }

        // Approval requires accepted + reply.approved === true. Every
        // other path — declined, cancelled, failed.aborted,
        // failed.schema_violation, or accepted-with-approved-false —
        // is a denial.
        const reply = extractReply(elicitResult);
        const approved = reply?.approved === true;

        if (!approved) {
          callerSignal?.removeEventListener("abort", onCallerAbort);
          this.inFlight.delete(input.toolCallId);
          const denyReason = denialReason(elicitResult, reply);
          const denialResult: DispatchResult = {
            toolCallId: input.toolCallId,
            name: input.name,
            // Denial is a SOFT error (ADR 70): the dispatch completed, the
            // model sees the denial text and can adapt. HARD failures reject.
            isError: true,
            content: [
              {
                type: "text",
                text: denyReason
                  ? `Tool "${input.name}" denied: ${denyReason}`
                  : `Tool "${input.name}" denied by user.`,
              },
            ],
            executedBy: "agentick",
            durationMs: 0,
          };
          return denialResult;
        }

        if (reply!.always === true) this.alwaysAllowed.add(input.name);

        // Re-validate when the host returns modifiedArguments — the
        // user may have edited the call before approving.
        if (reply!.modifiedArguments !== undefined) {
          const revalidated = yield* Effect.tryPromise({
            try: async () => entry.validator.validate(reply!.modifiedArguments),
            catch: (cause): { readonly _tag: "ToolValidationError"; readonly cause: unknown } => ({
              _tag: "ToolValidationError",
              cause,
            }),
          });
          if (isValidationFailure(revalidated)) {
            return yield* Effect.fail(
              new ToolValidationError({ toolName: input.name, issues: revalidated.issues }),
            );
          }
          validated = revalidated.value;
        }
      }

      const timeoutMs =
        input.timeoutMs ?? reg.declaration.annotations?.timeout ?? this.defaultTimeoutMs;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          controller.abort(new ToolTimeoutError({ toolName: input.name, ms: timeoutMs }));
        }, timeoutMs);
      }

      const channelEmits: HandlerChannelSeed[] = [];
      const publisher = this.channelPublisher;
      // Parent opId for channel emits (`ctx.emit`). Read from the ambient
      // RuntimeContext `runOperation` established for THIS command so the
      // causality edge points at the dispatch operation's real opId
      // (command-manufactured ULID) rather than a hand-reconstructed
      // string. `getContext` returns the command's opId here; the
      // `input.opId` / `toolCallId` fallbacks cover direct `dispatchBody`
      // calls made outside a command scope (test fixtures).
      const ambient = yield* getContext;
      const opIdForCausality = ambient.opId ?? input.opId ?? `tool:dispatch:${input.toolCallId}`;
      // Scope stamped on every signal (`ctx.log` / `ctx.progress`) this
      // dispatch emits — the work-path coordinates from the caller's
      // context. Subscribers filter on these (e.g. `{ executionId }`).
      const dispatchScope: EventScope = omitUndefined({
        sessionId: input.context.sessionId,
        executionId: input.context.executionId,
        tickId: input.context.tickId,
      });
      const ctx: ToolHandlerCtx = {
        // ADR 66 — opaque, harness-agnostic extension slots (e.g.
        // `ctx.sandbox`). Spread FIRST so the hardcoded universal fields
        // below always win over any accidental key collision. Typed by
        // `ToolHandlerCtxExtensions` augmentations; values point at live
        // bridges (dispatch-resolved, not render-captured).
        ...this.ctxExtensions,
        toolCallId: input.toolCallId,
        ...omitUndefined({
          sessionId: input.context.sessionId,
          executionId: input.context.executionId,
          tickId: input.context.tickId,
        }),
        signal: controller.signal,
        // Resolved task mode for THIS dispatch (#174). Mirrors
        // `DispatchInput.task` after default → `"auto"`. Handlers
        // with a sync-or-task choice (MCP `supported` tools) read
        // this to decide per-call whether to take the task wire.
        // Pre-flight conflicts (e.g. `"ref"` against `"unsupported"`)
        // were already rejected above, so this value is always
        // valid for the resolved tool's `taskSupport`.
        task: input.task ?? "auto",
        // ADR 43 — transport discriminator. In-process dispatch from
        // the tool-executor always uses `"in-process"`; MCP-server
        // projection populates `"mcp"` instead.
        transport: "in-process" as const,
        // Substrate primitives surfaced for ad-hoc handler use
        // (`ctx.elicitation.elicit(...)`, `ctx.tasks.submit(...)`).
        // Always present in production; the optional spec field
        // covers test fixtures that omit them.
        elicitation: this.elicitation,
        // ADR 43 — `ctx.elicit` is the sugar wrapper over the raw
        // protocol. Same `Elicit` interface as the MCP-server side
        // (built by `buildMcpElicit`), so tool handlers calling
        // `ctx.elicit.text(...)` work identically across transports.
        elicit: buildSessionElicit({ harness: this.elicitation }),
        ...omitUndefined({ tasks: this.tasks }),
        // ADR 62 — the session's read-projection seam. Handlers resolve
        // readable content by URI (`ctx.resource.read(uri)`); the
        // AppHarness wired the single per-session ResourcesHarness here.
        ...omitUndefined({ resource: this.resources }),
        setState: (key: string, value: unknown): void => {
          this.stateStore.set(key, value);
        },
        emit: (seed: HandlerChannelSeed): void => {
          // Always retain seeds for observability tests / inspection;
          // route to the publisher when one is wired.
          channelEmits.push(seed);
          if (publisher) {
            const channel = seed.name.replace(/^session:channel:/, "");
            Effect.runFork(
              publisher.publish({
                channel,
                payload: seed.payload,
                ...omitUndefined({ metadata: seed.metadata }),
                parentOpId: opIdForCausality,
                scope: {
                  ...omitUndefined({
                    sessionId: input.context.sessionId,
                    executionId: input.context.executionId,
                    tickId: input.context.tickId,
                  }),
                },
              }),
            );
          }
        },
        // ADR 64 — universal `log` / `progress` signals. Each emits ONE
        // discrete bus event (`tool:signal:log` / `tool:signal:progress`,
        // phase `terminal`, bus-only) scoped to this dispatch. Projections
        // subscribe (MCP server → notifications/message + progress; the
        // agentick client → subscribe / progress stream). Fire-and-forget:
        // launched with `Effect.runFork`, never awaited, never throws into
        // the handler.
        log: (level, data, logger): void => {
          void Effect.runFork(this.emitLog(dispatchScope, level, data, logger));
        },
        progress: (token, p): void => {
          void Effect.runFork(
            this.emitProgress(dispatchScope, {
              token,
              progress: p.progress,
              ...(p.total !== undefined ? { total: p.total } : {}),
              ...(p.message !== undefined ? { message: p.message } : {}),
            }),
          );
        },
      };

      const useDeps: Readonly<Record<string, unknown>> = {
        ...(reg.useDeps ?? {}),
        ...(input.context.use ?? {}),
      };

      const started = Date.now();

      // Compose body that branches on handler shape. Resolves to the
      // ADR 70 `NormalizedToolResult` (content + optional structuredContent
      // / isError / metadata); the TaskHandle branches produce content-only.
      const invokeHandler = Effect.suspend(
        (): Effect.Effect<NormalizedToolResult, unknown, never> => {
          if (controller.signal.aborted) {
            return Effect.fail(
              controller.signal.reason ?? new ToolAbortedError({ toolCallId: input.toolCallId }),
            );
          }
          const handlerResult = entry.handler(validated, { ctx, use: useDeps });

          // Abort watcher — fails the race when the dispatch
          // controller fires (caller abort or timeout). Shared between
          // the Effect and Promise handler shapes so both paths get
          // identical abort semantics.
          const abortEff: Effect.Effect<never, unknown, never> = Effect.async<
            never,
            unknown,
            never
          >((resume) => {
            if (controller.signal.aborted) {
              resume(
                Effect.fail(
                  controller.signal.reason ??
                    new ToolAbortedError({ toolCallId: input.toolCallId }),
                ),
              );
              return;
            }
            const onAbort = () => {
              resume(
                Effect.fail(
                  controller.signal.reason ??
                    new ToolAbortedError({ toolCallId: input.toolCallId }),
                ),
              );
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            return Effect.sync(() => controller.signal.removeEventListener("abort", onAbort));
          });

          // Branch by handler shape. Effect and Promise paths
          // resolve to a value that MAY be a `TaskHandle`; we
          // post-process for the TaskHandle branch below. The sync
          // path checks isTaskHandle directly.
          //
          // For async handlers (the common case) — `handlerResult`
          // is a `Promise<TaskHandle | ContentBlock[]>`. We await
          // the promise first via the existing race-with-abort, THEN
          // dispatch to the TaskHandle branch if the resolved value
          // is a handle.
          //
          // Pattern A vs Pattern B is decided by combining the
          // tool's declared `taskSupport` with the caller's `task`
          // option (default `"auto"`):
          //
          //   - explicit `"ref"`  → Pattern B (returns
          //     `session_task_ref`). Pre-flight rejects when
          //     supportMode === "unsupported".
          //   - explicit `"inline"` → Pattern A (await handle). Pre-
          //     flight rejects when supportMode === "required".
          //   - `"auto"` + `via: "model"` + supportMode "required"
          //     → Pattern B (the model-tick path keeps required
          //     tools async across ticks).
          //   - every other `"auto"` combination → Pattern A
          //     (host-side default; Phase C #174 refines the
          //     "supported" branch with capability negotiation).
          const supportMode = reg.declaration.annotations?.taskSupport ?? "unsupported";
          const requestedTaskMode = input.task ?? "auto";

          const dispatchOnResolved = (
            resolved: unknown,
          ): Effect.Effect<NormalizedToolResult, unknown, never> => {
            if (!isTaskHandle(resolved)) {
              // Non-TaskHandle: the ADR 70 result currency (string / array
              // / envelope) → one internal result. Bare-array parity is
              // exact (no structuredContent/isError set).
              return Effect.succeed(normalizeToolResult(resolved as ToolResultInput));
            }

            const usePatternB =
              requestedTaskMode === "ref" ||
              (requestedTaskMode === "auto" &&
                input.context.via === "model" &&
                supportMode === "required");

            if (usePatternB) {
              // Wire the dispatch's abort signal to the task's
              // cancel — caller abort propagates to the task.
              if (controller.signal.aborted) {
                void resolved.cancel("dispatch_aborted");
              } else {
                controller.signal.addEventListener(
                  "abort",
                  () => {
                    void resolved.cancel("dispatch_aborted");
                  },
                  { once: true },
                );
              }
              return Effect.succeed({ content: serializeTaskRef(resolved) });
            }

            // Pattern A — await the handle's result. Abort the task
            // on dispatch abort so we don't orphan in-flight work.
            const cancelOnAbort = (): void => {
              void resolved.cancel("dispatch_aborted");
            };
            if (controller.signal.aborted) {
              cancelOnAbort();
            } else {
              controller.signal.addEventListener("abort", cancelOnAbort, { once: true });
            }
            const taskAwaitEff = Effect.tryPromise({
              try: () => resolved.result as Promise<readonly ContentBlock[]>,
              catch: (cause: unknown) => cause,
            });
            // A task resolves with content (not an envelope) — wrap.
            return Effect.map(Effect.raceFirst(taskAwaitEff, abortEff), (content) => ({ content }));
          };

          if (isTaskHandle(handlerResult)) {
            // Sync return of a TaskHandle (non-async handler).
            return dispatchOnResolved(handlerResult);
          }

          if (isEffect(handlerResult)) {
            // Effect-typed handler yields IN the parent fiber so it
            // inherits the `RuntimeContextRef` FiberRef set by
            // `runOperation`. `Effect.raceFirst` (not `race`) —
            // settles on the first to either succeed OR fail.
            // `flatMap` post-processes the resolved value for the
            // TaskHandle branch.
            return Effect.flatMap(
              Effect.raceFirst(handlerResult as Effect.Effect<unknown, unknown, never>, abortEff),
              dispatchOnResolved,
            );
          }

          if (isPromiseLike(handlerResult)) {
            // Lift the Promise to Effect, race against the abort
            // watcher, then dispatch the resolved value (which may
            // be a TaskHandle from an async handler that
            // `return ctx.tasks.submit(...)`-ed).
            const handlerEff = Effect.tryPromise({
              try: () => handlerResult as PromiseLike<unknown>,
              catch: (cause: unknown) => cause,
            });
            return Effect.flatMap(Effect.raceFirst(handlerEff, abortEff), dispatchOnResolved);
          }

          // Sync, non-TaskHandle return — normalize. TS can't narrow
          // across the disjoint branches above, so cast explicitly: at
          // this point handlerResult is a sync `ToolResultInput`
          // (Effect/Promise/TaskHandle cases already returned).
          return Effect.succeed(normalizeToolResult(handlerResult as ToolResultInput));
        },
      );

      const exit = yield* Effect.exit(invokeHandler);

      // Cleanup runs unconditionally.
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.inFlight.delete(input.toolCallId);
      void channelEmits;

      if (Exit.isSuccess(exit)) {
        const normalized = exit.value;

        // ADR 70 — validate `structuredContent` against `outputSchema`
        // when both are present, mirroring the inputSchema path above
        // (Standard-Schema via `fromStandardSchema`). A failure is a
        // typed HARD dispatch error (reject), same shape as input
        // validation. No outputSchema OR no structuredContent → skip
        // (back-compat: existing tools unaffected).
        const outputSchema = reg.declaration.outputSchema;
        if (outputSchema !== undefined && normalized.structuredContent !== undefined) {
          const outValidator = fromStandardSchema(outputSchema);
          const outResult = yield* Effect.tryPromise({
            try: async () => outValidator.validate(normalized.structuredContent),
            catch: (cause): { readonly _tag: "ToolValidationError"; readonly cause: unknown } => ({
              _tag: "ToolValidationError",
              cause,
            }),
          });
          if (isValidationFailure(outResult)) {
            return yield* Effect.fail(
              new ToolValidationError({
                toolName: input.name,
                issues: outResult.issues,
                cause: "structuredContent failed outputSchema validation",
              }),
            );
          }
        }

        const dispatchResult: DispatchResult = {
          toolCallId: input.toolCallId,
          name: input.name,
          content: normalized.content,
          ...(normalized.isError !== undefined ? { isError: normalized.isError } : {}),
          ...(normalized.structuredContent !== undefined
            ? { structuredContent: normalized.structuredContent }
            : {}),
          ...(normalized.metadata !== undefined ? { metadata: normalized.metadata } : {}),
          executedBy: "agentick",
          durationMs: Date.now() - started,
        };
        return dispatchResult;
      }

      // Failure: distinguish abort vs handler error.
      const failure = Cause.failureOption(exit.cause);
      const rawErr = Option.isSome(failure) ? failure.value : undefined;
      const abortReason = controller.signal.aborted
        ? (controller.signal.reason ?? rawErr)
        : undefined;
      if (abortReason !== undefined) {
        return yield* Effect.fail(
          isTaggedAbort(abortReason)
            ? abortReason
            : new ToolAbortedError({
                toolCallId: input.toolCallId,
                reason: typeof abortReason === "string" ? abortReason : undefined,
              }),
        );
      }
      if (rawErr !== undefined && isTaggedToolError(rawErr)) {
        return yield* Effect.fail(rawErr);
      }
      return yield* Effect.fail(
        new ToolHandlerError({ toolName: input.name, cause: rawErr ?? exit.cause }),
      );
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidationFailure(
  r: ValidatorResult,
): r is { value?: undefined; issues: ValidatorResult extends { issues: infer I } ? I : never } {
  return Array.isArray((r as { issues?: unknown }).issues);
}

function isTaggedAbort(value: unknown): value is { readonly _tag: string } {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { _tag?: unknown })._tag;
  return tag === "ToolAbortedError" || tag === "ToolTimeoutError";
}

function isEffect(value: unknown): value is Effect.Effect<readonly ContentBlock[], unknown, never> {
  return typeof value === "object" && value !== null && Effect.EffectTypeId in value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Build the first-class {@link TaskRefBlock} the model receives in
 * lieu of the eventual result when a tool resolves to a task handle
 * (Pattern B). The block-type discriminator (`type: "task_ref"`)
 * lives on the block itself — consumers pattern-match via `block.type`
 * rather than JSON-parsing a text body for a magic `_kind` field.
 *
 * The framework-side projection to text-JSON (drop-in compatibility
 * with the prior `_kind: "session_task_ref"` JSON shape) happens at
 * the executor boundary in `messagePartFromBlock`. That keeps the
 * block-type first-class WITHIN the framework while preserving the
 * exact wire shape adopters parse today.
 */
function serializeTaskRef(handle: TaskHandle<readonly ContentBlock[]>): readonly ContentBlock[] {
  const info = handle.info();
  return [
    {
      type: "task_ref",
      taskId: info.taskId,
      status: info.status,
      ...omitUndefined({ statusMessage: info.statusMessage }),
      ...(info.ttl !== null && info.ttl !== undefined ? { ttl: info.ttl } : {}),
      ...omitUndefined({ pollInterval: info.pollInterval }),
    } satisfies ContentBlock,
  ];
}

function isTaggedToolError(value: unknown): value is { readonly _tag: string } {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { _tag?: unknown })._tag;
  return (
    tag === "ToolNotFoundError" ||
    tag === "ToolPermissionError" ||
    tag === "ToolHandlerMissing" ||
    tag === "ToolValidationError" ||
    tag === "ToolAbortedError" ||
    tag === "ToolTimeoutError" ||
    tag === "ToolHandlerError"
  );
}

/**
 * Pull the validated reply out of an `accepted` elicitation result.
 * Returns `undefined` for any other outcome.
 */
function extractReply(
  result:
    | { readonly outcome: "accepted"; readonly value: ToolConfirmationReply }
    | { readonly outcome: "declined"; readonly reason?: string }
    | { readonly outcome: "cancelled"; readonly reason?: string }
    | {
        readonly outcome: "failed";
        readonly failure: { readonly kind: string; readonly reason?: string };
      },
): ToolConfirmationReply | undefined {
  return result.outcome === "accepted" ? result.value : undefined;
}

/**
 * Compose a denial reason from the available signals: the user's
 * `accepted+approved:false` reason, declined/cancelled reason, or a
 * failure-kind label.
 */
function denialReason(
  result:
    | { readonly outcome: "accepted"; readonly value: ToolConfirmationReply }
    | { readonly outcome: "declined"; readonly reason?: string }
    | { readonly outcome: "cancelled"; readonly reason?: string }
    | {
        readonly outcome: "failed";
        readonly failure: { readonly kind: string; readonly reason?: string };
      },
  reply: ToolConfirmationReply | undefined,
): string | undefined {
  if (reply !== undefined) return reply.reason;
  if (result.outcome === "declined" || result.outcome === "cancelled") return result.reason;
  if (result.outcome === "failed") return result.failure.reason ?? result.failure.kind;
  return undefined;
}

// Silence unused-import linting until 4a.6+ uses ToolRegistration alias.
void (undefined as unknown as ToolRegistration);

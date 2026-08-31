/**
 * `ToolExecutorHarness` — reference implementation of
 * `ToolExecutorProtocol`.
 *
 * Extends `BaseHarness<"tool">` from `@agentick/runtime`. Owns:
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

import { omitUndefined } from "@agentick/utils";
import { buildSessionElicit } from "@agentick/elicitation";

import { Cause, Effect, Exit, Option, type Runtime } from "effect";
import {
  deriveContext,
  getContext,
  runHarnessProtocol,
  runHarnessProtocolOn,
  generateId,
} from "@agentick/runtime";
import { BaseHarness, type RequestError, type TelemetryRuntime } from "@agentick/runtime";
import type {
  AbortInput,
  ChannelPublisher,
  ChannelSnapshotProvider,
  ContentBlock,
  DispatchContext,
  Derived,
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
  ProgressToken,
  ProgressUpdate,
  RegisterToolInput,
  RemoveBoundToolsInput,
  RespondToToolCallInput,
  Resources,
  ReplaceCompilerToolsInput,
  SubstrateError,
  TaskHandle,
  TasksHarnessProtocol,
  ToolAnnotations,
  ToolConfirmationPolicy,
  ToolConfirmationResolution,
  ToolDeclaration,
  ToolExecutorErrorChannel,
  ToolExecutorFx,
  ToolExecutorProtocol,
  ToolListFilter,
  ToolPresentation,
  ToolRegistration,
  ToolResultInput,
  ToolsHandle,
  UnregisterToolInput,
} from "@agentick/spec";
import { createProgress, normalizeToolResult, TOOL_NARRATION_FIELD } from "@agentick/spec";
import { viaToOrigin } from "./provenance.js";
import { createToolsHandle } from "./tools-handle.js";
import {
  HandlerError,
  isTaskHandle,
  ToolAbortedError,
  ToolCallTimeoutError,
  ToolConfirmationTimeoutError,
  ToolHandlerError,
  ToolHandlerMissing,
  ToolNotFoundError,
  ToolPermissionError,
  ToolTaskModeConflictError,
  ToolTimeoutError,
  ToolValidationError,
} from "@agentick/spec";

import {
  TOOL_CONFIRMATION_KIND,
  TOOL_CONFIRMATION_REPLY_SCHEMA,
  type ToolConfirmationReply,
} from "./confirmation-schema.js";
import {
  TOOL_CALL_CHANNEL,
  TOOL_CLIENT_CALL_COMMAND,
  type ToolCallRequestPayload,
  type ToolCallSnapshotFrame,
} from "./tool-call-schema.js";
import { InMemoryToolRegistry, sameBindingKey } from "./registry.js";
import { fromStandardSchema } from "./validator.js";
import type {
  HandlerEntry,
  HandlerResolver,
  HandlerChannelSeed,
  ToolExecutorHarnessOptions,
  ToolHandlerCtx,
  Validator,
  ValidatorResult,
} from "./types.js";

// ADR 80 — contribute this harness's exposed `tool:dispatch` verb to the
// command registry, so `CommandHooks` gains typed `onBeforeToolDispatch` /
// `onAfterToolDispatch` participants (before ← input, after ← the dispatch
// content). One line per verb; both hooks fall out via the mapped type.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    // `output` is the richer `DispatchResult` the command body actually returns
    // (`this.command<DispatchInput, DispatchResult>` below) — NOT the bare
    // `ContentBlock[]`. This makes `onAfterToolDispatch` transform-SOUND: an
    // after-hook sees and may return a `DispatchResult`, so it can't silently
    // strip `isError`/metadata off `session.tools.dispatch()`.
    "tool:dispatch": { input: DispatchInput; output: DispatchResult };
    // The remaining tool verbs (ADR 80/83). Each routes through `runOperation`
    // (`tool:abort` is a declared command; `register` / `unregister` /
    // `remove-bound-tools` / `replace-compiler-tools` build hand-rolled ops),
    // so typing them mints `onBefore/After<Verb>` on `CommandHooks`. Registry
    // mutations resolve to `void` except `remove-bound-tools` (the removed
    // count); generics are the declaration sites'.
    "tool:abort": { input: AbortInput; output: void };
    "tool:register": { input: RegisterToolInput; output: void };
    "tool:unregister": { input: UnregisterToolInput; output: void };
    // Output is the COUNT of registrations removed (bulk sweep or the
    // `name`-narrowed targeted remove) — the honest existence signal.
    "tool:remove-bound-tools": { input: RemoveBoundToolsInput; output: number };
    "tool:replace-compiler-tools": { input: ReplaceCompilerToolsInput; output: void };
  }
}

// The emitted op-name for the `tool:dispatch` command — stamped as `op` on
// every progress frame a handler's `ctx.progress` produces.
// TODO(wire-constants): belongs on the client-visible surface once tool has one
// (cf. `TIMELINE_COMPACT_EVENT_NAME` in `@agentick/spec`).
const TOOL_DISPATCH_EVENT_NAME = "tool:command:dispatch";

interface InFlightEntry {
  readonly controller: AbortController;
  readonly toolName: string;
}

export class ToolExecutorHarness
  extends BaseHarness<"tool">
  implements ToolExecutorProtocol, ChannelSnapshotProvider
{
  private readonly registry = new InMemoryToolRegistry();
  private readonly handlerResolver: HandlerResolver;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly stateStore = new Map<string, unknown>();
  private readonly defaultTimeoutMs?: number;
  private readonly defaultConfirmationTimeoutMs?: number;
  private readonly confirmationPolicy?: ToolConfirmationPolicy;
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

  /**
   * The curated host handle — `session.tools` (three-audiences-plan §F). SYNC
   * View reads over this harness's registry, the host-door
   * `dispatch(name, input, opts?)` ({@link hostDispatch} — `via: "dispatch"`),
   * and the family topology-subscription pair (over the registry's
   * change-notification). Built once here; the session getter forwards it.
   */
  readonly tools: ToolsHandle;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ToolExecutorHarnessOptions,
  ) {
    super("tool", scopeId, journal, bus, inbox, {
      // This harness's `scopeId` IS its session id (every caller constructs it that
      // way), so it declares its own owning scope rather than making each caller
      // remember to. Declared HERE and not stamped per-op: if a future caller ever
      // passes a composed key, the `HookBridges` scope conformance fires instead of
      // the projection silently going dead.
      parentScope: { sessionId: scopeId },
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
      // ADR 64/78 — the resolved telemetry provider + ambient labels are now
      // BaseHarness slots (they light `ctx.metrics` on the interceptor ctx too,
      // not just the tool-handler ctx). One source of truth; the dispatch path
      // reads them back via the inherited `this.telemetryProvider` /
      // `this.defaultMetricLabels`.
      ...omitUndefined({ telemetryProvider: options.telemetryProvider }),
      ...omitUndefined({ defaultMetricLabels: options.defaultMetricLabels }),
    });
    this.handlerResolver = options.handlerResolver;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.defaultConfirmationTimeoutMs = options.defaultConfirmationTimeoutMs;
    this.confirmationPolicy = options.confirmationPolicy;
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
      // Owning session comes from `parentScope` (BaseHarness) — never stamped here.
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

    // `session.tools` (three-audiences-plan §F). Reads live off the registry
    // (sync View), dispatches through the host door, and subscribes to registry
    // topology changes. Built last so it closes over a fully-initialized `this`.
    this.tools = createToolsHandle({
      compileSync: (filter) => this.registry.compileForTick(filter),
      getSync: (name) => this.registry.get(name),
      dispatch: (name, input, opts) => this.hostDispatch(name, input, opts),
      subscribe: (listener) => this.registry.subscribe(listener),
    });
  }

  /**
   * The host-door dispatch behind `session.tools.dispatch` (the sole home of the
   * former `session.dispatch` body). Stamps `via: "dispatch"` provenance (or the
   * caller's `opts.via` claim — see `DispatchOptions.via`) and a generated
   * `host:` toolCallId, so a host invocation journals identically to the
   * pre-handle path. Pattern A by default (awaits a returned `TaskHandle`);
   * opt into Pattern B with `{ task: "ref" }`.
   */
  /**
   * A {@link ToolsHandle} bound to ONE dispatch, so tools it starts inherit
   * that dispatch's context. The harness-level `this.tools` stays context-free
   * for host callers outside any crossing.
   */
  private toolsFor(caller: DispatchContext, runtime: Runtime.Runtime<never>): ToolsHandle {
    return createToolsHandle({
      compileSync: (filter) => this.registry.compileForTick(filter),
      getSync: (name) => this.registry.get(name),
      // Run on the CALLER'S runtime, the `buildSessionElicit` precedent. A tool
      // handler is a Promise, so by the time it calls this the ambient
      // operation is gone — and a dispatch started without one is a root op
      // with no principal, no execution, no parent span. Composing on the
      // captured runtime puts it back inside the calling dispatch, where it
      // belongs: a child operation that INHERITS rather than one handed a copy.
      dispatch: async (name, input, opts) => {
        const result = await runHarnessProtocolOn(
          runtime,
          this.dispatchFx({
            toolCallId: `host:${generateId()}`,
            name,
            input,
            // The same crossing, a possibly different door.
            context: { ...caller, via: opts?.via ?? caller.via },
            ...(opts?.task !== undefined ? { task: opts.task } : {}),
          }),
        );
        return opts?.envelope ? result : result.content;
      },
      subscribe: (listener) => this.registry.subscribe(listener),
    });
  }

  private async hostDispatch(
    name: string,
    input: unknown,
    opts?: import("@agentick/spec").DispatchOptions,
  ): Promise<readonly ContentBlock[] | DispatchResult> {
    const result = await this.dispatch({
      toolCallId: `host:${generateId()}`,
      name,
      input,
      // NOT AN EVENT SCOPE — the call's data context. `scopeId` IS the session id here.
      // The harness's own public door: a host call with no crossing to inherit.
      // A dispatch STARTED BY A TOOL goes through `toolsFor` instead.
      context: { via: opts?.via ?? "dispatch", sessionId: this.scopeId },
      ...(opts?.task !== undefined ? { task: opts.task } : {}),
    });
    return opts?.envelope ? result : result.content;
  }

  /**
   * Adds `<ns>.tool.name` (the dispatched tool) to the base identity ids on
   * the `tool:command:dispatch` span. Identity is input-derived and free, so
   * it rides the always-on `spanAttributes` seam rather than the switch-gated
   * enrichment (ADR 78).
   */
  protected override spanAttributes(
    op: Operation<unknown, unknown, unknown>,
  ): Readonly<Record<string, unknown>> {
    const base = super.spanAttributes(op);
    if (op.name !== "tool:command:dispatch") return base;
    const name = (op.input as { name?: unknown } | undefined)?.name;
    return typeof name === "string"
      ? { ...base, [`${this.telemetryNamespace}.tool.name`]: name }
      : base;
  }

  // ──────────────────────── ToolExecutorProtocol ────────────────────────

  register(input: RegisterToolInput): Promise<void> {
    const name = input.registration.declaration.name;
    const op: Operation<RegisterToolInput, void> = {
      opId: input.opId ?? `tool:register:${name}:${generateId()}`,
      surface: "tool",
      name: "tool:command:register",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.registry.add(i.registration, i.replace === true);
        }),
      ),
    );
  }

  unregister(input: UnregisterToolInput): Promise<void> {
    const op: Operation<UnregisterToolInput, void> = {
      opId: input.opId ?? `tool:unregister:${input.name}:${generateId()}`,
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

  /**
   * Land a CLIENT's relayed tool-call result, resolving the pending
   * `this.request(TOOL_CALL_CHANNEL, …)` a client-handled dispatch is
   * suspended on (the client-tool twin of `elicitation.respond`).
   *
   * Byte-for-byte the same inbox route `ElicitationHarness.respond` uses: send
   * a `request-response` envelope to THIS harness's own address, keyed by the
   * dispatch's `correlationId`. `BaseHarness.dispatchMessage` auto-intercepts
   * it BEFORE `handleMessage` and calls `requests.resolve(correlationId,
   * result)`, unblocking the suspended `respEffect` in `dispatchBody` — no new
   * suspend/resume machinery. First-write-wins on the registry, so a duplicate
   * or unknown `correlationId` is a silent no-op. A reply arriving after the
   * inbox subscription is gone (`AddressNotFound`) is swallowed to keep the
   * idempotence contract.
   */
  async respondToToolCall(input: RespondToToolCallInput): Promise<void> {
    const send = this.inbox.send(this.address, {
      type: "request-response",
      correlationId: input.correlationId,
      payload: { correlationId: input.correlationId, response: input.result },
    });
    await Effect.runPromise(
      send.pipe(
        Effect.catchAll((err) => {
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

  async list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    // Pure read — bypass runOperation so list() doesn't pollute the
    // journal with no-op envelopes. Conformance only requires correct
    // shape; the bus / journal don't care about reads.
    return this.registry.list(filter);
  }

  removeBoundTools(input: RemoveBoundToolsInput): Promise<number> {
    const op: Operation<RemoveBoundToolsInput, number> = {
      opId: input.opId ?? `tool:remove-bound:${input.binding.scope}:${generateId()}`,
      surface: "tool",
      name: "tool:command:remove-bound-tools",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() =>
          // Bulk binding sweep — clears a whole slice at lifecycle close.
          this.registry.removeWhere((b) => sameBindingKey(b, i.binding)),
        ),
      ),
    );
  }

  /**
   * The composable `replaceCompilerTools` Effect — the
   * `.fx.replaceCompilerTools` twin. Returns `runOperation(op, body)`
   * un-run so the loop composes the compiler-slice swap in one fiber
   * (its span nests under the tick). {@link replaceCompilerTools} is
   * the facade.
   *
   * `Effect.try` (not `.sync`) — binding validation throws on mismatch;
   * we surface those as a tagged `ToolValidationError` on the `E` channel
   * (catchable, not a fiber-crashing defect). The registry throws a plain
   * `Error`; we wrap it so the twin's channel is typed for composition
   * (`ToolExecutorErrorChannel`). Valid bindings — every real call —
   * never trigger this.
   */
  private replaceCompilerToolsFx(
    input: ReplaceCompilerToolsInput,
  ): Effect.Effect<void, ToolExecutorErrorChannel | SubstrateError, never> {
    const op: Operation<ReplaceCompilerToolsInput, void, ToolExecutorErrorChannel> = {
      opId: input.opId ?? `tool:replace-compiler:${input.mountId}:${generateId()}`,
      surface: "tool",
      name: "tool:command:replace-compiler-tools",
      scope: {},
      input,
    };
    return this.runOperation(op, (i) =>
      Effect.try({
        try: () => this.registry.replaceCompilerSlice(i.mountId, i.registrations),
        catch: (cause): ToolExecutorErrorChannel =>
          new ToolValidationError({
            toolName: `compiler-slice:${i.mountId}`,
            issues: [{ message: cause instanceof Error ? cause.message : String(cause) }],
            cause,
          }),
      }),
    );
  }

  replaceCompilerTools(input: ReplaceCompilerToolsInput): Promise<void> {
    return runHarnessProtocol(this.replaceCompilerToolsFx(input));
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
      ...super.fx,
      dispatch: (input) => this.dispatchFx(input),
      replaceCompilerTools: (input) => this.replaceCompilerToolsFx(input),
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

  // ──────────── channel snapshot (§6.1 — pending client-call enumeration) ────────────

  /**
   * The channel this harness snapshots — {@link ChannelSnapshotProvider}. The
   * session scans its bridges for this and, on `sub/subscribe`, prepends
   * {@link channelSnapshotPayload} as the opening frame a fresh
   * `session:channel:tool_call` subscriber receives before any live delta.
   */
  readonly snapshotChannel = TOOL_CALL_CHANNEL;

  /**
   * {@link ChannelSnapshotProvider} — every client-handled tool call currently
   * awaiting a response as the channel's opening frame (§6.1, the live-only
   * defect fix). Projects `BaseHarness.pendingRequests(TOOL_CALL_CHANNEL)` —
   * the suspended `requiresResponse` relays the registry already holds — into a
   * discriminated `kind: "snapshot"` frame. Fire-and-forget notifies register
   * no `request()`, so they are (correctly) absent — there is nothing pending
   * to enumerate. An observation: reads pending state, publishes nothing.
   */
  channelSnapshotPayload(): ToolCallSnapshotFrame {
    return {
      kind: "snapshot",
      requests: this.pendingRequests(TOOL_CALL_CHANNEL).map((p) => ({
        correlationId: p.correlationId,
        replyTo: p.replyTo,
        payload: p.payload,
      })),
    };
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
          new ToolNotFoundError({ toolName: input.name, registered: this.registry.names() }),
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

      // ─── Handler discriminator (client-handled vs server) ───────────
      // `handlerRef` ABSENT (undefined) → CLIENT-HANDLED tool: no server
      // handler exists; dispatch relays the call to the client (see the
      // client-tool branch after the confirmation gate). `handlerRef`
      // PRESENT but the resolver returns undefined stays a
      // `ToolHandlerMissing` bug. `createTool` synthesizes a handlerRef
      // for server tools, so absence only arises for handler-less /
      // wire-registered declarations.
      const isClientHandled = reg.handlerRef === undefined;
      let entry: HandlerEntry | undefined;
      let validator: Validator;
      if (reg.handlerRef === undefined) {
        // No resolver entry — validate against the declaration's own
        // schema (client tools are still input-validated at the gate).
        validator = fromStandardSchema(reg.declaration.inputSchema);
      } else {
        entry = this.handlerResolver.resolve(reg.handlerRef);
        if (!entry) {
          return yield* Effect.fail(
            new ToolHandlerMissing({ toolName: input.name, handlerRef: reg.handlerRef }),
          );
        }
        validator = entry.validator;
      }

      // ─── Model self-narration strip (Pass B) ────────────────────────
      // The model MAY include the reserved `_summary` narration field —
      // the projector injects it into every model-facing tool schema so
      // the model can say what a call is doing. It is PRESENTATION, not an
      // argument: strip it from the raw input BEFORE validation so the
      // author's schema sees only real fields, and so it NEVER reaches the
      // handler or the persisted `tool_result`. Shallow copy — the
      // caller's object is never mutated. Only the model door carries it;
      // host `dispatch` inputs pass through untouched.
      let rawInput = input.input;
      let modelNarration: string | undefined;
      if (
        input.context.via === "model" &&
        rawInput !== null &&
        typeof rawInput === "object" &&
        Object.prototype.hasOwnProperty.call(rawInput, TOOL_NARRATION_FIELD)
      ) {
        const { [TOOL_NARRATION_FIELD]: narrationValue, ...rest } = rawInput as Record<
          string,
          unknown
        >;
        rawInput = rest;
        modelNarration =
          typeof narrationValue === "string" && narrationValue.length > 0
            ? narrationValue
            : undefined;
      }

      // Validate input. Validator may be sync or async — both shapes
      // sit inside Effect.tryPromise (sync resolves immediately).
      const result = yield* Effect.tryPromise({
        try: async () => validator.validate(rawInput),
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

      const started = Date.now();

      // ─── Handler ctx ────────────────────────────────────────────────
      // Built BEFORE the confirmation gate so an async
      // `requiresConfirmation` predicate receives this exact `ctx`; the
      // (server) handler consumes it below. Client-handled dispatch never
      // invokes a handler, but the ctx is cheap and the predicate path is
      // shared.
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
        connectionId: input.context.connectionId,
        clientId: input.context.clientId,
      });
      // Capture the operation runtime IN-FIBER (inside the dispatch op body,
      // so it carries the op span + the ambient RuntimeContext.opId). Shared
      // by the Observability facet's `trace` (child spans nest under the op
      // span, ADR-77), the Ops facet's `run`/`runner` (ad-hoc ops parent +
      // auto-link under this dispatch), and `ctx.elicit`, whose operation runs
      // ON this runtime so it inherits the dispatch's executionId / tickId
      // instead of orphaning as a root. One capture, three consumers.
      const capturedRuntime = yield* Effect.runtime<never>();
      // Observability facet (ADR 64/78). `log` keeps its existing scope-bound
      // bus-emit behavior (fire-and-forget); `trace`/`metrics` come from the
      // telemetry provider when one is wired, else from the shared off-path
      // singletons (zero per-op allocation). Default metric labels are strictly
      // low-cardinality (tool name + op suffix); the high-cardinality work-path
      // ids ride the span + log, never a label.
      const telemetry: TelemetryRuntime | undefined =
        this.telemetryProvider !== undefined
          ? {
              runtime: capturedRuntime,
              ...omitUndefined({ meter: this.telemetryProvider.meter }),
            }
          : undefined;
      // The branded ctx spine (ADR 91). `deriveContext` copies the ambient
      // trunk (so the dispatch ctx carries the CROSSING's identity —
      // sessionId/opId/principal — not fabricated ones) and attaches the
      // Observability + Ops facets. It is the ONE facet constructor: the raw
      // `deriveObservability` / `deriveOps` derivers are no longer called here
      // (grep gate). `log` keeps its scope-bound bus-emit; `trace`/`metrics`
      // come from the telemetry provider when wired, else the off-path
      // singletons. App-identity labels seed UNDER the per-dispatch defaults so
      // `tool` / `op` always win (ADR 78).
      // ADR 91 §Phase-2 brand totalization — mint the WHOLE dispatch ctx in
      // ONE `deriveContext` call: the facets (2nd arg) attach as lazy getters,
      // and every boundary field (3rd `extras` arg) composes IN as branded
      // descriptors. No post-derivation spread (which would erase the brand
      // AND eagerly force the lazy facet getters). Precedence stays: facets ▸
      // extras ▸ trunk — so the explicit work-path ids in `extras` (from
      // `input.context`, authoritative) win over the ambient trunk, and the
      // `ctxExtensions` (spread first) lose to the hardcoded universal fields.
      const dispatchCtx = deriveContext(
        ambient,
        {
          log: (level, data, logger, trace) => {
            void Effect.runFork(this.emitLog(dispatchScope, level, data, logger, trace));
          },
          namespace: this.telemetryNamespace,
          defaultLabels: { ...this.defaultMetricLabels, tool: input.name, op: "ToolDispatch" },
          surface: "tool",
          scope: dispatchScope,
          runOperation: this.runOperation.bind(this),
          runtime: capturedRuntime,
          ...omitUndefined({ telemetry }),
        },
        {
          // ADR 66 — opaque, harness-agnostic extension slots (e.g.
          // `ctx.sandbox`). Listed FIRST so the hardcoded universal fields
          // below always win over any accidental key collision. Typed by
          // `ToolHandlerCtxExtensions` augmentations; values point at live
          // bridges (dispatch-resolved, not render-captured).
          ...this.ctxExtensions,
          toolCallId: input.toolCallId,
          ...omitUndefined({
            sessionId: input.context.sessionId,
            executionId: input.context.executionId,
            tickId: input.context.tickId,
            responseFormat: input.context.responseFormat,
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
          // Bound to THIS dispatch's fiber runtime, so the elicit operation
          // nests under `tool:command:dispatch` and inherits its
          // `executionId` / `tickId`. Unbound, it ran as a root with an empty
          // ambient context and landed with neither — measured in
          // `session/__tests__/dispatch-scope-inheritance.spec.tsx`.
          elicit: buildSessionElicit({ harness: this.elicitation, runtime: capturedRuntime }),
          ...omitUndefined({ tasks: this.tasks }),
          // #273 — bound to THIS dispatch, so a tool this handler starts
          // inherits the crossing that reached here (principal, executionId,
          // tickId) rather than beginning as a context-free host call.
          tools: this.toolsFor(input.context, capturedRuntime),
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
          // ADR 64/78/19/83 — the Observability (`log`/`trace`/`metrics`) + Ops
          // (`run`/`runner`) facets ride in via the `deriveContext` facets arg
          // above (lazy getters). `log` emits
          // ONE discrete bus event (`tool:signal:log`, phase `terminal`,
          // bus-only) scoped to this dispatch; projections subscribe (MCP →
          // notifications/message; agentick client → subscribe/onLog).
          // ADR 64 — `progress` signal. Every form (the raw call door and the
          // frames a `begin()` reporter emits) collapses to ONE discrete bus
          // event (`tool:signal:progress`, phase `terminal`, bus-only) scoped
          // to this dispatch, through the SAME emission below. Fire-and-forget:
          // launched with `Effect.runFork`, never awaited, never throws into
          // the handler. `begin()` bakes in the tool call id as the token — the
          // dispatch already has a correlation id, so a handler never invents
          // one.
          progress: createProgress((token: ProgressToken, p: ProgressUpdate): void => {
            void Effect.runFork(
              this.emitProgress(
                dispatchScope,
                {
                  token,
                  op: TOOL_DISPATCH_EVENT_NAME,
                  progress: p.progress,
                  ...(p.total !== undefined ? { total: p.total } : {}),
                  ...(p.message !== undefined ? { message: p.message } : {}),
                },
                { parentOpId: opIdForCausality },
              ),
            );
          }, input.toolCallId),
        },
      );
      // The dispatch seam demands the brand: only a `deriveContext` output
      // satisfies `Derived<ToolHandlerCtx>` — a hand-assembled bag fails to
      // compile here (ADR 91 §Enforcement). A branded value still satisfies the
      // plain `ToolHandlerCtx` a handler receives, so adopters are unaffected.
      const ctx: Derived<ToolHandlerCtx> = dispatchCtx;

      // ─── Confirmation gate ──────────────────────────────────────────
      // Tools whose `requiresConfirmation` resolves truthy route through
      // the ElicitationHarness. `true` always confirms; a predicate is
      // evaluated (sync or async) against the validated input + this ctx.
      // The wire envelope is the standard elicitation shape
      // (session:channel:elicitation, hints.kind === "tool_confirmation");
      // the response is validated against TOOL_CONFIRMATION_REPLY_SCHEMA.
      // Applies to client-handled tools too — they gate BEFORE relaying.
      const requiresConfirmation = reg.declaration.annotations?.requiresConfirmation;
      const toolVerdict =
        requiresConfirmation === undefined
          ? hintedConfirmationVerdict(reg.declaration.annotations)
          : typeof requiresConfirmation === "function"
            ? yield* Effect.promise(() => Promise.resolve(requiresConfirmation(validated, ctx)))
            : requiresConfirmation === true;
      // The deployment-wide policy gets the FINAL say, with the tool's own
      // verdict in hand — force, suppress, or defer. Session-scoped `always`
      // grants (a user's confirmation reply) still short-circuit below.
      const policy = this.confirmationPolicy;
      const needsConfirmation =
        policy !== undefined
          ? yield* Effect.promise(() =>
              Promise.resolve(
                policy({ declaration: reg.declaration, input: validated, ctx, toolVerdict }),
              ),
            )
          : toolVerdict;
      // A decision is keyed by the declaration's own name: `input.name` may be
      // an alias the registry resolved, and a store keyed on the alias
      // recognizes nothing when the next call arrives under the real name.
      const canonicalName = reg.declaration.name;
      let confirmation: ToolConfirmationResolution | undefined;
      if (needsConfirmation) {
        const asked = {
          toolUseId: input.toolCallId,
          toolName: canonicalName,
          sessionId: input.context.sessionId ?? this.scopeId,
          arguments: validated as Record<string, unknown>,
        } as const;
        const confirmationTimeoutMs =
          reg.declaration.annotations?.confirmationTimeoutMs ??
          input.confirmationTimeoutMs ??
          this.defaultConfirmationTimeoutMs;

        // Confirmation seams (restored from v1) — evaluated INTO the
        // existing elicit `message` / `metadata` slots, no new elicit
        // machinery. `confirmationMessage` is a static string OR a per-call
        // function on the validated input + ctx; it becomes the elicit
        // `message`, falling back to the default prompt. `confirmationPreview`
        // is awaited and merged under `metadata.preview` so the existing
        // `toolUseId` / `toolName` / `arguments` keys stay intact.
        const confirmationAnnotations = reg.declaration.annotations;
        const confirmationMessage = confirmationAnnotations?.confirmationMessage;
        const message =
          (typeof confirmationMessage === "function"
            ? yield* Effect.promise(() => Promise.resolve(confirmationMessage(validated, ctx)))
            : confirmationMessage) ?? `Approve tool "${canonicalName}"?`;
        const confirmationPreview = confirmationAnnotations?.confirmationPreview;
        const preview =
          confirmationPreview !== undefined
            ? yield* Effect.promise(() => confirmationPreview(validated, ctx))
            : undefined;

        // The signal flows through to the elicitation registry; an
        // inbox abort or caller signal abort settles the pending
        // elicit with `{ outcome: "failed", failure.kind: "aborted" }`.
        const elicit = this.elicitation.elicit(
          {
            message,
            schema: TOOL_CONFIRMATION_REPLY_SCHEMA,
            hints: { kind: TOOL_CONFIRMATION_KIND },
            metadata: {
              toolUseId: input.toolCallId,
              toolName: canonicalName,
              arguments: validated as Record<string, unknown>,
              ...(preview !== undefined ? { preview } : {}),
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
              confirmation: { ...asked, outcome: "timeout" },
            }),
          );
        }

        // Approval requires accepted + reply.approved === true. Every
        // other path — declined, cancelled, failed.aborted,
        // failed.schema_violation, or accepted-with-approved-false —
        // refuses the dispatch. Only the ANSWERED refusals are reported as
        // denials: an ask torn down by an abort was never decided.
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
            // A DENIAL is produced by the agentick confirmation gate — the
            // tool never ran, so declaration provenance (`mcp:<serverId>`)
            // would claim an execution that never happened. `executedBy`
            // means "who ran the tool"; on a denial that is the framework.
            executedBy: "agentick",
            durationMs: 0,
            confirmation: {
              ...asked,
              outcome: wasAborted(elicitResult) ? "aborted" : "denied",
              ...omitUndefined({ reason: denyReason }),
            },
          };
          return denialResult;
        }

        // Re-validate when the host returns modifiedArguments — the
        // user may have edited the call before approving. An edit that fails
        // validation rejects the dispatch, so the approval record below is
        // never written: the approved call never ran.
        if (reply!.modifiedArguments !== undefined) {
          const revalidated = yield* Effect.tryPromise({
            try: async () => validator.validate(reply!.modifiedArguments),
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

        confirmation = {
          ...asked,
          outcome: "approved",
          ...omitUndefined({
            always: reply!.always,
            modifiedArguments: reply!.modifiedArguments,
          }),
        };
      }

      // ─── Tool-call presentation (Pass B) ────────────────────────────
      // Surface the RAW materials for "what is this call doing?" as FOUR
      // distinct fields — the client composes; the framework presumes no
      // precedence (identity `title ?? name`, activity `narration ?? summary`
      // are the CLIENT's call):
      //   name      — the raw tool id (keys / logic)
      //   title     — humanized identity (annotations.title)
      //   summary   — the author's per-call description (displaySummary)
      //   narration — the model's own first-person `_summary`
      // This is the SINGLE resolution site: it holds the stripped model
      // narration, the tool's annotations, AND the final validated input
      // (post-confirmation, so a host-edited `modifiedArguments` is
      // reflected). `displaySummary` is resolved INDEPENDENTLY of the model
      // narration (both are surfaced distinctly). The result rides
      // `DispatchResult.presentation` — the loop surfaces it on the tool
      // lifecycle path; it is NEVER sent to the model and NEVER reaches the
      // handler.
      const presentationTitle = reg.declaration.annotations?.title;
      const ds = reg.declaration.annotations?.displaySummary;
      const resolvedDisplaySummary: string | undefined =
        typeof ds === "function"
          ? yield* Effect.promise(() => Promise.resolve(ds(validated, ctx)))
          : ds;
      const presentation: ToolPresentation = {
        name: input.name,
        ...(presentationTitle !== undefined ? { title: presentationTitle } : {}),
        ...(resolvedDisplaySummary !== undefined ? { summary: resolvedDisplaySummary } : {}),
        ...(modelNarration !== undefined ? { narration: modelNarration } : {}),
      };

      // ─── Client-handled dispatch (no server handler) ────────────────
      // The declaration carried no `handlerRef`, so there is nothing to
      // invoke locally. Runs AFTER validation + the confirmation gate.
      // Per `annotations.requiresResponse`:
      //   - `true`  → SUSPEND: relay the call to the client via
      //     `this.request(TOOL_CALL_CHANNEL, …)` — a correlated
      //     request/response over the SAME suspend-resume infra the
      //     confirmation gate uses — and resolve with the client's
      //     returned `ToolResultInput`. On timeout, fall back to
      //     `defaultResult` when set, else fail `ToolCallTimeoutError`.
      //   - falsy   → FIRE-AND-FORGET: notify the client (one-way bus
      //     publish, no Deferred) and resolve immediately with
      //     `defaultResult` (or a canned success block).
      // Placed BEFORE the tool-timeout arming below so the client path
      // never leaves a dangling `setTimeout`.
      if (isClientHandled) {
        const ann = reg.declaration.annotations;
        let normalized: NormalizedToolResult;

        if (ann?.requiresResponse === true) {
          // The relay is wrapped in an OPERATION so the suspension has both
          // edges on the bus: `request` publishes the ask and nothing else,
          // because the answer returns over the inbox. The op's
          // requested/terminal pair is what lets the session hold itself at
          // `input_required` for exactly as long as a client owes an answer —
          // the same seam `elicitation:command:elicit` gives an ask.
          const clientCallOp: Operation<ToolCallRequestPayload, ToolResultInput, RequestError> = {
            opId: `tool:client-call:${input.toolCallId}`,
            surface: "tool",
            name: TOOL_CLIENT_CALL_COMMAND,
            scope: dispatchScope,
            input: {
              toolCallId: input.toolCallId,
              name: input.name,
              input: validated,
              // A broadcast tool is addressed to nobody, which every client
              // reads as "mine too".
              ...omitUndefined({
                target: ann?.broadcast === true ? undefined : input.context.clientId,
              }),
            },
          };
          const respEffect = this.runOperation(clientCallOp, (relay) =>
            this.request<ToolCallRequestPayload, ToolResultInput>(TOOL_CALL_CHANNEL, relay, {
              ...omitUndefined({ timeoutMs: ann.responseTimeoutMs ?? input.responseTimeoutMs }),
              signal: controller.signal,
              scope: dispatchScope,
            }),
          );
          const resp = yield* Effect.either(respEffect);
          if (resp._tag === "Left") {
            // `runOperation` widens the failure channel with `SubstrateError`,
            // whose `JournalError` member declares `_tag: string` — which
            // defeats the tag narrowing. A journal failure reaches the abort
            // branch, which is where an unanswerable relay belongs anyway.
            const failure = resp.left as RequestError;
            if (failure._tag === "RequestTimeoutError" && ann.defaultResult !== undefined) {
              // Timeout with an opt-in fallback — resolve with it. The
              // seam is static blocks OR a per-call function on the
              // validated input + ctx (sync or async), evaluated here.
              const dr = ann.defaultResult;
              const resolvedDefault =
                typeof dr === "function"
                  ? yield* Effect.promise(() => Promise.resolve(dr(validated, ctx)))
                  : dr;
              normalized = normalizeToolResult(resolvedDefault);
            } else if (failure._tag === "RequestTimeoutError") {
              callerSignal?.removeEventListener("abort", onCallerAbort);
              this.inFlight.delete(input.toolCallId);
              return yield* Effect.fail(
                new ToolCallTimeoutError({ toolName: input.name, ms: failure.ms }),
              );
            } else {
              // Abort / cancel — the caller signal fired or the request
              // was cancelled. Surface as a HARD abort, matching the
              // server handler abort path.
              callerSignal?.removeEventListener("abort", onCallerAbort);
              this.inFlight.delete(input.toolCallId);
              return yield* Effect.fail(
                new ToolAbortedError({
                  toolCallId: input.toolCallId,
                  ...omitUndefined({
                    reason:
                      typeof controller.signal.reason === "string"
                        ? controller.signal.reason
                        : undefined,
                  }),
                }),
              );
            }
          } else {
            normalized = normalizeToolResult(resp.right);
          }
        } else {
          // Fire-and-forget: one-way notification, no correlation/Deferred.
          yield* this.notifyChannel<ToolCallRequestPayload>(
            TOOL_CALL_CHANNEL,
            {
              toolCallId: input.toolCallId,
              name: input.name,
              input: validated,
              // A broadcast tool is addressed to nobody, which every client
              // reads as "mine too".
              ...omitUndefined({
                target: ann?.broadcast === true ? undefined : input.context.clientId,
              }),
            },
            { scope: dispatchScope },
          );
          // Fire-and-forget resolves with `defaultResult` — static blocks
          // OR a per-call function on the validated input + ctx (sync or
          // async), evaluated here — else a canned success block.
          const dr = ann?.defaultResult;
          const resolvedDefault =
            typeof dr === "function"
              ? yield* Effect.promise(() => Promise.resolve(dr(validated, ctx)))
              : dr;
          normalized = normalizeToolResult(
            resolvedDefault ?? [{ type: "text", text: "executed successfully" }],
          );
        }

        callerSignal?.removeEventListener("abort", onCallerAbort);
        this.inFlight.delete(input.toolCallId);
        const clientResult: DispatchResult = {
          toolCallId: input.toolCallId,
          name: input.name,
          content: normalized.content,
          ...(normalized.isError !== undefined ? { isError: normalized.isError } : {}),
          ...(normalized.structuredContent !== undefined
            ? { structuredContent: normalized.structuredContent }
            : {}),
          ...(normalized.metadata !== undefined ? { metadata: normalized.metadata } : {}),
          // Observability — a client, not the local handler, produced this.
          executedBy: "client",
          durationMs: Date.now() - started,
          presentation,
          ...(confirmation !== undefined ? { confirmation } : {}),
        };
        return clientResult;
      }

      const timeoutMs =
        input.timeoutMs ?? reg.declaration.annotations?.timeout ?? this.defaultTimeoutMs;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          controller.abort(new ToolTimeoutError({ toolName: input.name, ms: timeoutMs }));
        }, timeoutMs);
      }

      const useDeps: Readonly<Record<string, unknown>> = {
        ...(reg.useDeps ?? {}),
        ...(input.context.use ?? {}),
      };

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
          // `entry` is defined here: the `isClientHandled` branch above
          // already returned for handler-less tools, so this path only
          // runs when the resolver produced an entry.
          const handlerResult = entry!.handler(validated, { ctx, use: useDeps });

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
          // Provenance rides the declaration: an MCP-routed tool stamps
          // `mcp:<serverId>` (see `mcpDeclaration`), everything else
          // server-handled defaults to `agentick`. `executedBy` is
          // server-authoritative — a wire client cannot set it (absent from
          // `ClientToolAnnotations`, stripped at `toClientToolRegistration`).
          executedBy: reg.declaration.annotations?.executedBy ?? "agentick",
          durationMs: Date.now() - started,
          presentation,
          ...(confirmation !== undefined ? { confirmation } : {}),
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

type ConfirmationElicitResult =
  | { readonly outcome: "accepted"; readonly value: ToolConfirmationReply }
  | { readonly outcome: "declined"; readonly reason?: string }
  | { readonly outcome: "cancelled"; readonly reason?: string }
  | {
      readonly outcome: "failed";
      readonly failure: { readonly kind: string; readonly reason?: string };
    };

/**
 * Pull the validated reply out of an `accepted` elicitation result.
 * Returns `undefined` for any other outcome.
 */
function extractReply(result: ConfirmationElicitResult): ToolConfirmationReply | undefined {
  return result.outcome === "accepted" ? result.value : undefined;
}

/**
 * The verdict for a tool that declared none of its own. Read-only wins over
 * destructive because MCP defines `destructiveHint` as meaningful only when
 * `readOnlyHint` is false — a server may advertise both.
 */
function hintedConfirmationVerdict(annotations: ToolAnnotations | undefined): boolean {
  if (annotations?.readOnlyHint === true) return false;
  return annotations?.destructiveHint === true;
}

/**
 * The ask was torn down rather than answered — the caller's signal aborted
 * or the host cancelled the prompt. Distinct from a decline, which IS an
 * answer.
 */
function wasAborted(result: ConfirmationElicitResult): boolean {
  return (
    result.outcome === "cancelled" ||
    (result.outcome === "failed" && result.failure.kind === "aborted")
  );
}

/**
 * Compose a denial reason from the available signals: the user's
 * `accepted+approved:false` reason, declined/cancelled reason, or a
 * failure-kind label.
 */
function denialReason(
  result: ConfirmationElicitResult,
  reply: ToolConfirmationReply | undefined,
): string | undefined {
  if (reply !== undefined) return reply.reason;
  if (result.outcome === "declined" || result.outcome === "cancelled") return result.reason;
  if (result.outcome === "failed") return result.failure.reason ?? result.failure.kind;
  return undefined;
}

// Silence unused-import linting until 4a.6+ uses ToolRegistration alias.
void (undefined as unknown as ToolRegistration);

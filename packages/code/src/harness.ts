/**
 * `CodeHarness` — `BaseHarness<"code">` holding one {@link Runtime}.
 *
 * The harness owns the operation and nothing else. `code:execute` is a
 * declared command (ADR 51), so every program the model runs is journaled with
 * its source, its digest and its binding NAMES, is wrapped by the interceptor
 * cascade, and is vetoable by {@link guardCodeExecute} before the provider is
 * touched. What the program can reach, what language it is written in and how
 * it is contained are the provider's business.
 *
 * **Abort reaches the program, not just the Promise.** The operation fiber's
 * signal is threaded into the provider call, so interrupting the enclosing op
 * tears the program down instead of abandoning it; a caller's own
 * `CodeContextOptions.signal` merges with it. A stopped program raises
 * `CodeAborted` — cancellation is not an answer, so it is not an outcome.
 *
 * `createContext` carries required binding FUNCTIONS, so it stays a plain
 * in-process method (ADR 51 §1.2) — and `dispose` stays with it, because
 * splitting a lifecycle pair across two mechanisms buys an op no guard would
 * ever veto.
 *
 * `code:execute` is `exposure: "internal"`: reachable in-process, never
 * addressable from the inbox or the wire. The same reasoning that refuses an
 * implicit default provider refuses a remotely-addressable eval verb.
 *
 * @see docs/proposals/v2/code.md
 * @see ./contract.ts
 */

import { Effect } from "effect";
import {
  BaseHarness,
  generateId,
  type BaseHarnessOptions,
  type GuardDecider,
  type Unsubscribe,
} from "@agentick/runtime";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";
import { mergeAbortSignals, omitUndefined } from "@agentick/utils";

import { sha256Hex } from "./code-hash.js";
import { CODE_BUDGET_KEYS } from "./contract.js";
import type {
  Code,
  CodeBindings,
  CodeBudgets,
  CodeCapabilities,
  CodeContext,
  CodeContextOptions,
  CodeExecuteInput,
  CodeExecuteRequest,
  CodeExecuteResult,
  CodeFx,
  CodeRuntimeContext,
  Runtime,
} from "./contract.js";
import {
  CodeAborted,
  CodeBindingNameConflict,
  CodeBindingNameInvalid,
  CodeBudgetUnsupported,
  CodeContextDisposed,
  CodeHarnessClosed,
  CodeProviderMissing,
  CodeResultInvalid,
  CodeRuntimeAlreadyBound,
  CodeRuntimeFailed,
  type CodeErrorChannel,
} from "./errors.js";

const SURFACE = "code" as const;

/** Ambient names a provider injects: plain identifiers only. */
const SAFE_BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_BINDING_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const DISPOSE_ABORT_REASON = "the code context was disposed";

// ADR 80/83 — typing the verb mints `onBeforeCodeExecute` / `onAfterCodeExecute`
// on the derived hooks surface. Generics are the declaration site's.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "code:execute": { input: CodeExecuteInput; output: CodeExecuteResult };
  }
}

export interface CodeHarnessOptions extends BaseHarnessOptions {
  /**
   * The provider. Optional: the harness is always present and INERT until a
   * runtime is bound, so a session can carry `code` at zero cost and an
   * adopter can bind late via {@link CodeHarness.bindRuntime}.
   */
  readonly runtime?: Runtime;
}

/**
 * A context this harness opened: the live provider object and the caller's
 * signal, which are the two things that must NOT reach the journal, plus the
 * audit facts that must.
 */
interface OpenContext {
  readonly runtimeContext: CodeRuntimeContext;
  readonly bindings: readonly string[];
  readonly budgets?: CodeBudgets;
  /** The harness's own door onto this context's work — what dispose/close fire. */
  readonly abort: AbortController;
  /** Caller's signal merged with {@link abort}: one signal the provider sees. */
  readonly signal: AbortSignal;
  /**
   * Tail of this context's execution chain. Every `execute` links onto it
   * SYNCHRONOUSLY, which is what makes executions serial (M9) and what lets
   * dispose await work that was issued before it.
   */
  queue: Promise<void>;
  disposed: boolean;
}

export class CodeHarness extends BaseHarness<typeof SURFACE> implements Code {
  private runtime: Runtime | undefined;
  private closed = false;
  private readonly contexts = new Map<string, OpenContext>();

  private readonly executeCommand: (input: CodeExecuteInput) => Promise<CodeExecuteResult>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: CodeHarnessOptions = {},
  ) {
    super(SURFACE, scopeId, journal, bus, inbox, options);
    this.runtime = options.runtime;
    this.executeCommand = this.command({
      name: "code:execute",
      exposure: "internal",
      description: "Run model-authored source in an open code context.",
      // The context is a routing dimension of its own: one session can hold
      // several, so `sessionId` cannot separate their executions.
      scope: (input: CodeExecuteInput) => ({ codeContextId: input.contextId }),
      handler: (input: CodeExecuteInput) => this.applyExecute(input),
    });
  }

  /**
   * Bind the provider — ONCE. The seam exists for the window between building
   * an adopter-owned harness and choosing what will run its code; it is not a
   * swap, because replacing a runtime under open contexts would leave half of
   * them on the old provider and every audit record naming one the reader
   * cannot map back to an execution.
   *
   * @throws {CodeRuntimeAlreadyBound}
   */
  bindRuntime(runtime: Runtime): void {
    if (this.runtime !== undefined) {
      throw new CodeRuntimeAlreadyBound({ provider: this.runtime.capabilities.name });
    }
    this.runtime = runtime;
  }

  hasRuntime(): boolean {
    return this.runtime !== undefined;
  }

  capabilities(): CodeCapabilities {
    return this.requireRuntime().capabilities;
  }

  /**
   * Veto, replace or defer a program BEFORE it runs — the seam where
   * deployment policy reads the source, the binding names and the budgets and
   * decides. The code-typed name for `BaseHarness.guardEffect`, mirroring the
   * tool executor's `guardDispatch`: guard : operation :: gate : loop.
   */
  guardCodeExecute(
    decide: GuardDecider<CodeExecuteInput, CodeExecuteResult, unknown>,
  ): Unsubscribe {
    return this.guardEffect<CodeExecuteInput, CodeExecuteResult>(decide);
  }

  /**
   * The Effect twin — hand-authored rather than proxied straight onto the
   * command, because the command's input IS the audit record and a caller must
   * not be able to write it. `fx.execute` takes only the context and the
   * source, then derives the digest, the binding names and the budgets from
   * the open context exactly as the Promise door does. Both doors converge on
   * one internal command, so there is no path that journals a program's
   * description without deriving it.
   */
  get fx(): CodeFx {
    return this.fxProxy({
      execute: ((request: CodeExecuteRequest) =>
        Effect.gen(this, function* () {
          const open = this.openFor(request.contextId);
          // Same queue the Promise door uses, so ordering holds across both.
          const release = yield* Effect.promise(() => this.acquireTurn(open));
          const input = yield* Effect.promise(() =>
            this.auditInput(open, request.contextId, request.source),
          );
          // `commandEffect`, NOT the Promise method: the twin exists so the op
          // parents under the CALLER's fiber. Going through the facade would
          // re-enter Effect on a fresh root, and an interrupt upstream would
          // never reach the running program.
          return yield* this.commandEffect<CodeExecuteInput, CodeExecuteResult, CodeErrorChannel>(
            "code:execute",
            input,
          ).pipe(Effect.ensuring(Effect.sync(release)));
        })) as never,
    }) as unknown as CodeFx;
  }

  // ─────────── Context lifecycle (plain methods — ADR 51 §1.2) ───────────

  async createContext(options: CodeContextOptions = {}): Promise<CodeContext> {
    if (this.closed) throw new CodeHarnessClosed({ harnessId: this.scopeId });
    const runtime = this.requireRuntime();
    this.assertBudgetsEnforceable(runtime, options.budgets);
    // Names are validated BEFORE the provider is touched: a rejected binding
    // must not leave a live context behind.
    const names = this.checkedBindingNames(options.bindings);

    const id = `code-ctx-${generateId()}`;
    const runtimeContext = await this.openRuntimeContext(runtime, options);
    const abort = new AbortController();
    this.contexts.set(id, {
      runtimeContext,
      bindings: names,
      abort,
      // ONE signal for the provider: the caller's door and the harness's.
      signal: mergeAbortSignals(options.signal, abort.signal) ?? abort.signal,
      queue: Promise.resolve(),
      disposed: false,
      ...omitUndefined({ budgets: options.budgets }),
    });
    return {
      id,
      bindings: names,
      execute: (source: string) => this.executeIn(id, source),
      dispose: () => this.disposeContext(id),
    };
  }

  /**
   * One-shot: a context opened, used once, disposed whatever the outcome.
   *
   * The RESULT wins. A teardown that fails after the program answered must not
   * turn a good answer into a rejection — the caller asked for the program's
   * value, and the provider's disposal trouble is an operational fact reported
   * on the log, loudly, rather than a reason to discard it.
   */
  async run(source: string, options: CodeContextOptions = {}): Promise<CodeExecuteResult> {
    const context = await this.createContext(options);
    let answered = false;
    try {
      const result = await context.execute(source);
      answered = true;
      return result;
    } finally {
      await context.dispose().catch((cause: unknown) => {
        if (!answered) throw cause;
        this.reportDisposeFailure(context.id, cause);
      });
    }
  }

  /**
   * A disposal that failed AFTER the program answered. Logged rather than
   * thrown (the answer wins) and never swallowed silently — a provider leaking
   * contexts is exactly the kind of slow failure that only shows up in a log.
   */
  private reportDisposeFailure(contextId: string, cause: unknown): void {
    this.deriveOperationCtx(this.parentScope ?? {}).log.warn(
      {
        msg: "code context disposal failed after the program answered",
        contextId,
        provider: this.providerName(),
        error: String(cause),
      },
      "@agentick/code",
    );
  }

  // ─────────── Command body ───────────

  /**
   * The `tryPromise` callback's parameter is the OPERATION FIBER's signal, so
   * interrupting the enclosing op — a cancelled turn, an aborted tool dispatch
   * — reaches the running program instead of leaving it orphaned behind a
   * settled Promise. Merged with the caller's context signal so the provider
   * honors both through one parameter.
   */
  private applyExecute(
    input: CodeExecuteInput,
  ): Effect.Effect<CodeExecuteResult, CodeErrorChannel, never> {
    return Effect.suspend(() => {
      const open = this.contexts.get(input.contextId);
      if (open === undefined) {
        return Effect.fail(new CodeContextDisposed({ contextId: input.contextId }));
      }
      // Abort is checked BEFORE disposal: a dispose fires the context's abort
      // and then waits, so work still queued behind it was stopped, not
      // orphaned, and `CodeAborted` is the accurate report.
      if (open.signal.aborted) return Effect.fail(this.aborted(input.contextId, open.signal));
      if (open.disposed) {
        return Effect.fail(new CodeContextDisposed({ contextId: input.contextId }));
      }
      return Effect.tryPromise({
        try: (fiberSignal) =>
          open.runtimeContext
            .execute(
              input.source,
              omitUndefined({ signal: mergeAbortSignals(open.signal, fiberSignal) }),
            )
            .then((result) => this.normalized(result)),
        // A provider that rejects on an aborted signal is reporting the abort,
        // whatever it threw to do it — so the abort wins the classification.
        catch: (cause): CodeErrorChannel =>
          open.signal.aborted
            ? this.aborted(input.contextId, open.signal, cause)
            : this.executeFailure(cause),
      });
    });
  }

  /**
   * Hold the provider to the result union (H4). A malformed answer is a
   * contract violation, so it fails as one instead of reaching a caller who
   * would switch on an `outcome` that does not exist. Only `truncated` is
   * gap-filled — an absent list unambiguously means "nothing was cut".
   */
  private normalized(result: CodeExecuteResult): CodeExecuteResult {
    const provider = this.providerName();
    const outcome = (result as { outcome?: unknown } | null | undefined)?.outcome;
    if (typeof outcome !== "string") {
      throw new CodeResultInvalid({ provider, reason: "no outcome" });
    }
    // A provider that omitted `truncated` despite the type gets the honest
    // default; anything it DID send wins, so the spread order is load-bearing.
    const filled = {
      truncated: [],
      ...(result as unknown as Record<string, unknown>),
    } as unknown as CodeExecuteResult;
    switch (filled.outcome) {
      case "returned":
        if (!("value" in filled)) {
          throw new CodeResultInvalid({ provider, reason: '"returned" carries no value' });
        }
        return filled;
      case "no-value":
        return filled;
      case "threw":
        if (typeof filled.error?.message !== "string") {
          throw new CodeResultInvalid({ provider, reason: '"threw" carries no error message' });
        }
        return filled;
      case "budget-exceeded":
        if (typeof filled.limit !== "number") {
          throw new CodeResultInvalid({ provider, reason: '"budget-exceeded" carries no limit' });
        }
        return filled;
      default:
        throw new CodeResultInvalid({ provider, reason: `unknown outcome "${String(outcome)}"` });
    }
  }

  /** A normalization failure is already typed; anything else is the provider's. */
  private executeFailure(cause: unknown): CodeErrorChannel {
    if (cause instanceof CodeResultInvalid) return cause;
    return new CodeRuntimeFailed({ provider: this.providerName(), phase: "execute", cause });
  }

  private aborted(contextId: string, signal: AbortSignal, cause?: unknown): CodeAborted {
    return new CodeAborted({
      contextId,
      ...omitUndefined({
        reason: typeof signal.reason === "string" ? signal.reason : undefined,
        cause,
      }),
    });
  }

  // ─────────── Internals ───────────

  /**
   * Link this program onto the context's chain and dispatch it.
   *
   * The link is made SYNCHRONOUSLY, before any await. That is what makes two
   * concurrent executions serial (a provider may assume it), and it is also
   * what lets `dispose` wait for work that was already issued: without it, the
   * digest computation below yields the event loop, and a dispose landing in
   * that window would tear the context down under a program the caller had
   * every right to expect would run.
   */
  private async executeIn(contextId: string, source: string): Promise<CodeExecuteResult> {
    const open = this.openFor(contextId);
    const release = await this.acquireTurn(open);
    try {
      return await this.executeCommand(await this.auditInput(open, contextId, source));
    } finally {
      release();
    }
  }

  /** The context, or the typed reason there isn't one. Shared by both doors. */
  private openFor(contextId: string): OpenContext {
    const open = this.contexts.get(contextId);
    if (open === undefined) throw new CodeContextDisposed({ contextId });
    // Abort outranks disposal: a dispose fires the abort and then waits, so
    // work stopped by it reports the accurate reason.
    if (open.signal.aborted) throw this.aborted(contextId, open.signal);
    if (open.disposed) throw new CodeContextDisposed({ contextId });
    return open;
  }

  /**
   * Take the next slot on this context's chain, returning the release.
   *
   * The slot is claimed SYNCHRONOUSLY — `open.queue` is reassigned before this
   * returns — which is what makes executions serial (M9) and what lets
   * `dispose` await work issued before it. Without the synchronous claim the
   * digest computation below yields the event loop, and a dispose landing in
   * that window would tear the context down under a program the caller had
   * every right to expect would run.
   */
  private acquireTurn(open: OpenContext): Promise<() => void> {
    const ahead = open.queue;
    let release!: () => void;
    open.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return ahead.then(() => release);
  }

  /**
   * The audit envelope. The digest and the binding names are DERIVED here
   * rather than accepted from a caller — neither door onto the command can
   * describe a program other than the one about to run.
   */
  private async auditInput(
    open: OpenContext,
    contextId: string,
    source: string,
  ): Promise<CodeExecuteInput> {
    return {
      contextId,
      source,
      codeHash: await sha256Hex(source),
      bindings: open.bindings,
      ...omitUndefined({ budgets: open.budgets }),
    };
  }

  private async openRuntimeContext(
    runtime: Runtime,
    options: CodeContextOptions,
  ): Promise<CodeRuntimeContext> {
    try {
      return await runtime.createContext(options);
    } catch (cause) {
      throw new CodeRuntimeFailed({
        provider: runtime.capabilities.name,
        phase: "create-context",
        cause,
      });
    }
  }

  /**
   * Abort, drain, then tear down — one rule for both doors (`dispose` here,
   * `close` through {@link teardown}).
   *
   * The order is the whole point. Firing the abort first means an in-flight
   * program is STOPPED rather than left running against a context that is
   * about to vanish; draining means the provider's `dispose` sees no execution
   * still outstanding; and only then does the context leave the registry, so
   * work queued behind the abort reports `CodeAborted` instead of the less
   * accurate `CodeContextDisposed`.
   */
  private async disposeContext(id: string): Promise<void> {
    const open = this.contexts.get(id);
    if (open === undefined || open.disposed) return;
    open.disposed = true;
    open.abort.abort(DISPOSE_ABORT_REASON);
    await open.queue;
    try {
      await open.runtimeContext.dispose();
    } catch (cause) {
      throw new CodeRuntimeFailed({ provider: this.providerName(), phase: "dispose", cause });
    } finally {
      this.contexts.delete(id);
    }
  }

  private requireRuntime(): Runtime {
    if (this.runtime === undefined) throw new CodeProviderMissing();
    return this.runtime;
  }

  private providerName(): string {
    return this.runtime?.capabilities.name ?? "unbound";
  }

  /**
   * Every binding name, checked and de-duplicated — the boundary that sees all
   * of them before any engine does.
   *
   * Two refusals, both because a provider turns these into AMBIENT names.
   * A name in two groups has no defensible winner and would appear twice in
   * the audit record; a name like `__proto__` or one that is not an identifier
   * is a prototype-pollution primitive being handed to model-authored code.
   */
  private checkedBindingNames(bindings: CodeBindings | undefined): readonly string[] {
    const groups = [
      ["tools", bindings?.tools],
      ["fs", bindings?.fs],
      ["values", bindings?.values],
    ] as const;
    const claimedBy = new Map<string, string>();
    for (const [group, bag] of groups) {
      for (const name of Object.keys(bag ?? {})) {
        this.assertUsableBindingName(name);
        const prior = claimedBy.get(name);
        if (prior !== undefined) {
          throw new CodeBindingNameConflict({ bindingName: name, groups: [prior, group] });
        }
        claimedBy.set(name, group);
      }
    }
    return [...claimedBy.keys()].sort();
  }

  private assertUsableBindingName(name: string): void {
    if (!SAFE_BINDING_NAME.test(name)) {
      throw new CodeBindingNameInvalid({
        bindingName: name,
        reason: "not a plain identifier",
      });
    }
    if (RESERVED_BINDING_NAMES.has(name)) {
      throw new CodeBindingNameInvalid({
        bindingName: name,
        reason: "collides with a prototype member",
      });
    }
  }

  private assertBudgetsEnforceable(runtime: Runtime, budgets: CodeBudgets | undefined): void {
    if (budgets === undefined) return;
    for (const key of CODE_BUDGET_KEYS) {
      if (budgets[key] === undefined) continue;
      if (runtime.capabilities.enforces.includes(key)) continue;
      throw new CodeBudgetUnsupported({ budget: key, provider: runtime.capabilities.name });
    }
  }

  /**
   * Contexts outlive no harness. `closed` is set FIRST so nothing new is
   * admitted while the drain runs, then every context aborts and drains, and
   * the runtime is released only once no program is still executing against
   * it. `close()` therefore returns when the work is actually over.
   */
  protected override async teardown(): Promise<void> {
    this.closed = true;
    for (const id of [...this.contexts.keys()]) {
      await this.disposeContext(id).catch((cause: unknown) => {
        this.reportDisposeFailure(id, cause);
      });
    }
    await this.runtime?.dispose();
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown code message type: ${msg.type}` }));
  }
}

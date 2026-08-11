/**
 * The code harness's error family.
 *
 * Note what is NOT here: a program that throws is a RESULT
 * ({@link CodeThrew}), not an error. These are the failures of the machinery
 * around the program — no provider, a membrane that would not open, a context
 * already gone.
 *
 * The classes live in this package rather than in `@agentick/spec` because
 * nothing outside `@agentick/code` names them: spec stays neutral about which
 * harnesses exist (ADR 27), and the app reaches this harness as an opaque
 * namespace value. They still extend `AgentickError` and register with the
 * shared codec registry, so `instanceof`, `_tag` matching and serialization
 * behave exactly as they do for a spec-resident family — the registration is a
 * side effect of importing this package, which is sound here because
 * `code:execute` is in-process only and these never cross a wire.
 */

import { AgentickError, registerAgentickError } from "@agentick/spec";

export abstract class CodeError extends AgentickError {}

/**
 * `createContext` / `run` before any runtime was bound — the
 * `CompactStrategyMissing` analogue. There is deliberately no default
 * provider: an implicit one would mean unjailed host execution is what an
 * adopter gets by not deciding.
 */
export class CodeProviderMissing extends CodeError {
  readonly _tag = "CodeProviderMissing" as const;
  constructor(args?: { readonly cause?: unknown }) {
    super(
      "code execution requires a runtime: none is bound (withCode({ runtime }) / " +
        "createApp({ code: defineCode({ runtime }) })). There is no default provider — " +
        "the trust decision is the adopter's",
      { cause: args?.cause },
    );
  }
}
registerAgentickError("CodeProviderMissing", CodeProviderMissing);

/**
 * A budget was requested that the bound provider does not declare. Fails loud
 * rather than accepting the ceiling and ignoring it — a budget silently not
 * enforced is the one failure mode a caller cannot detect from the outside.
 */
export class CodeBudgetUnsupported extends CodeError {
  readonly _tag = "CodeBudgetUnsupported" as const;
  readonly budget: string;
  readonly provider: string;
  constructor(args: {
    readonly budget: string;
    readonly provider: string;
    readonly cause?: unknown;
  }) {
    super(`code runtime ${args.provider} does not enforce the ${args.budget} budget`, {
      cause: args.cause,
    });
    this.budget = args.budget;
    this.provider = args.provider;
  }
}
registerAgentickError("CodeBudgetUnsupported", CodeBudgetUnsupported);

/** `execute` on a context that was already disposed. */
export class CodeContextDisposed extends CodeError {
  readonly _tag = "CodeContextDisposed" as const;
  readonly contextId: string;
  constructor(args: { readonly contextId: string; readonly cause?: unknown }) {
    super(`code context ${args.contextId} is disposed`, { cause: args.cause });
    this.contextId = args.contextId;
  }
}
registerAgentickError("CodeContextDisposed", CodeContextDisposed);

/**
 * The PROVIDER failed — a membrane that would not open, a runtime that died
 * mid-execution, a teardown that rejected. Distinct from the program throwing,
 * which is a result the caller feeds back to the model.
 *
 * The cause is CHAINED but deliberately not interpolated into the message. A
 * runtime that dies mid-program tends to quote the program in its error, and
 * `message` is the field every log line, span attribute and UI renders by
 * default — so folding the cause in would publish, everywhere, exactly what a
 * caller was careful not to put in the audit record. Read `.cause` when you
 * want it.
 */
export class CodeRuntimeFailed extends CodeError {
  readonly _tag = "CodeRuntimeFailed" as const;
  readonly provider: string;
  readonly phase: "create-context" | "execute" | "dispose";
  override readonly cause: unknown;
  constructor(args: {
    readonly provider: string;
    readonly phase: "create-context" | "execute" | "dispose";
    readonly cause: unknown;
  }) {
    super(`code runtime ${args.provider} failed at ${args.phase}`, { cause: args.cause });
    this.provider = args.provider;
    this.phase = args.phase;
    this.cause = args.cause;
  }
}
registerAgentickError("CodeRuntimeFailed", CodeRuntimeFailed);

/**
 * A provider answered with something the {@link CodeExecuteResult} union does
 * not describe. A contract violation, so it fails as one rather than being
 * coerced into a plausible-looking outcome a caller would then act on.
 */
export class CodeResultInvalid extends CodeError {
  readonly _tag = "CodeResultInvalid" as const;
  readonly provider: string;
  readonly reason: string;
  constructor(args: {
    readonly provider: string;
    readonly reason: string;
    readonly cause?: unknown;
  }) {
    super(`code runtime ${args.provider} returned an invalid result: ${args.reason}`, {
      cause: args.cause,
    });
    this.provider = args.provider;
    this.reason = args.reason;
  }
}
registerAgentickError("CodeResultInvalid", CodeResultInvalid);

/**
 * One name claimed by two binding groups. Refused rather than resolved: the
 * program would call ONE of them and the audit record would list the name
 * twice, so "which ran" becomes a question about group precedence that nobody
 * reading the record can answer. Same stance as an ambiguous resource alias —
 * never pick a winner.
 */
export class CodeBindingNameConflict extends CodeError {
  readonly _tag = "CodeBindingNameConflict" as const;
  readonly bindingName: string;
  readonly groups: readonly string[];
  constructor(args: {
    readonly bindingName: string;
    readonly groups: readonly string[];
    readonly cause?: unknown;
  }) {
    super(
      `binding "${args.bindingName}" is claimed by ${args.groups.join(" and ")} — ` +
        `rename one; the harness will not choose`,
      { cause: args.cause },
    );
    this.bindingName = args.bindingName;
    this.groups = args.groups;
  }
}
registerAgentickError("CodeBindingNameConflict", CodeBindingNameConflict);

/**
 * A binding name that is not a plain identifier, or one that collides with a
 * prototype member. Refused at the boundary because a provider injects these
 * as AMBIENT names: `__proto__` or `constructor` reaching an injection site is
 * a prototype-pollution primitive handed to model-authored code, and the
 * harness is the one place that sees every name before any engine does.
 */
export class CodeBindingNameInvalid extends CodeError {
  readonly _tag = "CodeBindingNameInvalid" as const;
  readonly bindingName: string;
  readonly reason: string;
  constructor(args: {
    readonly bindingName: string;
    readonly reason: string;
    readonly cause?: unknown;
  }) {
    super(`binding name "${args.bindingName}" is not usable: ${args.reason}`, {
      cause: args.cause,
    });
    this.bindingName = args.bindingName;
    this.reason = args.reason;
  }
}
registerAgentickError("CodeBindingNameInvalid", CodeBindingNameInvalid);

/**
 * `bindRuntime` on a harness that already has one. The seam exists for the
 * unbound window of an adopter-built instance, not as a swap: replacing a
 * provider mid-session would leave open contexts pointing at the old one while
 * new ones use the new, and every audit record would name a provider the
 * reader cannot map back to an execution.
 */
export class CodeRuntimeAlreadyBound extends CodeError {
  readonly _tag = "CodeRuntimeAlreadyBound" as const;
  readonly provider: string;
  constructor(args: { readonly provider: string; readonly cause?: unknown }) {
    super(`a runtime (${args.provider}) is already bound; bindRuntime binds once`, {
      cause: args.cause,
    });
    this.provider = args.provider;
  }
}
registerAgentickError("CodeRuntimeAlreadyBound", CodeRuntimeAlreadyBound);

/** `createContext` after the harness closed. Fails before the provider is touched. */
export class CodeHarnessClosed extends CodeError {
  readonly _tag = "CodeHarnessClosed" as const;
  readonly harnessId: string;
  constructor(args: { readonly harnessId: string; readonly cause?: unknown }) {
    super(`code harness ${args.harnessId} is closed`, { cause: args.cause });
    this.harnessId = args.harnessId;
  }
}
registerAgentickError("CodeHarnessClosed", CodeHarnessClosed);

/**
 * The program was stopped before it answered — the caller's context signal
 * aborted, or the enclosing operation was interrupted.
 *
 * An ERROR rather than a fifth `CodeExecuteResult` arm, on the same line the
 * outcomes already draw: an outcome is what the program ANSWERED, and a
 * cancelled program answered nothing. Filing "you stopped this" beside
 * `threw` would put it in the union a caller feeds back to the model.
 * (`ToolAbortedError`, `ProviderAborted` and `LoopCanceledError` are the three
 * standing precedents for cancellation as a typed error.)
 */
export class CodeAborted extends CodeError {
  readonly _tag = "CodeAborted" as const;
  readonly contextId: string;
  readonly reason?: string;
  constructor(args: {
    readonly contextId: string;
    readonly reason?: string;
    readonly cause?: unknown;
  }) {
    super(
      `code execution on context ${args.contextId} was aborted${args.reason ? `: ${args.reason}` : ""}`,
      { cause: args.cause },
    );
    this.contextId = args.contextId;
    if (args.reason !== undefined) this.reason = args.reason;
  }
}
registerAgentickError("CodeAborted", CodeAborted);

export type CodeErrorChannel =
  | CodeProviderMissing
  | CodeBudgetUnsupported
  | CodeContextDisposed
  | CodeRuntimeFailed
  | CodeResultInvalid
  | CodeBindingNameConflict
  | CodeBindingNameInvalid
  | CodeRuntimeAlreadyBound
  | CodeHarnessClosed
  | CodeAborted;

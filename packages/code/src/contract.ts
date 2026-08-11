/**
 * The code contract — what a caller types against and what a provider
 * implements.
 *
 * It lives HERE rather than in `@agentick/spec` because nothing outside this
 * package names it: spec stays neutral about which harnesses exist (ADR 27),
 * the app reaches the harness as an opaque namespace value, and the session
 * never sees it at all. Provider packages (`@agentick/code-node`,
 * `@agentick/code-isolate`, …) depend on `@agentick/code` and implement
 * {@link Runtime} — the `sandbox-local → sandbox` relationship.
 *
 * Nothing in this module names a language. The capability is "run
 * model-authored code, safely, with bindings in scope, returning a value";
 * language, engine and isolation are properties of the PROVIDER, which is what
 * lets one slot and one conformance suite cover a subprocess runtime, an
 * in-process isolate and a runtime whose language is not JavaScript.
 *
 * Everything is async because at least one placement (a jail reached over a
 * socket) cannot answer synchronously; a sync contract would lie about it.
 */

import type { Effect } from "effect";
import type { HarnessFx, SubstrateError } from "@agentick/spec";

import type { CodeErrorChannel } from "./errors.js";

// ============================================================================
// Bindings — named async functions and values, injected as ambient names
// ============================================================================

/**
 * One binding: a named async function the program calls by name.
 *
 * Async is a TYPING contract, not a runtime check: every placement crosses
 * some boundary, so a sync binding cannot be honored at all of them, and the
 * signature says so. The harness does not police a cast — a caller who forces
 * a sync function through gets whatever their provider makes of it.
 */
export type CodeBinding = (input: unknown) => Promise<unknown>;

/** Data a binding can carry. JSON-shaped, because every placement is a membrane. */
export type CodeBindingScalar = string | number | boolean | null;

/**
 * One entry: a callable, a nested record, or data.
 *
 * There is deliberately no separate type for a data OBJECT — a plain record is
 * a namespace whether it holds functions or numbers, which is the same thing
 * the runtime rule says.
 *
 * A function NESTED in a namespace needs its parameter annotated
 * (`async (input: unknown) => …`), where a top-level one infers. TypeScript
 * declines to carry a contextual parameter type through a union member's index
 * signature, and "an entry is a callable OR a record" is that union.
 */
export type CodeBindingEntry =
  | CodeBinding
  | CodeBindings
  | readonly CodeBindingEntry[]
  | CodeBindingScalar;

/**
 * The context a program runs in — the `vm.createContext` model, not a schema.
 *
 * Every key is injected VERBATIM as an ambient name: a function becomes a
 * callable, a nested record becomes a frozen namespace of the same rule applied
 * again, anything else is a value. There are no reserved groups, because the
 * shape of what a program should reach is the caller's design, not the
 * framework's.
 *
 * ```ts
 * bindings: {
 *   tools: { search, fetch },   // tools.search(…)
 *   fs: { readFile },           // fs.readFile(…)
 *   tenantId,                   // tenantId
 * }
 * ```
 *
 * `tools` and `fs` are CONVENTIONS worth keeping — a model has strong priors
 * about what `tools.search(...)` and `fs.readFile(...)` do, and spending them
 * is free — but they are idioms in this sentence and nowhere in the types. Flat
 * is right where flat reads better.
 *
 * A nested record is a namespace whether you meant it as an API or as data, and
 * a program cannot tell the two apart; arrays and non-plain objects are always
 * values. Names must be plain identifiers and may not be `__proto__` /
 * `constructor` / `prototype`, **at every depth** (`CodeBindingNameInvalid`) —
 * these become ambient names and property paths in an engine, so the boundary
 * that sees all of them is the place to refuse a hostile one. That rule is also
 * what makes the audit record's dotted paths unambiguous: a key can never
 * contain the separator.
 */
export interface CodeBindings {
  readonly [name: string]: CodeBindingEntry;
}

// ============================================================================
// Budgets + capabilities
// ============================================================================

export type CodeBudgetKey = "timeMs" | "memoryMb" | "outputBytes";

/** Every {@link CodeBudgetKey}, for callers that must iterate the set. */
export const CODE_BUDGET_KEYS: readonly CodeBudgetKey[] = ["timeMs", "memoryMb", "outputBytes"];

/** Per-execution ceilings. Every field optional; an absent field is no ceiling. */
export interface CodeBudgets {
  readonly timeMs?: number;
  readonly memoryMb?: number;
  /** Combined stdout + stderr ceiling. Exceeding it TRUNCATES, never kills. */
  readonly outputBytes?: number;
}

/**
 * What a provider can actually do. A provider that cannot enforce a budget
 * MUST leave it out of {@link enforces} rather than accepting and ignoring it
 * — `createContext` then fails `CodeBudgetUnsupported` instead of pretending.
 * An honest "unsupported" beats a silent no-op (the sandbox capability-tiering
 * rule), and `runCodeConformance` asserts every declared capability is real.
 */
export interface CodeCapabilities {
  /** Provider discriminator — `"node"`, `"isolate"`. Diagnostic + journaled. */
  readonly name: string;
  readonly enforces: readonly CodeBudgetKey[];
  /**
   * Does state survive between executions on ONE context (the REPL axis)? A
   * provider that starts fresh per execute declares `false`.
   */
  readonly persistentContext: boolean;
}

// ============================================================================
// Result — the value is the answer; stdout is a side channel
// ============================================================================

export type CodeStream = "stdout" | "stderr";

/** What the program raised, projected to something serializable. */
export interface CodeThrown {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
}

/**
 * Observability every outcome carries. `stdout` / `stderr` are how a program
 * NARRATES; the value is how it ANSWERS. `truncated` names the streams cut at
 * the `outputBytes` ceiling — the one budget that shapes output instead of
 * ending the run, because discarding a computed answer over chatty logging is
 * the wrong trade.
 */
export interface CodeOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: readonly CodeStream[];
  readonly durationMs: number;
}

/** The program ran to completion and returned a value. */
export interface CodeReturned extends CodeOutput {
  readonly outcome: "returned";
  readonly value: unknown;
}

/** The program ran to completion and returned nothing. */
export interface CodeNoValue extends CodeOutput {
  readonly outcome: "no-value";
}

/**
 * The program itself raised. NOT a rejection: what the model's code threw is
 * an ANSWER the caller feeds back to the model, where a harness-level failure
 * (no provider, a dead membrane) is an exception. The discriminant keeps the
 * two apart without string-matching.
 */
export interface CodeThrew extends CodeOutput {
  readonly outcome: "threw";
  readonly error: CodeThrown;
}

/** A killing budget (`timeMs` / `memoryMb`) stopped the program mid-flight. */
export interface CodeBudgetExceeded extends CodeOutput {
  readonly outcome: "budget-exceeded";
  readonly budget: CodeBudgetKey;
  readonly limit: number;
}

export type CodeExecuteResult = CodeReturned | CodeNoValue | CodeThrew | CodeBudgetExceeded;

// ============================================================================
// Declared-command input (ADR 51) — the audit record
// ============================================================================

/**
 * Payload for `code:execute` — and therefore the journal entry for every
 * program the model ran. Data-only by construction: bindings live on the
 * context, so only their NAMES reach this envelope. A guard reads `source` to
 * decide; an auditor reads `source` to know; `codeHash` is the stable key that
 * correlates a program across runs (policy allowlists, dedupe, caching).
 */
export interface CodeExecuteInput {
  readonly contextId: string;
  readonly source: string;
  /** Hex SHA-256 of `source`. */
  readonly codeHash: string;
  /** Binding names in scope for this context. Never their functions or values. */
  readonly bindings: readonly string[];
  readonly budgets?: CodeBudgets;
}

// ============================================================================
// Handles — the harness side
// ============================================================================

/** What `createContext` / `run` accept. Both are per-context, not per-provider. */
export interface CodeContextOptions {
  readonly bindings?: CodeBindings;
  readonly budgets?: CodeBudgets;
  /**
   * Cancels this context's work. Aborting stops the in-flight program and
   * fails it `CodeAborted`; because `run` is a context used once, a signal
   * passed there bounds exactly one execution.
   *
   * It sits on the CONTEXT rather than on `execute` because that is where the
   * other non-serializable per-context things already live, and because the
   * alternative — a per-call signal — would have to reach the provider through
   * a hidden channel: `code:execute`'s input is the audit record, and a live
   * `AbortSignal` has no business in it.
   *
   * This is the caller's door. The framework's own is the operation fiber:
   * interrupting the enclosing op (a cancelled turn, an aborted tool dispatch)
   * aborts the program through the same path, with no signal passed here.
   */
  readonly signal?: AbortSignal;
}

/**
 * A live execution context — the harness-side handle. `execute` rides the
 * `code:execute` operation; the underlying provider context is reached only
 * through it. The REPL axis: executing twice on one context shares whatever
 * state the provider's {@link CodeCapabilities.persistentContext} claims.
 */
export interface CodeContext {
  readonly id: string;
  /** The names this context put in scope, sorted. */
  readonly bindings: readonly string[];
  /**
   * Run a program. Executions on ONE context are **serialized by the harness**:
   * a second call queues behind the first and observes its state, so the REPL
   * axis reads the same way against every provider instead of depending on
   * whether that engine happens to be reentrant.
   */
  execute(source: string): Promise<CodeExecuteResult>;
  /**
   * Idempotent. A second call is a no-op, not a failure.
   *
   * Disposing ABORTS whatever is running: in-flight executions settle
   * `CodeAborted`, and the provider's context is torn down only once they
   * have. Disposal never yanks a context out from under a running program.
   */
  dispose(): Promise<void>;
}

/**
 * What `run` takes: a program, plus exactly the bag `createContext` takes.
 *
 * ONE object, because a program passed positionally beside its options is the
 * odd verb out — every hook, guard and middleware in the house handles a single
 * input shape, and `run` was the one that made them special-case it. The field
 * is `source` and not `script` for the same reason: one vocabulary from `run`
 * through the command, the guard and the journal.
 *
 * It EXTENDS the context options rather than restating them, so the equivalence
 * stays literal — `run` is a context used once, and the type says so.
 */
export interface CodeRunInput extends CodeContextOptions {
  readonly source: string;
}

/**
 * What a caller may ASK for: a context and a program. Everything else in the
 * audit record is derived by the harness.
 */
export interface CodeExecuteRequest {
  readonly contextId: string;
  readonly source: string;
}

/**
 * The Effect twin of `code:execute` (ADR 77). A caller already inside an
 * operation — the code-mode tool dispatching a program — composes this with
 * `yield*` so the execute op parents under its dispatch instead of stranding a
 * fresh root fiber that inherits no identity.
 *
 * It takes a {@link CodeExecuteRequest}, NOT the {@link CodeExecuteInput} that
 * lands in the journal, and the difference is the whole point. The audit record
 * carries the digest of the source and the names in scope; if a caller could
 * supply those, the record would describe whatever program the caller said it
 * ran, and `guardCodeExecute` — which decides on exactly those fields — could
 * be handed an empty binding list and waved through. Both doors onto the
 * command derive them from the open context instead, and the command itself is
 * `exposure: "internal"`, so there is no third door.
 */
export interface CodeFx extends HarnessFx {
  execute(
    request: CodeExecuteRequest,
  ): Effect.Effect<CodeExecuteResult, CodeErrorChannel | SubstrateError, never>;
}

/**
 * The adopter-facing surface — what `session.code` and `ctx.code` are typed
 * as. `Code` is the name in prose and in slots; `CodeHarness` is the class.
 */
export interface Code {
  readonly id: string;
  readonly ready: Promise<void>;
  readonly fx: CodeFx;
  close(): Promise<void>;

  /** Is a runtime bound? The presence question, asked without provoking a throw. */
  hasRuntime(): boolean;
  /**
   * The bound provider's capabilities.
   *
   * @throws {CodeProviderMissing} no runtime is bound.
   */
  capabilities(): CodeCapabilities;

  /**
   * Open a context with `bindings` in scope and `budgets` in force.
   *
   * @throws {CodeProviderMissing} no runtime is bound.
   * @throws {CodeBudgetUnsupported} a budget the provider does not enforce.
   */
  createContext(options?: CodeContextOptions): Promise<CodeContext>;
  /** One-shot: a context opened, used once, and disposed. */
  run(input: CodeRunInput): Promise<CodeExecuteResult>;
}

/**
 * Structural guard for a live {@link Code} instance — how `withCode` and the
 * `code` namespace slot tell the ADR-42 dichotomy apart (live instance vs
 * declarative definition). Test the instance form first.
 */
export function isCodeInstance(v: unknown): v is Code {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.hasRuntime === "function" &&
    typeof obj.capabilities === "function" &&
    typeof obj.createContext === "function" &&
    typeof obj.run === "function"
  );
}

// ============================================================================
// The provider contract
// ============================================================================

/**
 * A bound, configured code runtime — the value `withCode({ runtime })` takes.
 *
 * The factory that produces one takes STABLE config (engine, isolation,
 * placement, permission drivers): the same for every execution in a session.
 * Per-execution concerns — which bindings are in scope, which ceilings apply —
 * sit on {@link createContext}, because they change per call. Binding the
 * runtime at config is also what lets `ctx.code.run(...)` reach it ambiently:
 * a per-call runtime argument would force every caller to know the engine.
 */
/**
 * What the harness guarantees a provider, so an implementation does not
 * re-check it: budgets are ones this provider declared it enforces; binding
 * names are unique across groups, are plain identifiers, and are none of
 * `__proto__` / `constructor` / `prototype`; and `execute` calls on one context
 * are SERIALIZED — a provider may assume no second execution starts before the
 * previous one settles.
 *
 * What the harness does on the way back: it NORMALIZES the result. A missing
 * `truncated`, an unknown `outcome`, a `returned` arm with no value — these are
 * contract violations and surface as `CodeResultInvalid`, so a caller never has
 * to defend against a malformed answer.
 */
export interface Runtime {
  readonly capabilities: CodeCapabilities;
  /**
   * Open an execution context. The harness has already rejected budgets this
   * provider does not declare, so an implementation may assume every budget it
   * receives is one it enforces.
   */
  createContext(options: CodeRuntimeContextOptions): Promise<CodeRuntimeContext>;
  /** Release provider-wide resources. Called once, on harness close. */
  dispose(): Promise<void>;
}

/** Named for its context, not the other way round — `RuntimeContextOptions` sits one letter from spec's own name-family. */
export interface CodeRuntimeContextOptions {
  readonly bindings?: CodeBindings;
  readonly budgets?: CodeBudgets;
}

/** Per-execution knobs that are live objects, so they never ride the audit record. */
export interface CodeExecuteOptions {
  /**
   * Stop the program. Merged by the harness from the caller's context signal
   * and the operation fiber's own, so a provider honors both through one
   * parameter.
   *
   * **Honoring this is mandatory, not a declared capability.** A runtime that
   * cannot stop a running program cannot enforce a `timeMs` budget either, and
   * a budget it cannot enforce is a lie it tells its caller — so the ability is
   * assumed of every provider and `runCodeConformance` pins it for all of them.
   * An implementation must both check `signal.aborted` up front AND register a
   * listener: a listener attached after the abort never fires.
   */
  readonly signal?: AbortSignal;
}

/**
 * One live provider context. `execute` runs source to completion and reports
 * HOW it ended through the {@link CodeExecuteResult} discriminant — a program
 * that throws returns `outcome: "threw"`; a rejection means the RUNTIME
 * failed.
 *
 * An abort is a REJECTION, not a fifth outcome, and the line is the same one
 * the outcomes draw: an outcome is what the program answered, and a cancelled
 * program answered nothing. Modeling it as an outcome would file "you stopped
 * this" alongside the results a caller feeds back to the model. Reject with
 * anything on an aborted signal — the harness recognizes the abort and raises
 * `CodeAborted` regardless of what the provider threw.
 *
 * Named `CodeRuntimeContext` rather than `RuntimeContext` because that name is
 * spec's, for the ambient operation context every harness already carries.
 */
export interface CodeRuntimeContext {
  execute(source: string, options?: CodeExecuteOptions): Promise<CodeExecuteResult>;
  /** Idempotent. */
  dispose(): Promise<void>;
}

/**
 * `fakeCode()` — a working in-memory {@link Runtime} for consumers' tests.
 *
 * Its "language" is a recorded instruction list, not a JavaScript evaluator:
 * a program is a JSON array of steps the fake interprets. That is the point.
 * The harness contract has to hold for a runtime whose language is nothing
 * like JavaScript, so the double that proves the contract must not be a JS
 * engine — if it were, every conformance claim would quietly be a claim about
 * `eval` instead of about the seam.
 *
 * It is a FAKE in the Meszaros sense: a real implementation with shortcuts.
 * `sleep` advances virtual time rather than blocking, and `allocate` is inert
 * (the fake declares it does not enforce `memoryMb`, and conformance holds it
 * to exactly what it declares).
 */

import type {
  CodeBinding,
  CodeBudgetKey,
  CodeBudgets,
  CodeCapabilities,
  CodeExecuteOptions,
  CodeExecuteResult,
  CodeRuntimeContext,
  CodeRuntimeContextOptions,
  CodeStream,
  Runtime,
} from "../contract.js";

/** One step of a fake program. {@link fakeCodeSource} builds these. */
export type FakeInstruction =
  | { readonly op: "print"; readonly stream: CodeStream; readonly text: string }
  | { readonly op: "call"; readonly binding: string; readonly input: unknown }
  | { readonly op: "value"; readonly name: string }
  | { readonly op: "remember"; readonly key: string; readonly value: unknown }
  | { readonly op: "recall"; readonly key: string }
  | { readonly op: "sleep"; readonly ms: number }
  | { readonly op: "allocate"; readonly mb: number }
  /** Runs until the execution's signal aborts. Nothing else ends it. */
  | { readonly op: "block" }
  | { readonly op: "throw"; readonly message: string }
  | { readonly op: "return"; readonly value: unknown }
  /** Return whatever the last `call` / `value` / `recall` produced. */
  | { readonly op: "return-last" };

export interface FakeCodeOptions {
  readonly name?: string;
  /** Budgets this fake claims — and therefore actually applies. */
  readonly enforces?: readonly CodeBudgetKey[];
  readonly persistentContext?: boolean;
}

/** Serialize instructions into the fake's source form. */
export function fakeProgram(...instructions: readonly FakeInstruction[]): string {
  return JSON.stringify(instructions);
}

/** What an aborted run rejects with — the reason if it is an Error, else one naming it. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`fakeCode: aborted (${String(signal.reason)})`);
}

export function fakeCode(options: FakeCodeOptions = {}): Runtime {
  const capabilities: CodeCapabilities = {
    name: options.name ?? "fake",
    enforces: options.enforces ?? ["timeMs", "outputBytes"],
    persistentContext: options.persistentContext ?? true,
  };
  let disposed = false;
  return {
    capabilities,
    createContext: async (init: CodeRuntimeContextOptions): Promise<CodeRuntimeContext> => {
      if (disposed) throw new Error("fakeCode: runtime disposed");
      return new FakeContext(capabilities, init);
    },
    dispose: async (): Promise<void> => {
      disposed = true;
    },
  };
}

// ============================================================================
// The interpreter
// ============================================================================

class FakeContext implements CodeRuntimeContext {
  private readonly bindings = new Map<string, CodeBinding>();
  private readonly values: Readonly<Record<string, unknown>>;
  private readonly budgets: CodeBudgets;
  private readonly state = new Map<string, unknown>();
  private readonly persistent: boolean;
  private closed = false;

  constructor(capabilities: CodeCapabilities, init: CodeRuntimeContextOptions) {
    for (const [name, fn] of Object.entries(init.bindings?.tools ?? {})) {
      this.bindings.set(name, fn);
    }
    for (const [name, fn] of Object.entries(init.bindings?.fs ?? {})) {
      this.bindings.set(name, fn);
    }
    this.values = init.bindings?.values ?? {};
    // Only budgets the fake declared reach here — the harness rejects the rest.
    this.budgets = init.budgets ?? {};
    this.persistent = capabilities.persistentContext;
  }

  async execute(source: string, options?: CodeExecuteOptions): Promise<CodeExecuteResult> {
    if (this.closed) throw new Error("fakeCode: context disposed");
    if (!this.persistent) this.state.clear();
    return new Run(this.bindings, this.values, this.state, this.budgets, options?.signal).of(
      source,
    );
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.state.clear();
  }
}

/** One execution: the output buffers, the virtual clock, the last value. */
class Run {
  private stdout = "";
  private stderr = "";
  private readonly truncated = new Set<CodeStream>();
  private elapsedMs = 0;
  private last: unknown;

  constructor(
    private readonly bindings: ReadonlyMap<string, CodeBinding>,
    private readonly values: Readonly<Record<string, unknown>>,
    private readonly state: Map<string, unknown>,
    private readonly budgets: CodeBudgets,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /**
   * A method, not an inline read: the signal is an external object that flips
   * DURING the run, and a second inline `signal?.aborted` check narrows against
   * the first one and compiles to a dead branch.
   */
  private isAborted(): boolean {
    return this.signal?.aborted === true;
  }

  async of(source: string): Promise<CodeExecuteResult> {
    if (this.isAborted()) throw abortReason(this.signal!);
    let program: readonly FakeInstruction[];
    try {
      program = JSON.parse(source) as readonly FakeInstruction[];
    } catch (cause) {
      return this.threw(`fakeCode: unreadable program (${String(cause)})`);
    }
    for (const step of program) {
      try {
        const answer = await this.step(step);
        if (answer !== undefined) return answer;
      } catch (cause) {
        // An abort is a REJECTION, never an outcome — a cancelled program
        // answered nothing, so folding it into `threw` would report a stopped
        // program as one that failed on its own.
        if (this.isAborted()) throw cause;
        return this.threw(cause instanceof Error ? cause.message : String(cause));
      }
    }
    return { outcome: "no-value", ...this.output() };
  }

  /** Runs one step. A returned result ENDS the program; `undefined` continues. */
  private async step(instruction: FakeInstruction): Promise<CodeExecuteResult | undefined> {
    switch (instruction.op) {
      case "print":
        this.write(instruction.stream, instruction.text);
        return undefined;
      case "call": {
        const binding = this.bindings.get(instruction.binding);
        if (binding === undefined) throw new Error(`unknown binding: ${instruction.binding}`);
        this.last = await binding(instruction.input);
        return undefined;
      }
      case "value":
        // `hasOwn`, not `in`: `in` walks the prototype chain, so a program
        // asking for `constructor` would be handed Object's.
        if (!Object.hasOwn(this.values, instruction.name)) {
          throw new Error(`unknown value: ${instruction.name}`);
        }
        this.last = this.values[instruction.name];
        return undefined;
      case "remember":
        this.state.set(instruction.key, instruction.value);
        return undefined;
      case "recall":
        this.last = this.state.get(instruction.key);
        return undefined;
      case "sleep":
        this.elapsedMs += instruction.ms;
        return this.overTime();
      case "allocate":
        return undefined;
      case "block":
        return await this.untilAborted();
      case "throw":
        return this.threw(instruction.message);
      case "return":
        return { outcome: "returned", value: instruction.value, ...this.output() };
      case "return-last":
        return { outcome: "returned", value: this.last, ...this.output() };
    }
  }

  /**
   * The blocking instruction. Checks `aborted` BEFORE registering, because a
   * listener attached after the abort never fires — the hazard that makes a
   * "hangs forever" bug indistinguishable from a slow program.
   */
  private untilAborted(): Promise<never> {
    return new Promise((_resolve, reject) => {
      const signal = this.signal;
      if (signal === undefined) {
        reject(new Error("fakeCode: `block` needs a signal, and none was threaded"));
        return;
      }
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
    });
  }

  /**
   * `outputBytes` truncates and lets the program finish; it never kills. The
   * ceiling is COMBINED across both streams, as the contract says — a
   * per-stream reading would let a program emit twice its budget.
   */
  private write(stream: CodeStream, text: string): void {
    const limit = this.budgets.outputBytes;
    if (limit === undefined) {
      if (stream === "stdout") this.stdout += text;
      else this.stderr += text;
      return;
    }
    const remaining = limit - (this.stdout.length + this.stderr.length);
    const kept = text.slice(0, Math.max(0, remaining));
    if (kept.length < text.length) this.truncated.add(stream);
    if (stream === "stdout") this.stdout += kept;
    else this.stderr += kept;
  }

  private overTime(): CodeExecuteResult | undefined {
    const limit = this.budgets.timeMs;
    if (limit === undefined || this.elapsedMs <= limit) return undefined;
    return { outcome: "budget-exceeded", budget: "timeMs", limit, ...this.output() };
  }

  private threw(message: string): CodeExecuteResult {
    return { outcome: "threw", error: { message, name: "FakeProgramError" }, ...this.output() };
  }

  private output(): {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: readonly CodeStream[];
    readonly durationMs: number;
  } {
    return {
      stdout: this.stdout,
      stderr: this.stderr,
      truncated: [...this.truncated],
      durationMs: this.elapsedMs,
    };
  }
}

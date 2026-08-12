/**
 * One V8 isolate + one context, warm across executes (`persistentContext`).
 *
 * The isolate is furnished with NOTHING by default — no `require`, no `process`,
 * no `fetch`, no host global. The only reachable surface is what the bootstrap
 * wires: the injected bindings, their values, and a `console` that writes to a
 * captured buffer. That is containment by construction.
 */

import ivm from "isolated-vm";
import { flattenBindings } from "@agentick/code";
import type {
  CodeBinding,
  CodeBudgets,
  CodeExecuteOptions,
  CodeExecuteResult,
  CodeRuntimeContext,
  CodeRuntimeContextOptions,
  CodeStream,
  CodeThrown,
} from "@agentick/code";

import { DEFAULT_MEMORY_LIMIT_MB } from "./capabilities.js";
import type { Compiled } from "./language.js";

/**
 * Turns the injected references into ambient names. Runs once, trusted, at
 * context creation. Each function becomes an async wrapper that marshals its
 * argument out as a copy and awaits the host's answer as a copy; each value is
 * the deep copy already placed on the global; namespaces are frozen so a
 * program cannot swap what it was handed. The raw references are deleted so the
 * only door left is the friendly one.
 */
const BOOTSTRAP = `(() => {
  const dispatch = __agentick_dispatch;
  const write = __agentick_write;
  const paths = __agentick_fnPaths;
  const values = __agentick_values;

  const call = (name) => (input) =>
    dispatch.apply(undefined, [name, input], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    });

  const put = (path, leaf) => {
    const parts = path.split(".");
    let node = globalThis;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = leaf;
  };

  for (const key of Object.keys(values)) globalThis[key] = values[key];
  for (const path of paths) put(path, call(path));

  const roots = new Set();
  for (const path of paths) roots.add(path.split(".")[0]);
  for (const key of Object.keys(values)) roots.add(key);
  const freeze = (o) => {
    if (o !== null && typeof o === "object") {
      for (const k of Object.keys(o)) freeze(o[k]);
      Object.freeze(o);
    }
  };
  for (const r of roots) freeze(globalThis[r]);

  const line = (a) => a.map(String).join(" ") + "\\n";
  globalThis.console = Object.freeze({
    log: (...a) => write("stdout", line(a)),
    info: (...a) => write("stdout", line(a)),
    debug: (...a) => write("stdout", line(a)),
    warn: (...a) => write("stderr", line(a)),
    error: (...a) => write("stderr", line(a)),
  });

  delete globalThis.__agentick_dispatch;
  delete globalThis.__agentick_write;
  delete globalThis.__agentick_fnPaths;
  delete globalThis.__agentick_values;
})();`;

/** The shape the in-isolate wrapper resolves to; the host turns it into a result. */
type IsolateOutcome =
  | { readonly outcome: "no-value" }
  | { readonly outcome: "returned"; readonly value: unknown }
  | { readonly outcome: "threw"; readonly error: CodeThrown };

interface InFlight {
  readonly startedAt: number;
  readonly out: string[];
  readonly err: string[];
}

export class IsolateContext implements CodeRuntimeContext {
  private inFlight: InFlight | undefined;
  private functions: ReadonlyMap<string, CodeBinding> = new Map();
  private dead: string | undefined;
  private disposed = false;
  private gone: (() => void) | undefined;

  private constructor(
    private readonly isolate: ivm.Isolate,
    private readonly context: ivm.Context,
    private readonly providerName: string,
    private readonly compile: (source: string) => Promise<Compiled>,
    private readonly budgets: CodeBudgets,
    private readonly memoryLimitMb: number,
  ) {}

  static async create(
    providerName: string,
    compile: (source: string) => Promise<Compiled>,
    config: { readonly memoryLimitMb?: number },
    options: CodeRuntimeContextOptions,
  ): Promise<IsolateContext> {
    const memoryLimitMb =
      options.budgets?.memoryMb ?? config.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
    const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
    const context = await isolate.createContext();
    const self = new IsolateContext(
      isolate,
      context,
      providerName,
      compile,
      options.budgets ?? {},
      memoryLimitMb,
    );
    await self.wire(options.bindings);
    return self;
  }

  private async wire(bindings: CodeRuntimeContextOptions["bindings"]): Promise<void> {
    const flat = flattenBindings(bindings);
    this.functions = flat.functions;

    const global = this.context.global;
    await global.set("__agentick_dispatch", new ivm.Reference(this.serveBinding));
    await global.set("__agentick_write", new ivm.Callback(this.writeStream, { sync: true }));
    await global.set(
      "__agentick_fnPaths",
      new ivm.ExternalCopy([...flat.functions.keys()]).copyInto(),
    );
    await global.set("__agentick_values", new ivm.ExternalCopy(flat.values).copyInto());

    const boot = await this.isolate.compileScript(BOOTSTRAP);
    await boot.run(this.context);
  }

  async execute(source: string, options?: CodeExecuteOptions): Promise<CodeExecuteResult> {
    if (this.dead !== undefined) throw new Error(`${this.providerName}: ${this.dead}`);
    const signal = options?.signal;
    if (signal?.aborted === true) throw abortError(signal);

    const compiled = await this.compile(source);
    const run: InFlight = { startedAt: Date.now(), out: [], err: [] };
    this.inFlight = run;
    try {
      if (!compiled.ok) return didNotParse(compiled.message, run);

      let script: ivm.Script;
      try {
        script = await this.isolate.compileScript(compiled.source);
      } catch (cause) {
        return didNotParse(messageOf(cause), run);
      }

      let killedFor: "abort" | undefined;
      let abortCause: Error | undefined;
      const onAbort = (): void => {
        killedFor = "abort";
        abortCause = abortError(signal!);
        this.terminate("the isolate was terminated by an abort");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const outcome = (await script.run(this.context, {
          promise: true,
          copy: true,
          ...(this.budgets.timeMs === undefined ? {} : { timeout: this.budgets.timeMs }),
        })) as IsolateOutcome;
        return this.settle(outcome, run);
      } catch (cause) {
        if (killedFor === "abort") throw abortCause ?? abortError(signal!);
        if (isTimeout(cause) && this.budgets.timeMs !== undefined) {
          return exceeded("timeMs", this.budgets.timeMs, run);
        }
        if (isMemoryLimit(cause) || this.isolate.isDisposed) {
          this.dead ??= "the isolate hit its memory limit — this context is dead; open another";
          return exceeded("memoryMb", this.budgets.memoryMb ?? this.memoryLimitMb, run);
        }
        throw new Error(`${this.providerName}: ${messageOf(cause)}`, { cause });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      this.inFlight = undefined;
    }
  }

  /** Told when the isolate is torn down, whether by dispose, abort, or memory. */
  whenGone(listen: () => void): void {
    this.gone = listen;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.terminate("disposed");
  }

  private terminate(reason: string): void {
    this.dead ??= `${reason} — this context is dead; open another`;
    this.gone?.();
    if (!this.isolate.isDisposed) {
      try {
        this.isolate.dispose();
      } catch {
        // A dispose racing the engine's own teardown is already what we wanted.
      }
    }
  }

  /** A binding runs HERE, on the host. Only its copied answer crosses back. */
  private serveBinding = async (name: unknown, input: unknown): Promise<unknown> => {
    const fn = this.functions.get(name as string);
    if (fn === undefined) throw new Error(`unknown binding: ${String(name)}`);
    return fn(input);
  };

  private writeStream = (stream: unknown, text: unknown): void => {
    const run = this.inFlight;
    if (run === undefined) return;
    (stream === "stderr" ? run.err : run.out).push(String(text));
  };

  private settle(outcome: IsolateOutcome, run: InFlight): CodeExecuteResult {
    switch (outcome.outcome) {
      case "no-value":
        return { outcome: "no-value", ...output(run) };
      case "returned":
        return { outcome: "returned", value: outcome.value, ...output(run) };
      case "threw":
        return { outcome: "threw", error: outcome.error, ...output(run) };
    }
  }
}

interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: readonly CodeStream[];
  readonly durationMs: number;
}

function output(run: InFlight): CapturedOutput {
  return {
    stdout: run.out.join(""),
    stderr: run.err.join(""),
    truncated: [],
    durationMs: Date.now() - run.startedAt,
  };
}

function didNotParse(message: string, run: InFlight): CodeExecuteResult {
  return { outcome: "threw", error: { name: "SyntaxError", message }, ...output(run) };
}

function exceeded(budget: "timeMs" | "memoryMb", limit: number, run: InFlight): CodeExecuteResult {
  return { outcome: "budget-exceeded", budget, limit, ...output(run) };
}

function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && /timed out/i.test(cause.message);
}

function isMemoryLimit(cause: unknown): boolean {
  return cause instanceof Error && /memory limit/i.test(cause.message);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`code-secure-exec: aborted (${String(signal.reason)})`);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

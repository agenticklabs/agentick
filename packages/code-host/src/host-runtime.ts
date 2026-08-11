/**
 * `hostRuntime()` — the host-engine-adaptive subprocess {@link Runtime}.
 *
 * One child process per context, running `process.execPath`: the engine
 * executing model-authored code is by construction the engine the adopter
 * already trusts to run their app. There is no containment here — see the
 * package README on placement.
 *
 * @see ./supervisor.js — the child
 * @see ./host-process-port.ts — where the child is placed
 */

import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { flattenBindings } from "@agentick/code";
import type {
  CodeBinding,
  CodeBindings,
  CodeBudgets,
  CodeExecuteOptions,
  CodeExecuteResult,
  CodeRuntimeContext,
  CodeRuntimeContextOptions,
  CodeStream,
  Runtime,
} from "@agentick/code";

import { detectEngine, hostCapabilities, type HostEngine } from "./engine.js";
import { childProcessPort, type HostProcess, type HostProcessPort } from "./host-process-port.js";
import { frameReader, type DoneFrame, type FrameFromChild } from "./protocol.js";

export interface HostRuntimeConfig {
  /** Where the child is placed. Default: a direct child of this process. */
  readonly host?: HostProcessPort;
  /** The child's environment. Default: empty — a program inherits no secrets. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Extra engine flags, passed before the supervisor path. */
  readonly execArgv?: readonly string[];
  /** How long the child has to answer the handshake. Default 10s. */
  readonly spawnTimeoutMs?: number;
}

const SUPERVISOR = fileURLToPath(new URL("./supervisor.js", import.meta.url));
const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;
/** How long a child gets to leave on its own before the signal. */
const GRACE_MS = 100;
const HEAP_EXHAUSTED = "JavaScript heap out of memory";

export function hostRuntime(config: HostRuntimeConfig = {}): Runtime {
  const engine = detectEngine();
  const capabilities = hostCapabilities(engine);
  const open = new Set<HostContext>();
  let disposed = false;

  return {
    capabilities,
    createContext: async (options: CodeRuntimeContextOptions): Promise<CodeRuntimeContext> => {
      if (disposed) throw new Error(`${capabilities.name}: the runtime is disposed`);
      const context = await HostContext.start(engine, capabilities.name, config, options);
      open.add(context);
      context.whenGone(() => open.delete(context));
      return context;
    },
    dispose: async (): Promise<void> => {
      disposed = true;
      await Promise.all([...open].map((context) => context.dispose()));
    },
  };
}

/** One execution: its captured output, its ceiling, and how it will settle. */
interface InFlight {
  readonly id: number;
  readonly startedAt: number;
  readonly settle: (result: CodeExecuteResult) => void;
  readonly fail: (cause: Error) => void;
  readonly out: StreamCapture;
  readonly err: StreamCapture;
  readonly truncated: Set<CodeStream>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Why WE killed the child — the classification its exit will need. */
  killedFor?: "timeMs" | "abort";
  abortCause?: Error;
}

/** A decoder per stream, so a multi-byte character split across chunks survives. */
interface StreamCapture {
  readonly decoder: StringDecoder;
  text: string;
}

function capture(): StreamCapture {
  return { decoder: new StringDecoder("utf8"), text: "" };
}

class HostContext implements CodeRuntimeContext {
  /** Keyed by DOTTED PATH — the name the child calls back with. */
  private bindings: ReadonlyMap<string, CodeBinding> = new Map();
  private values: Readonly<Record<string, unknown>> = {};
  private exited!: Promise<void>;
  private ready: (() => void) | undefined;
  private readyFailed: ((cause: Error) => void) | undefined;
  private gone: (() => void) | undefined;
  private inFlight: InFlight | undefined;
  private nextExecId = 0;
  private heapExhausted = false;
  private stderrTail = "";
  private disposed = false;
  /** Set once the child is gone: the context died with it. */
  private dead: string | undefined;

  private constructor(
    private readonly proc: HostProcess,
    private readonly providerName: string,
    private readonly budgets: CodeBudgets,
  ) {}

  static async start(
    engine: HostEngine,
    providerName: string,
    config: HostRuntimeConfig,
    options: CodeRuntimeContextOptions,
  ): Promise<HostContext> {
    const memoryMb = options.budgets?.memoryMb;
    const heapFlag = memoryMb === undefined ? undefined : engine.heapLimitFlag?.(memoryMb);
    const proc = (config.host ?? childProcessPort()).spawn({
      command: engine.execPath,
      args: [...(config.execArgv ?? []), ...(heapFlag === undefined ? [] : [heapFlag]), SUPERVISOR],
      env: config.env ?? {},
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    });

    const context = new HostContext(proc, providerName, options.budgets ?? {});
    context.listen(options.bindings);
    await context.handshake(config.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
    return context;
  }

  /** Told when the child dies or the context is disposed, whichever comes first. */
  whenGone(listen: () => void): void {
    this.gone = listen;
  }

  async execute(source: string, options?: CodeExecuteOptions): Promise<CodeExecuteResult> {
    if (this.dead !== undefined) throw new Error(`${this.providerName}: ${this.dead}`);
    const signal = options?.signal;
    // Both doors, because a listener attached after the abort never fires.
    if (signal?.aborted === true) throw abortError(signal);

    return new Promise<CodeExecuteResult>((resolve, reject) => {
      const finished = (): void => {
        if (run.timer !== undefined) clearTimeout(run.timer);
        signal?.removeEventListener("abort", onAbort);
        this.inFlight = undefined;
      };
      const run: InFlight = {
        id: ++this.nextExecId,
        startedAt: Date.now(),
        out: capture(),
        err: capture(),
        truncated: new Set(),
        bytes: 0,
        settle: (result) => {
          finished();
          resolve(result);
        },
        fail: (cause) => {
          finished();
          reject(cause);
        },
      };
      const onAbort = (): void => {
        run.killedFor = "abort";
        run.abortCause = abortError(signal!);
        this.proc.kill("SIGKILL");
      };

      this.inFlight = run;
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeMs = this.budgets.timeMs;
      if (timeMs !== undefined) {
        run.timer = setTimeout(() => {
          run.killedFor = "timeMs";
          this.proc.kill("SIGKILL");
        }, timeMs);
      }
      this.send({ t: "exec", id: run.id, source });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.gone?.();
    if (this.dead !== undefined) return;
    // Ask, then insist: closing the control input is the child's cue to leave,
    // and a program still holding the loop open gets GRACE_MS before the signal.
    this.proc.endControl();
    await Promise.race([this.exited, after(GRACE_MS)]);
    if (this.dead === undefined) this.proc.kill("SIGKILL");
    await this.exited;
  }

  // ─────────── Wiring ───────────

  private listen(bindings: CodeBindings | undefined): void {
    const flat = flattenBindings(bindings);
    this.bindings = flat.functions;
    this.values = flat.values;

    this.proc.onStdout((chunk) => this.absorb("stdout", chunk));
    this.proc.onStderr((chunk) => this.absorb("stderr", chunk));
    const read = frameReader((frame) => this.receive(frame));
    this.proc.onControl((chunk) => {
      try {
        read(chunk);
      } catch (cause) {
        this.die(`the control channel lost framing (${messageOf(cause)})`);
      }
    });
    this.exited = new Promise<void>((resolve) => {
      this.proc.onExit((code, signal) => {
        this.die(`the child exited (code ${String(code)}, signal ${String(signal)})`);
        resolve();
      });
    });
  }

  private async handshake(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<void>((resolve, reject) => {
      this.ready = resolve;
      this.readyFailed = reject;
      timer = setTimeout(
        () => reject(new Error(`${this.providerName}: the child never reported ready`)),
        timeoutMs,
      );
    });
    try {
      this.send({ t: "init", fns: [...this.bindings.keys()], values: this.values });
      await answered;
    } catch (cause) {
      this.proc.kill("SIGKILL");
      throw cause;
    } finally {
      clearTimeout(timer);
      this.readyFailed = undefined;
    }
  }

  private receive(frame: FrameFromChild): void {
    switch (frame.t) {
      case "ready":
        this.ready?.();
        return;
      case "call":
        void this.serveBinding(frame.callId, frame.name, frame.input);
        return;
      case "done":
        this.finish(frame);
    }
  }

  /** A binding runs HERE. Only its JSON answer crosses back. */
  private async serveBinding(callId: number, name: string, input: unknown): Promise<void> {
    const fn = this.bindings.get(name);
    if (fn === undefined) {
      this.refuseCall(callId, `unknown binding: ${name}`);
      return;
    }
    try {
      const value = await fn(input);
      try {
        this.send({ t: "call-return", callId, ok: true, value });
      } catch (cause) {
        // The binding answered; the membrane could not carry it. The program
        // hears that as a rejection it can catch, because the alternative is
        // an unhandled rejection in the HOST over a value the host chose.
        this.refuseCall(
          callId,
          `the binding's answer could not cross as JSON (${messageOf(cause)})`,
        );
      }
    } catch (cause) {
      this.refuseCall(callId, messageOf(cause));
    }
  }

  private refuseCall(callId: number, error: string): void {
    this.send({ t: "call-return", callId, ok: false, error });
  }

  /**
   * The answer arrives on the control channel while the program's last bytes
   * are still crossing fds 1 and 2. The child flushes before it sends, so one
   * turn of the loop is what those bytes need to land.
   */
  private finish(frame: DoneFrame): void {
    const run = this.inFlight;
    if (run === undefined || run.id !== frame.id) return;
    setImmediate(() => {
      switch (frame.outcome) {
        case "returned":
          run.settle({ outcome: "returned", value: frame.value, ...output(run) });
          return;
        case "no-value":
          run.settle({ outcome: "no-value", ...output(run) });
          return;
        case "threw":
          run.settle({ outcome: "threw", error: frame.error, ...output(run) });
          return;
        case "unmarshalable":
          run.fail(
            new Error(
              `${this.providerName}: the program's value could not cross as JSON (${frame.detail})`,
            ),
          );
      }
    });
  }

  /**
   * Everything the child emits, cut at the combined `outputBytes` ceiling. The
   * cut is here and not in the child because the parent must keep draining
   * either way — a full pipe would stall the very program this budget exists
   * to let finish.
   */
  private absorb(stream: CodeStream, chunk: Buffer): void {
    this.watchForHeapExhaustion(stream, chunk);
    const run = this.inFlight;
    // Output from a stray timer belongs to no execution.
    if (run === undefined) return;
    const limit = this.budgets.outputBytes;
    const room = limit === undefined ? chunk.length : Math.max(0, limit - run.bytes);
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
    if (kept.length < chunk.length) run.truncated.add(stream);
    run.bytes += kept.length;
    const into = stream === "stdout" ? run.out : run.err;
    into.text += into.decoder.write(kept);
  }

  /**
   * The evidence that a dead child died of `memoryMb` and not of its own
   * `process.exit`. Read from the RAW stream, ahead of the output ceiling, and
   * never surfaced: a budget verdict must not depend on how chatty the program
   * was allowed to be.
   */
  private watchForHeapExhaustion(stream: CodeStream, chunk: Buffer): void {
    if (stream !== "stderr" || this.heapExhausted || this.budgets.memoryMb === undefined) return;
    const seen = this.stderrTail + chunk.toString("utf8");
    if (seen.includes(HEAP_EXHAUSTED)) this.heapExhausted = true;
    // The carry only has to span a chunk boundary — V8 prints a long stack
    // trace AFTER the marker, so a window kept for its own sake would lose it.
    this.stderrTail = seen.slice(1 - HEAP_EXHAUSTED.length);
  }

  /**
   * The child is gone, so the context is too. Its state lived in that process,
   * and quietly starting a fresh one would answer the next program with an
   * empty world while still claiming `persistentContext`.
   */
  private die(reason: string): void {
    if (this.dead !== undefined) return;
    this.dead = `${reason} — this context is dead; open another`;
    this.gone?.();
    this.readyFailed?.(new Error(`${this.providerName}: ${reason}`));
    const run = this.inFlight;
    if (run === undefined) return;
    if (run.killedFor === "abort") {
      run.fail(run.abortCause ?? new Error(`${this.providerName}: aborted`));
      return;
    }
    if (run.killedFor === "timeMs") {
      run.settle(exceeded("timeMs", this.budgets.timeMs ?? 0, run));
      return;
    }
    if (this.heapExhausted) {
      run.settle(exceeded("memoryMb", this.budgets.memoryMb ?? 0, run));
      return;
    }
    run.fail(new Error(`${this.providerName}: ${reason}`));
  }

  private send(frame: object): void {
    this.proc.writeControl(`${JSON.stringify(frame)}\n`);
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
    stdout: run.out.text,
    stderr: run.err.text,
    truncated: [...run.truncated],
    durationMs: Date.now() - run.startedAt,
  };
}

function exceeded(budget: "timeMs" | "memoryMb", limit: number, run: InFlight): CodeExecuteResult {
  return { outcome: "budget-exceeded", budget, limit, ...output(run) };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`code-host: aborted (${String(signal.reason)})`);
}

function after(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

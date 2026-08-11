/**
 * The README's examples, compiled. The house rule is that a README example must
 * typecheck against the CURRENT exports, and `tsc -p tsconfig.json` covers this
 * directory — so this file is the enforcement, not a courtesy.
 *
 * No assertions: the value is the compile.
 */

import { describe, it } from "vitest";
import {
  defineCode,
  withCode,
  type Code,
  type CodeExecuteResult,
  type CodeRuntimeContext,
  type Runtime,
} from "../index.js";
import {
  fakeCode,
  fakeCodeSource,
  runCodeConformance,
  type CodeConformanceProbe,
} from "../testing/index.js";
import { CodeHarness } from "../harness.js";
import type { EventBus, MessageInbox, OperationJournal } from "@agentick/spec";

declare const session: {
  readonly code?: Code;
  readonly tools: { dispatch(name: string, input: unknown): Promise<unknown> };
  readonly resources?: { read(uri: string): Promise<unknown> };
};
declare const source: string;
declare const tenantId: string;
declare const MAX_PROGRAM_BYTES: number;
declare const existingCodeHarness: Code;

// ── Quick start
declare const model: unknown;
declare function createApp(agent: unknown, options: Record<string, unknown>): Promise<unknown>;
declare const hostRuntime: (config?: { readonly cwd?: string }) => Runtime;
declare const recall: (input: unknown) => Promise<unknown>;

async function mountingForms(): Promise<void> {
  await createApp(null, { model, code: {} });
  await createApp(null, {
    model,
    code: defineCode({ runtime: hostRuntime({ cwd: "/srv/scratch" }) }),
  });
  await createApp(null, {
    model,
    code: defineCode({
      bindings: { tools: { recall }, tenantId },
      budgets: { timeMs: 5_000, outputBytes: 64_000 },
    }),
  });
  defineCode();
  withCode();
}
defineCode({ runtime: fakeCode() });

async function quickStart(): Promise<void> {
  const code = session.code;
  if (!code) throw new Error("no code runtime is mounted");

  const result = await code.execute({
    source,
    bindings: {
      tools: { recall: (input: unknown) => session.tools.dispatch("recall", input) },
      tenantId,
    },
    budgets: { timeMs: 5_000, outputBytes: 64_000 },
  });
  if (result.outcome === "returned") void result.value;

  // ── The value is the answer
  void result.stdout;
  void result.stderr;
  void result.truncated;
  switch (result.outcome) {
    case "returned":
      void result.value;
      break;
    case "no-value":
      break;
    case "threw":
      void result.error.message;
      break;
    case "budget-exceeded":
      void `${result.budget}${result.limit}`;
      break;
  }

  // ── Contexts, and the one-shot
  const context = await code.createContext({});
  try {
    await context.execute(source);
  } finally {
    await context.dispose();
  }

  // ── Budgets
  code.capabilities();
  await code.createContext({ budgets: { memoryMb: 64 } });

  // ── Stopping a program
  const controller = new AbortController();
  const running = code.execute({ source, signal: controller.signal });
  controller.abort("the user navigated away");
  await running;
}

// ── Bindings are the program's context
async function bindingsAreContext(): Promise<void> {
  const code = session.code!;
  await code.execute({
    source: `
      const hits = await tools.recall({ q: "invoices", tenantId });
      const notes = await fs.readFile("/notes/latest.md");
      return { hits: hits.length, notes };
    `,
    bindings: {
      tools: { recall: (input: unknown) => session.tools.dispatch("recall", input) },
      fs: { readFile: (path: unknown) => session.resources!.read(String(path)) },
      tenantId,
      today: new Date().toISOString(),
    },
  });
}

// ── Running TypeScript
declare const hostRuntimeTs: (config: { readonly language: "typescript" }) => Runtime;

async function runningTypescript(): Promise<void> {
  createApp(null, { code: defineCode({ runtime: hostRuntimeTs({ language: "typescript" }) }) });

  const code = session.code!;
  await code.execute({
    source: `
      interface Order { id: string; dueAt: string; shippedAt: string }
      const rows = (await tools.query({ table: "orders" })) as Order[];
      const late: Order[] = rows.filter((row) => row.shippedAt > row.dueAt);
      return { late: late.length };
    `,
  });
  void code.capabilities().name;
}

declare function lint(source: string): readonly { readonly message: string }[];
declare function lintFix(source: string): Promise<string>;
declare function format(source: string): Promise<string>;
declare function instrument(source: string): string;

// ── Pre-run pipelines
function pipelines(): void {
  const codeHarness = session.code as CodeHarness;

  codeHarness.hook({
    onBeforeCodeExecute: async (input) => {
      const fixed = await lintFix(input.source);
      return { ...input, source: fixed };
    },
  });

  codeHarness.hook({
    onBeforeCodeExecute: async (input) => ({ ...input, source: await format(input.source) }),
  });
  codeHarness.hook({
    onBeforeCodeExecute: async (input) => ({ ...input, source: instrument(input.source) }),
  });

  codeHarness.hook({
    onBeforeCodeExecute: (input, ctx) => {
      const findings = lint(input.source);
      if (findings.length > 0) ctx.log.warn({ msg: "lint findings", count: findings.length });
    },
  });

  codeHarness.hook({
    onCodeExecute: async (input, next, ctx) => {
      const startedAt = Date.now();
      try {
        return await next(input);
      } finally {
        ctx.log.info({ msg: "program finished", ms: Date.now() - startedAt });
      }
    },
  });

  codeHarness.guard({
    codeExecute: (input) =>
      input.source.includes("child_process")
        ? { kind: "veto", reason: "no subprocess spawning" }
        : { kind: "proceed" },
  });

  codeHarness.guard({
    codeExecute: (input) => {
      if (input.bindings.includes("tools.deleteAll")) {
        return { kind: "veto", reason: "destructive binding in scope" };
      }
      if (input.source.length > MAX_PROGRAM_BYTES) {
        return { kind: "veto", reason: "program too large to review" };
      }
    },
  });

  codeHarness.guard({
    codeExecute: (input) => {
      const findings = lint(input.source);
      if (findings.length > 0) return { kind: "veto", reason: `lint: ${findings[0]!.message}` };
    },
  });
}

// ── Writing a runtime
declare function spawnEngine(
  config: unknown,
  bindings: unknown,
  budgets: unknown,
): Promise<{
  run(source: string, signal?: AbortSignal): Promise<CodeExecuteResult>;
  kill(): Promise<void>;
}>;

function myRuntime(config: unknown): Runtime {
  return {
    capabilities: { name: "mine", enforces: ["timeMs"], persistentContext: false },
    async createContext({ bindings, budgets }): Promise<CodeRuntimeContext> {
      const child = await spawnEngine(config, bindings, budgets);
      return {
        execute: (src, options) => child.run(src, options?.signal),
        dispose: () => child.kill(),
      };
    },
    async dispose() {},
  };
}

// ── Mounting
function mounting(): void {
  withCode({ runtime: fakeCode() });
  withCode(existingCodeHarness);
  defineCode({ runtime: fakeCode() });
}

// ── Presence, in three states
declare const id: string;
declare const journal: OperationJournal;
declare const bus: EventBus;
declare const inbox: MessageInbox;
declare function chooseRuntime(): Promise<Runtime>;

async function presence(): Promise<void> {
  const harness = new CodeHarness(id, journal, bus, inbox);
  withCode(harness);
  harness.bindRuntime(await chooseRuntime());
}

// ── Certifying a runtime. Declared, not run: the point is that the whole
// vocabulary literal on the page still satisfies the probe type — a required
// entry added to the contract must break HERE, not in an adopter's repo.
declare const config: unknown;
const readmeProbe: CodeConformanceProbe = {
  label: "myRuntime",
  makeRuntime: () => myRuntime(config),
  source: {
    returns: (value) => `return ${JSON.stringify(value)}`,
    noValue: () => `;`,
    throws: (message) => `throw new Error(${JSON.stringify(message)})`,
    callsBinding: (name, input) => `return await ${name}(${JSON.stringify(input)})`,
    readsValue: (name) => `return ${name}`,
    swapsBinding: (name) => `try { ${name} = null } catch {} return await ${name}({})`,
    writes: (stream, text) =>
      `console.${stream === "stdout" ? "log" : "error"}(${JSON.stringify(text)}); return "done"`,
    blocks: () => `await new Promise(() => {})`,
    exceeds: (budget, limit) => (budget === "timeMs" ? `await sleep(${limit * 2})` : `…`),
  },
};

void bindingsAreContext;
void mountingForms;
void mounting;
void presence;
void readmeProbe;
void runCodeConformance;
void myRuntime;
void pipelines;
void runningTypescript;
void quickStart;
void fakeCodeSource;

describe("README examples", () => {
  it("compile against the current exports", () => {});
});

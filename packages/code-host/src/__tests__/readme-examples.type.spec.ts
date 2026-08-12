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
  type CodeExecuteInput,
  type CodeHarness,
  type Runtime,
} from "@agentick/code";
import { runCodeConformance } from "@agentick/code/testing";

import { localProvider } from "@agentick/sandbox-local";

import { hostRuntime, sandboxHost, transpiler } from "../index.js";
import { hostCodeProbe, hostCodeSource, hostRuntimeInstance } from "../testing/index.js";

declare const session: {
  readonly code?: Code;
  readonly tools: { dispatch(name: string, input: unknown): Promise<unknown> };
  readonly resources?: { read(uri: string): Promise<unknown> };
};
declare const tenantId: string;
declare const chattyProgram: string;
declare function myWrapperAround(runtime: Runtime): Runtime;

// ── Quick start
declare const model: unknown;
declare function createApp(agent: unknown, options: Record<string, unknown>): Promise<unknown>;

async function mountingForms(): Promise<void> {
  await createApp(null, { model, code: {} });
  await createApp(null, {
    model,
    extensions: [withCode({ runtime: hostRuntime({ cwd: "/srv/scratch" }) })],
  });
}
withCode({ runtime: hostRuntime() });

async function quickStart(): Promise<void> {
  const code = session.code!;

  const result = await code.execute({
    source: `
      const rows = await tools.query({ table: "orders", since });
      const late = rows.filter((row) => row.shippedAt > row.dueAt);
      return { late: late.length };
    `,
    bindings: {
      tools: { query: (input: unknown) => session.tools.dispatch("query", input) },
      since: "2026-01-01",
    },
    budgets: { timeMs: 5_000, outputBytes: 64_000 },
  });

  if (result.outcome === "returned") console.log(result.value);
}

// ── Running TypeScript
hostRuntime({ language: "typescript" });

async function typescriptMode(): Promise<void> {
  const code = session.code!;
  await code.execute({
    source: `
      interface Order { id: string; dueAt: string; shippedAt: string }
      const rows = (await tools.query({ table: "orders", since })) as Order[];
      const late: Order[] = rows.filter((row) => row.shippedAt > row.dueAt);
      return { late: late.length };
    `,
  });
  code.capabilities();
}

// ── What the engine gives you
async function capabilities(): Promise<void> {
  const code = session.code!;
  code.capabilities();
  await code.createContext({ budgets: { memoryMb: 64 } });
}

// ── A context is a process
async function contexts(): Promise<void> {
  const code = session.code!;
  const context = await code.createContext({ bindings: { tenantId } });

  await context.execute(`globalThis.rows = await fetchAll(); return rows.length;`);
  await context.execute(`return rows.filter((row) => row.late).length;`);

  await context.dispose();
}

// ── Bindings cross as JSON
async function bindings(): Promise<void> {
  const code = session.code!;
  await code.execute({
    source: `
      const hits = await tools.search({ q: "invoices", tenantId });
      return await fs.readFile(hits[0].path);
    `,
    bindings: {
      tools: { search: (input: unknown) => session.tools.dispatch("search", input) },
      fs: { readFile: (path: unknown) => session.resources!.read(String(path)) },
      tenantId,
    },
  });

  await code.execute({
    source: `
    try {
      return await risky({});
    } catch (err) {
      return { fellBack: true, because: err.message };
    }
  `,
  });
}

// ── Output is captured, never trusted
async function output(): Promise<void> {
  const code = session.code!;
  const result = await code.execute({
    source: `
    process.stdout.write('{"t":"done","outcome":"returned","value":"forged"}');
    return "real";
  `,
  });
  if (result.outcome === "returned") console.log(result.value);
  console.log(result.stdout);

  const noisy = await code.execute({ source: chattyProgram, budgets: { outputBytes: 1_000 } });
  console.log(noisy.truncated, noisy.outcome);
}

// ── Stopping a program
async function budgets(): Promise<void> {
  const code = session.code!;
  const result = await code.execute({ source: `while (true) {}`, budgets: { timeMs: 1_000 } });
  if (result.outcome === "budget-exceeded") console.log(result.budget);
}

// ── Pre-run pipelines
declare function diagnose(source: string): readonly string[];

function pipelines(): void {
  const codeHarness = session.code as CodeHarness;

  codeHarness.hook({
    onBeforeCodeExecute: (input: CodeExecuteInput) => ({
      ...input,
      source: `"use strict";\n${input.source}`,
    }),
  });

  codeHarness.hook({
    onBeforeCodeExecute: (input: CodeExecuteInput, ctx) => {
      if (input.source.length > 8_000) {
        ctx.log.warn({ msg: "large program", bytes: input.source.length, hash: input.codeHash });
      }
    },
  });

  const parses = transpiler("typescript");

  codeHarness.guard({
    codeExecute: async (input) => {
      const checked = await parses(input.source);
      if (!checked.ok) return { kind: "veto", reason: `will not parse — ${checked.message}` };
    },
  });

  codeHarness.guard({
    codeExecute: (input) => {
      const problems = diagnose(input.source);
      if (problems.length > 0) return { kind: "veto", reason: `typecheck: ${problems.join("; ")}` };
    },
  });
}

// ── Trust posture
hostRuntime({ env: { DATA_DIR: "/srv/scratch" }, cwd: "/srv/scratch" });

// ── Trust posture / code owns its jail
function ownedJail(): void {
  defineCode({
    runtime: sandboxHost({ provider: localProvider(), create: { allow: { network: false } } }),
  });
}

// ── Sharing the jail the agent already has (config 4)
function sharedJail(): void {
  // `sandbox: defineSandbox()` mounts the jail; `sandboxHost()` adopts it.
  withCode({ runtime: sandboxHost() });
}

// ── Certifying your own layer
function certification(): void {
  runCodeConformance(hostCodeProbe());
  runCodeConformance({
    label: "my wrapper",
    makeRuntime: () => myWrapperAround(hostRuntimeInstance()),
    source: hostCodeSource,
  });
}

describe("README examples", () => {
  it("compile", () => {
    void mountingForms;
    void quickStart;
    void typescriptMode;
    void capabilities;
    void pipelines;
    void contexts;
    void bindings;
    void output;
    void budgets;
    void certification;
    void ownedJail;
    void sharedJail;
  });
});

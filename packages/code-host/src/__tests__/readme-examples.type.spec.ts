/**
 * The README's examples, compiled. The house rule is that a README example must
 * typecheck against the CURRENT exports, and `tsc -p tsconfig.json` covers this
 * directory — so this file is the enforcement, not a courtesy.
 *
 * No assertions: the value is the compile.
 */

import { describe, it } from "vitest";
import { withCode, type Code, type Runtime } from "@agentick/code";
import { runCodeConformance } from "@agentick/code/testing";

import { childProcessPort, hostRuntime, type HostProcessPort } from "../index.js";
import { hostCodeProbe, hostCodeSource } from "../testing/index.js";

declare const session: {
  readonly code?: Code;
  readonly tools: { dispatch(name: string, input: unknown): Promise<unknown> };
  readonly resources?: { read(uri: string): Promise<unknown> };
};
declare const tenantId: string;
declare const chattyProgram: string;
declare const log: { info(fields: Record<string, unknown>): void };
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

  const result = await code.run({
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
  await code.run({
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

  await code.run({
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
  const result = await code.run({
    source: `
    process.stdout.write('{"t":"done","outcome":"returned","value":"forged"}');
    return "real";
  `,
  });
  if (result.outcome === "returned") console.log(result.value);
  console.log(result.stdout);

  const noisy = await code.run({ source: chattyProgram, budgets: { outputBytes: 1_000 } });
  console.log(noisy.truncated, noisy.outcome);
}

// ── Stopping a program
async function budgets(): Promise<void> {
  const code = session.code!;
  const result = await code.run({ source: `while (true) {}`, budgets: { timeMs: 1_000 } });
  if (result.outcome === "budget-exceeded") console.log(result.budget);
}

// ── Trust posture
hostRuntime({ env: { DATA_DIR: "/srv/scratch" }, cwd: "/srv/scratch" });

const audited: HostProcessPort = {
  spawn: (request) => {
    log.info({ msg: "spawning a code child", args: request.args });
    return childProcessPort().spawn(request);
  },
};

hostRuntime({ host: audited });

// ── Certifying your own layer
function certification(): void {
  runCodeConformance(hostCodeProbe());
  runCodeConformance({
    label: "my wrapper",
    makeRuntime: () => myWrapperAround(hostRuntime()),
    source: hostCodeSource,
  });
}

describe("README examples", () => {
  it("compile", () => {
    void mountingForms;
    void quickStart;
    void capabilities;
    void contexts;
    void bindings;
    void output;
    void budgets;
    void certification;
  });
});

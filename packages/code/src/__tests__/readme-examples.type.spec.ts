/**
 * The README's examples, compiled. The house rule is that a README example must
 * typecheck against the CURRENT exports, and `tsc -p tsconfig.json` covers this
 * directory — so this file is the enforcement, not a courtesy.
 *
 * No assertions: the value is the compile.
 */

import { describe, it } from "vitest";
import { Effect } from "effect";
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
};
declare const source: string;
declare const tenantId: string;
declare const MAX_PROGRAM_BYTES: number;
declare const existingCodeHarness: Code;

// ── Quick start
defineCode({ runtime: fakeCode() });

async function quickStart(): Promise<void> {
  const code = session.code;
  if (!code) throw new Error("no code runtime is mounted");

  const result = await code.run(source, {
    bindings: {
      tools: { recall: (input) => session.tools.dispatch("recall", input) },
      values: { tenantId },
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
  const running = code.run(source, { signal: controller.signal });
  controller.abort("the user navigated away");
  await running;
}

// ── Policy runs before the program does
function policy(): void {
  const codeHarness = session.code as CodeHarness;
  codeHarness.guardCodeExecute((input) => {
    if (input.bindings.includes("deleteAll")) {
      return Effect.succeed({ kind: "veto", reason: "destructive binding in scope" });
    }
    if (input.source.length > MAX_PROGRAM_BYTES) {
      return Effect.succeed({ kind: "veto", reason: "program too large to review" });
    }
    return Effect.succeed({ kind: "proceed" });
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
    writes: (stream, text) =>
      `console.${stream === "stdout" ? "log" : "error"}(${JSON.stringify(text)}); return "done"`,
    blocks: () => `await new Promise(() => {})`,
    exceeds: (budget, limit) => (budget === "timeMs" ? `await sleep(${limit * 2})` : `…`),
  },
};

void mounting;
void presence;
void readmeProbe;
void runCodeConformance;
void myRuntime;
void policy;
void quickStart;
void fakeCodeSource;

describe("README examples", () => {
  it("compile against the current exports", () => {});
});

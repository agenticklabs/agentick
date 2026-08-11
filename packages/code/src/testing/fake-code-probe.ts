/**
 * The {@link fakeCode} runtime's conformance probe — its instruction list
 * expressed as the source vocabulary `runCodeConformance` drives.
 *
 * A provider ships one of these the way it ships the runtime: the suite stays
 * language-neutral precisely because the language lives here.
 */

import type { CodeConformanceProbe, CodeSourceVocabulary } from "../conformance.js";
import type { CodeBudgetKey, CodeStream } from "../contract.js";
import { fakeCode, fakeProgram, type FakeCodeOptions } from "./fake-code.js";

export const fakeCodeSource: CodeSourceVocabulary = {
  returns: (value) => fakeProgram({ op: "return", value }),
  noValue: () => fakeProgram({ op: "print", stream: "stdout", text: "" }),
  throws: (message) => fakeProgram({ op: "throw", message }),
  callsBinding: (binding, input) =>
    fakeProgram({ op: "call", binding, input }, { op: "return-last" }),
  readsValue: (name) => fakeProgram({ op: "value", name }, { op: "return-last" }),
  writes: (stream: CodeStream, text: string) =>
    fakeProgram({ op: "print", stream, text }, { op: "return", value: "done" }),
  blocks: () => fakeProgram({ op: "block" }),
  exceeds: (budget: CodeBudgetKey, limit: number) =>
    budget === "outputBytes"
      ? // BOTH streams: the ceiling is combined, and a program that only ever
        // writes one of them cannot tell a combined ceiling from a per-stream one.
        fakeProgram(
          { op: "print", stream: "stdout", text: "x".repeat(limit) },
          { op: "print", stream: "stderr", text: "y".repeat(limit) },
          { op: "return", value: "done" },
        )
      : fakeProgram({ op: "sleep", ms: limit * 2 }, { op: "return", value: "unreachable" }),
  remembers: (key, value) => fakeProgram({ op: "remember", key, value }),
  recalls: (key) => fakeProgram({ op: "recall", key }, { op: "return-last" }),
};

export function fakeCodeProbe(options: FakeCodeOptions = {}): CodeConformanceProbe {
  return {
    label: options.name ?? "fakeCode",
    makeRuntime: () => fakeCode(options),
    source: fakeCodeSource,
  };
}

/**
 * The JavaScript source vocabulary for `runCodeConformance`, and the probe that
 * drives it against a real {@link hostRuntime}.
 *
 * It ships from `/testing` rather than living in the spec file because the
 * layer above — a code-mode extension, an adopter's own runtime wrapper — needs
 * the same programs to certify itself against this provider.
 */

import type { CodeConformanceProbe, CodeSourceVocabulary } from "@agentick/code/testing";
import type { CodeBudgetKey, CodeStream } from "@agentick/code";

import { hostRuntime, type HostRuntimeConfig } from "../host-runtime.js";

/** JSON with a name for the one value JSON cannot spell. */
function literal(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The programs are async-function BODIES: `return` answers, top-level await is
 * ordinary, and every binding is an ambient name.
 */
export const hostCodeSource: CodeSourceVocabulary = {
  returns: (value) => `return ${literal(value)};`,
  noValue: () => `const answered = ${literal(false)};`,
  throws: (message) => `throw new Error(${literal(message)});`,
  callsBinding: (name, input) => `return await ${name}(${literal(input)});`,
  readsValue: (name) => `return ${name};`,
  // A frozen namespace refuses the assignment; an AsyncFunction body is sloppy
  // mode, so the refusal is silent here and the `try` costs nothing.
  swapsBinding: (name) =>
    `try { ${name} = async () => "swapped"; } catch {} return await ${name}({});`,
  writes: (stream: CodeStream, text: string) =>
    `process.${stream}.write(${literal(text)}); return "done";`,
  // The sentinel binding is reachable only by a program that outlived its
  // abort, which is what the suite is watching for.
  blocks: () => `await new Promise(() => {}); return await sentinel({});`,
  exceeds: (budget: CodeBudgetKey, limit: number) => {
    switch (budget) {
      case "timeMs":
        // A BUSY loop, not a sleep: a runtime that enforces `timeMs` by
        // resolving a timer would pass against a sleeping program while an
        // unresponsive one ran forever.
        return `const until = Date.now() + ${limit * 100}; while (Date.now() < until) {} return "unreachable";`;
      case "outputBytes":
        return `process.stdout.write("x".repeat(${limit * 4})); process.stderr.write("y".repeat(${limit * 4})); return "done";`;
      case "memoryMb":
        return `const held = []; for (;;) held.push(new Array(50_000).fill("x")); `;
    }
  },
  // The child outlives the execution, so what persists is what lives on
  // `globalThis` — a program's own `const` is scoped to its own body.
  remembers: (key, value) => `(globalThis.kept ??= {})[${literal(key)}] = ${literal(value)};`,
  recalls: (key) => `return (globalThis.kept ??= {})[${literal(key)}];`,
};

export function hostCodeProbe(config: HostRuntimeConfig = {}): CodeConformanceProbe {
  const engine = process.versions.bun === undefined ? "node" : "bun";
  return {
    label: `hostRuntime (${engine}, ${config.language ?? "javascript"})`,
    makeRuntime: () => hostRuntime(config),
    source: hostCodeSource,
  };
}

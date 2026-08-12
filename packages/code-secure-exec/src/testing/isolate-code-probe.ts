/**
 * The JavaScript source vocabulary for `runCodeConformance`, and the probe that
 * drives it against a real {@link secureExec} isolate.
 *
 * It ships from `/testing` so the layer above — a code-mode extension, an
 * adopter's own runtime wrapper — can certify itself against this provider with
 * the same programs.
 */

import type { CodeConformanceProbe, CodeSourceVocabulary } from "@agentick/code/testing";
import type { CodeBudgetKey, CodeStream } from "@agentick/code";

import type { SecureExecConfig } from "../capabilities.js";
import { isolateRuntimeInstance } from "./isolate-runtime-instance.js";

/** JSON with a name for the one value JSON cannot spell. */
function literal(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The programs are async-function BODIES: `return` answers, top-level await is
 * ordinary, every binding is an ambient name, and narration goes through the
 * injected `console` — the isolate has no `process`.
 */
export const isolateCodeSource: CodeSourceVocabulary = {
  returns: (value) => `return ${literal(value)};`,
  noValue: () => `const answered = ${literal(false)};`,
  throws: (message) => `throw new Error(${literal(message)});`,
  callsBinding: (name, input) => `return await ${name}(${literal(input)});`,
  readsValue: (name) => `return ${name};`,
  // A frozen namespace refuses the assignment; a compiled script is sloppy mode,
  // so the refusal is silent here and the `try` costs nothing.
  swapsBinding: (name) =>
    `try { ${name} = async () => "swapped"; } catch {} return await ${name}({});`,
  writes: (stream: CodeStream, text: string) =>
    `console.${stream === "stderr" ? "error" : "log"}(${literal(text)}); return "done";`,
  // The sentinel binding is reachable only by a program that outlived its abort,
  // which is what the suite is watching for.
  blocks: () => `await new Promise(() => {}); return await sentinel({});`,
  exceeds: (budget: CodeBudgetKey, limit: number) => {
    switch (budget) {
      case "timeMs":
        // A BUSY loop, not a sleep: `script.run`'s timeout bounds synchronous
        // execution, and a runtime enforcing `timeMs` by resolving a timer
        // would pass a sleeping program while an unresponsive one ran forever.
        return `const until = Date.now() + ${limit * 100}; while (Date.now() < until) {} return "unreachable";`;
      case "memoryMb":
        return `const held = []; for (;;) held.push(new Array(50_000).fill("x"));`;
      case "outputBytes":
        return `return "unreachable";`;
    }
  },
  // The isolate global outlives the execution; a program's own `const` is scoped
  // to its own body, so what persists is what lives on `globalThis`.
  remembers: (key, value) => `(globalThis.kept ??= {})[${literal(key)}] = ${literal(value)};`,
  recalls: (key) => `return (globalThis.kept ??= {})[${literal(key)}];`,
};

export function isolateCodeProbe(config: SecureExecConfig = {}): CodeConformanceProbe {
  return {
    label: `secureExec (isolate, ${config.language ?? "javascript"})`,
    makeRuntime: () => isolateRuntimeInstance(config),
    source: isolateCodeSource,
  };
}

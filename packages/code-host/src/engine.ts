/**
 * Which engine is running the host app, and what that engine can therefore be
 * held to.
 *
 * Engine differences surface as CAPABILITY differences, never as a second
 * package. `timeMs` and `outputBytes` are enforced by the parent — a kill timer
 * and a cut on the captured streams — so they hold whatever the child is.
 * `memoryMb` needs the engine's own heap ceiling, and only one engine has one
 * that works.
 */

import type { CodeBudgetKey, CodeCapabilities } from "@agentick/code";

import type { HostLanguage } from "./language.js";

export interface HostEngine {
  /** `"node"`, `"bun"`, or whatever else `process.versions` names. */
  readonly name: string;
  readonly execPath: string;
  /** The flag that bounds the heap, when the engine HONORS one. */
  readonly heapLimitFlag?: (mb: number) => string;
}

/**
 * bun accepts `--max-old-space-size` and `--smol` and enforces neither: an
 * allocation loop under bun 1.3.14 outlives an 8s wait at 10MB, 64MB and
 * `--smol`, where node dies in ~100ms at 10MB. Accepting a flag is not
 * enforcing a budget, so bun's capabilities leave `memoryMb` out.
 *
 * @verifiedBy packages/code-host/src/__tests__/engine.spec.ts
 */
export function detectEngine(): HostEngine {
  const execPath = process.execPath;
  if (typeof process.versions.bun === "string") return { name: "bun", execPath };
  if (typeof process.versions.node === "string" && process.versions.deno === undefined) {
    return { name: "node", execPath, heapLimitFlag: (mb) => `--max-old-space-size=${mb}` };
  }
  return { name: otherEngineName(), execPath };
}

/** Whatever the engine calls itself, so `capabilities.name` never lies by omission. */
function otherEngineName(): string {
  const known = Object.keys(process.versions).find((key) => key !== "node" && key !== "v8");
  return known ?? "unknown";
}

export function hostCapabilities(
  engine: HostEngine,
  language: HostLanguage = "javascript",
): CodeCapabilities {
  const enforces: CodeBudgetKey[] = ["timeMs", "outputBytes"];
  if (engine.heapLimitFlag !== undefined) enforces.push("memoryMb");
  return {
    name: `host:${engine.name}${language === "typescript" ? "+ts" : ""}`,
    enforces,
    // The child outlives the execution, so `globalThis` and everything it
    // reaches carry over. A program's own `const` does not — the body is a
    // fresh async function each time.
    persistentContext: true,
  };
}

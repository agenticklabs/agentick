#!/usr/bin/env node
/**
 * Detached-effect gate — the structural enforcement of #315's fix.
 *
 * WHY: a floating `void Effect.runPromise(...)` whose rejection nobody
 * observes is an unhandled rejection, and Node's default for those is
 * process death — one harness's hiccup projected onto the whole server
 * (the incident behind #315). `runDetached` (runtime) is the ONE
 * sanctioned way to run a fire-and-forget Effect: it routes the failure
 * to a sink instead of the void. Nine hand-rolled sites were migrated;
 * this gate is what keeps a tenth from appearing.
 *
 * WHAT: grep every `packages/<pkg>/src/**` source file for
 * `void Effect.runPromise(`. The ONLY file allowed to contain a floating
 * runPromise is `run-detached.ts` itself. Test files are exempt (a spec
 * asserting rejection behavior legitimately floats promises).
 *
 * NOTE: `void Effect.runFork(...)` stays legal — a forked fiber's failure
 * goes to the fiber runtime's reporter, never to the process's
 * unhandled-rejection handler.
 *
 * EXIT: 0 iff no unsanctioned floating runPromise exists; non-zero
 * (naming offenders) otherwise — so CI can gate on it.
 *
 * INVOCATION: `pnpm check:detached-effects` (root) or
 * `node scripts/detached-effect-gate.mjs`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "packages");

const CALL_RE = /\bvoid\s+Effect\.runPromise\s*\(/;

const ALLOWED_SUFFIXES = ["packages/runtime/src/substrate/run-detached.ts"];

function isTestFile(posixPath) {
  return /\.spec\.[cm]?tsx?$/.test(posixPath) || posixPath.includes("/__tests__/");
}

function isAllowed(posixPath) {
  return ALLOWED_SUFFIXES.some((suffix) => posixPath.endsWith(suffix)) || isTestFile(posixPath);
}

function collectSources(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      collectSources(abs, out);
    } else if (/\.[cm]?tsx?$/.test(name)) {
      out.push(abs);
    }
  }
}

const sources = [];
for (const name of readdirSync(PKG_DIR)) {
  const srcDir = join(PKG_DIR, name, "src");
  try {
    if (statSync(srcDir).isDirectory()) collectSources(srcDir, sources);
  } catch {
    /* package without a src/ — skip */
  }
}

const offenders = [];
for (const abs of sources) {
  const posix = relative(ROOT, abs).split("\\").join("/");
  if (isAllowed(posix)) continue;
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (CALL_RE.test(lines[i])) offenders.push(`${posix}:${i + 1}: ${lines[i].trim()}`);
  }
}

console.log(`detached-effect gate — scanned ${sources.length} source files.\n`);
if (offenders.length === 0) {
  console.log("OK: no floating `void Effect.runPromise(` outside run-detached.ts.");
  process.exit(0);
}

console.error("Floating `void Effect.runPromise(` found — use `runDetached` (see #315):\n");
for (const line of offenders) console.error(`  ${line}`);
process.exit(1);

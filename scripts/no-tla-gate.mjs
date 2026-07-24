#!/usr/bin/env node
/**
 * no-TLA gate — the empirical `require(ESM)` load probe.
 *
 * WHY: a consumer (Knowify's assistant-api) loads agentick via CommonJS
 * `require()` of our published ESM dist. Node's `require(ESM)` interop throws
 * `ERR_REQUIRE_ASYNC_MODULE` at load time if ANY module in a published package's
 * dist graph contains a top-level await (TLA) — or any other construct that makes
 * the module graph asynchronous. A static grep for `await` at column 0 is not
 * enough (TLA can hide behind re-exports, in a transitive dep, or in a
 * `for await`); the ONLY faithful check is to actually `require()` the built
 * entrypoint in a real Node process and watch it load.
 *
 * WHAT: for every PUBLISHABLE (non-private) `@agentick/*-next` package, resolve
 * each `publishConfig.exports` subpath entrypoint (the artifact a consumer
 * actually imports — NOT `main`, which points at dev `src/`), and `require()` it
 * in a FRESH `node -e` subprocess. A clean load (exit 0) is a PASS; an
 * `ERR_REQUIRE_ASYNC_MODULE` is the TLA failure we gate; any other load error is
 * reported distinctly (missing dist / genuine runtime throw).
 *
 * EXIT: 0 iff every entrypoint loaded clean; non-zero (naming the offenders) on
 * any TLA, any other load failure, or any unbuilt publishable package — so CI can
 * gate on it.
 *
 * INVOCATION: `pnpm check:no-tla` (root) or `node scripts/no-tla-gate.mjs`.
 * Assumes dist is built (`pnpm build` first); it does NOT build for you — a
 * publishable package with no dist is a LOUD failure, never a silent skip.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "packages-next");

// ── Node version guard: require(ESM) needs 20.19+ or 22.12+ ──────────────────
const [maj, min] = process.versions.node.split(".").map(Number);
const requireEsmOk = maj > 22 || (maj === 22 && min >= 12) || (maj === 20 && min >= 19);
if (!requireEsmOk) {
  console.error(
    `✘ no-TLA gate needs a Node with require(ESM) support (>=20.19 or >=22.12); ` +
      `running ${process.versions.node}. Upgrade Node — the gate cannot run.`,
  );
  process.exit(2);
}

/** Resolve every publishable package + its publishConfig entrypoints. */
function publishableEntrypoints() {
  const out = [];
  for (const name of readdirSync(PKG_DIR)) {
    const pjPath = join(PKG_DIR, name, "package.json");
    if (!existsSync(pjPath)) continue;
    const pj = JSON.parse(readFileSync(pjPath, "utf8"));
    if (pj.private) continue; // publishable === NOT private
    const exp = pj.publishConfig?.exports ?? {};
    const entries = Object.entries(exp)
      .map(([sub, v]) => [sub, typeof v === "string" ? v : (v.import ?? v.default)])
      .filter(([, file]) => typeof file === "string");
    out.push({ pkg: pj.name, dir: join(PKG_DIR, name), entries });
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/**
 * `require()` one built entrypoint in a fresh subprocess. Returns a verdict:
 * "pass" | "tla" | "missing" | "error", with the captured stderr for reporting.
 */
const REGISTER = join(ROOT, "scripts", "no-tla-register.mjs");

function probe(absFile) {
  if (!existsSync(absFile)) return { verdict: "missing", detail: "no dist file" };
  // `--eval` with a CJS require of the ESM dist — the exact Knowify load path.
  // `--import` preloads the dist-resolving loader so `@agentick/*` deps resolve
  // to their BUILT dist (the published-resolution reproduction), NOT dev `src`.
  const code = `require(${JSON.stringify(absFile)});`;
  try {
    execFileSync(process.execPath, ["--import", pathToFileURL(REGISTER).href, "--eval", code], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    return { verdict: "pass" };
  } catch (e) {
    const stderr = String(e.stderr ?? e.message ?? "");
    if (stderr.includes("ERR_REQUIRE_ASYNC_MODULE")) {
      return { verdict: "tla", detail: firstLine(stderr) };
    }
    return { verdict: "error", detail: firstLine(stderr) };
  }
}

function firstLine(s) {
  const line = s.split("\n").find((l) => /Error|ERR_/.test(l)) ?? s.split("\n")[0] ?? "";
  return line.trim().slice(0, 300);
}

// ── Run ──────────────────────────────────────────────────────────────────────
const packages = publishableEntrypoints();
console.log(
  `no-TLA gate — ${packages.length} publishable packages, Node ${process.versions.node}\n`,
);

const failures = [];
const unbuilt = [];
for (const { pkg, dir, entries } of packages) {
  for (const [sub, file] of entries) {
    const abs = join(dir, file);
    const label = sub === "." ? pkg : `${pkg} (${sub})`;
    const { verdict, detail } = probe(abs);
    const mark = verdict === "pass" ? "✔ PASS" : verdict === "missing" ? "▲ UNBUILT" : "✘ FAIL";
    console.log(`${mark.padEnd(10)} ${label}${detail ? `  — ${detail}` : ""}`);
    if (verdict === "tla") failures.push({ label, kind: "TLA (ERR_REQUIRE_ASYNC_MODULE)", detail });
    else if (verdict === "error") failures.push({ label, kind: "load error", detail });
    else if (verdict === "missing") unbuilt.push(label);
  }
}

console.log("");
if (unbuilt.length > 0) {
  console.error(
    `✘ ${unbuilt.length} publishable entrypoint(s) have NO dist — run \`pnpm build\` first:`,
  );
  for (const u of unbuilt) console.error(`    ${u}`);
}
if (failures.length > 0) {
  console.error(`✘ ${failures.length} entrypoint(s) FAILED to require():`);
  for (const f of failures) console.error(`    ${f.label}: ${f.kind} — ${f.detail}`);
}
if (unbuilt.length === 0 && failures.length === 0) {
  console.log("✔ every publishable entrypoint loads clean under require(ESM) — no TLA.");
  process.exit(0);
}
process.exit(1);

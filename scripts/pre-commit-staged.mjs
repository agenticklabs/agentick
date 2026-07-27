/**
 * Pre-commit gate over STAGED FILES ONLY.
 *
 * The workspace-wide `format:check && lint` it replaced gave committed files no
 * extra protection — format and lint are file-local — while letting any
 * unstaged file in the tree block every commit. Under concurrent work that made
 * the hook a hostage: one in-flight file stalled unrelated commits repeatedly.
 *
 * The workspace sweep still exists as `pnpm format:check` / `pnpm lint` for CI
 * and for a manual pass. What this gate cannot catch — cross-package breakage
 * from a deleted export — the old one could not catch either: neither runs
 * typecheck. `pnpm typecheck` before deleting an export remains the rule.
 */

import { execFileSync } from "node:child_process";

const EXT = /\.(?:[cm]?[jt]sx?|json|md)$/;

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f !== "" && EXT.test(f));

if (staged.length === 0) process.exit(0);

// oxlint reads source only; handing it .json/.md is an error, not a no-op.
const lintable = staged.filter((f) => /\.[cm]?[jt]sx?$/.test(f));

for (const [bin, files] of [
  ["oxfmt", ["--check", ...staged]],
  ["oxlint", lintable],
]) {
  if (files.length === 0) continue;
  execFileSync("npx", [bin, ...files], { stdio: "inherit" });
}

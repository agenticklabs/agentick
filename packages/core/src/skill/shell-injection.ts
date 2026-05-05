/**
 * Skill body shell injection — `` !`<command>` `` and ``` ```! ``` blocks.
 *
 * Per the [Claude Code skills spec](https://code.claude.com/docs/en/skills#inject-dynamic-context),
 * skill bodies can include shell commands that run **before** the body
 * reaches the model. Each command is executed and its output replaces the
 * placeholder. Two forms:
 *
 * Inline:
 * ```markdown
 * Current diff: !`git diff HEAD`
 * ```
 *
 * Multi-line block:
 * ````markdown
 * ## Environment
 * ```!
 * node --version
 * git status --short
 * ```
 * ````
 *
 * Execution model:
 *   - Runs through `session.shell()`, which routes to the registered
 *     `<Bash>` tool. Same sandbox the agent uses — no separate privilege.
 *   - If no shell is mounted, `session.shell()` throws. We surface that
 *     loudly: a skill with `!` blocks needs shell access.
 *   - Commands run **serially** in document order. A later command may
 *     observe filesystem state mutated by earlier ones.
 *   - Substitution happens at invocation time, not load time. Each call
 *     of `session.skill(skill, …)` re-runs the commands so output is
 *     fresh.
 *
 * @module @agentick/core/skill/shell-injection
 */

/**
 * One parsed shell injection in a skill body.
 */
export interface ShellInjection {
  /** Absolute start position in the source body. */
  readonly start: number;
  /** Absolute end position (exclusive) in the source body. */
  readonly end: number;
  /** The command text to execute. For block kind, lines are joined with newlines. */
  readonly command: string;
  /** Inline (`` !`cmd` ``) or block (``` ```! \n cmd \n``` ```). */
  readonly kind: "inline" | "block";
}

const RE_BLOCK = /^```!\s*\n([\s\S]*?)\n```$/gm;

// Inline form requires `!` to be at line-start or preceded by whitespace.
// Avoids the most accidental case: a skill body containing `prose!`grep``
// (no space before `!`) shouldn't execute. Note this does NOT fully
// prevent prose-confusion — `"use !`grep` to search"` still matches
// because the space qualifies. The full mitigation is a session/app-level
// `disableSkillShellExecution` opt-out, which is reserved future work.
// All spec examples use line-start or post-whitespace `!`, so the
// constraint is a no-op for legitimate use.
const RE_INLINE = /(?<=^|\s)!`([^`\n]+)`/gm;

/**
 * Find all shell injections in a body, returned in document order.
 *
 * Block injections are matched first; inline injections that fall inside
 * a block are filtered out.
 */
export function findShellInjections(body: string): ShellInjection[] {
  const results: ShellInjection[] = [];

  // Pass 1: blocks
  RE_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_BLOCK.exec(body)) !== null) {
    results.push({
      start: m.index,
      end: m.index + m[0].length,
      command: m[1]!,
      kind: "block",
    });
  }

  // Pass 2: inlines, excluding any that fall inside a block range
  RE_INLINE.lastIndex = 0;
  while ((m = RE_INLINE.exec(body)) !== null) {
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    const insideBlock = results.some(
      (b) => b.kind === "block" && matchStart >= b.start && matchEnd <= b.end,
    );
    if (insideBlock) continue;
    results.push({
      start: matchStart,
      end: matchEnd,
      command: m[1]!,
      kind: "inline",
    });
  }

  return results.sort((a, b) => a.start - b.start);
}

/**
 * Returns true if the body contains at least one shell injection.
 */
export function bodyHasShellInjections(body: string): boolean {
  RE_BLOCK.lastIndex = 0;
  if (RE_BLOCK.test(body)) return true;
  RE_INLINE.lastIndex = 0;
  return RE_INLINE.test(body);
}

/**
 * Run all shell injections in the body, replacing each with the command's
 * output. Commands execute serially in document order via the supplied
 * `runner`.
 *
 * If `runner` throws (e.g. `session.shell` rejecting because no `<Bash>`
 * tool is mounted), the error is wrapped with context (which command, at
 * what position) and re-thrown.
 */
export async function applyShellInjections(
  body: string,
  runner: (command: string) => Promise<string>,
): Promise<string> {
  const injections = findShellInjections(body);
  if (injections.length === 0) return body;

  let out = "";
  let cursor = 0;
  for (const inj of injections) {
    out += body.slice(cursor, inj.start);
    let result: string;
    try {
      result = await runner(inj.command);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Skill shell injection failed at offset ${inj.start} ` +
          `(${inj.kind} command \`${truncate(inj.command, 80)}\`): ${reason}`,
      );
    }
    out += result;
    cursor = inj.end;
  }
  out += body.slice(cursor);
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

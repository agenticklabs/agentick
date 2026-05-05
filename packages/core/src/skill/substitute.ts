/**
 * Skill body substitution — `$ARGUMENTS`, `$N`, `$name`, `${VARS}`.
 *
 * Follows the Agent Skills / Claude Code spec for skill string
 * substitution:
 *
 *   - `$ARGUMENTS`     → all arguments (the canonical form)
 *   - `$ARGUMENTS[N]`  → 0-indexed positional access
 *   - `$N`             → shorthand for `$ARGUMENTS[N]`
 *   - `$name`          → named, mapped via `argumentNames` order or args keys
 *   - `${VAR}`         → environment-style variable (session id, skill dir, …)
 *
 * Behavior parallels the spec:
 * - When `$ARGUMENTS` is absent and args were passed, the caller appends
 *   `ARGUMENTS: <value>` to the body (handled by the invoker, not here)
 * - Unknown `${VAR}` → left literal (no throw — common pattern is shells
 *   leaving unset env literal)
 * - Unknown `$name` (not in argumentNames or args object) → left literal
 *
 * @module @agentick/core/skill/substitute
 */

export interface SubstituteOptions {
  /**
   * The argument value. May be:
   * - an object — keys become available as `$name`, values (in
   *   `argumentNames` order, or insertion order) as `$N` / `$ARGUMENTS[N]`
   * - a string — used directly as `$ARGUMENTS`; `$N` indexed via shell-style
   *   tokenization (whitespace + quotes)
   * - undefined — substitutions resolve to empty string
   */
  args?: unknown;

  /**
   * Declared argument names (from the `arguments` frontmatter field). When
   * present, drives the order for `$N` access on object args, and the set
   * of valid `$name` keys.
   */
  argumentNames?: string[];

  /**
   * Environment-style variables for `${VAR}` substitution.
   */
  vars?: Record<string, string>;
}

const RE_DOLLAR_VAR = /\$\{([A-Z_][A-Z0-9_]*)\}/g; // ${VAR}
const RE_ARGUMENTS_INDEXED = /\$ARGUMENTS\[(\d+)\]/g; // $ARGUMENTS[N]
const RE_ARGUMENTS = /\$ARGUMENTS\b/g; // $ARGUMENTS
const RE_DOLLAR_INDEX = /\$(\d+)\b/g; // $N
const RE_DOLLAR_NAME = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\b/g; // $name

/**
 * Apply skill substitutions to a template string.
 *
 * Order of substitution matters — `${VAR}` first (unambiguous), then
 * `$ARGUMENTS[N]` and `$ARGUMENTS` (specific tokens), then `$N`, then
 * `$name` (broadest). This way `$ARGUMENTS` isn't matched by the `$name`
 * pattern, and `$0` doesn't get matched as a name.
 */
export function substituteSkillVars(template: string, opts: SubstituteOptions = {}): string {
  const { args, argumentNames, vars = {} } = opts;

  const positional = positionalArgs(args, argumentNames);
  const named = namedArgs(args, argumentNames);
  const argumentsString = argumentsAsString(args);

  let out = template;

  // 1. ${VAR} — env-style
  out = out.replace(RE_DOLLAR_VAR, (full, name: string) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : full;
  });

  // 2. $ARGUMENTS[N] — indexed positional
  out = out.replace(RE_ARGUMENTS_INDEXED, (full, idx: string) => {
    const i = Number(idx);
    return i >= 0 && i < positional.length ? positional[i]! : full;
  });

  // 3. $ARGUMENTS — full
  out = out.replace(RE_ARGUMENTS, () => argumentsString);

  // 4. $N — shorthand positional (must come before $name to win on `$0`)
  out = out.replace(RE_DOLLAR_INDEX, (full, idx: string) => {
    const i = Number(idx);
    return i >= 0 && i < positional.length ? positional[i]! : full;
  });

  // 5. $name — named arg
  out = out.replace(RE_DOLLAR_NAME, (full, name: string) => {
    return Object.prototype.hasOwnProperty.call(named, name) ? String(named[name]) : full;
  });

  return out;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Whether `$ARGUMENTS` (or any of its indexed/shorthand forms) appears in
 * the template. Used by callers to decide whether to append the spec's
 * fallback `ARGUMENTS: <value>` line when args were passed but not used.
 */
export function templateUsesArguments(template: string): boolean {
  return /\$ARGUMENTS\b|\$ARGUMENTS\[\d+\]|\$\d+\b/.test(template);
}

function positionalArgs(args: unknown, names?: string[]): string[] {
  if (args == null) return [];

  // String args: shell-style tokenization (quoted multi-word grouped)
  if (typeof args === "string") {
    return tokenizeShellArgs(args);
  }

  // Object args: take values in `names` order if present, else insertion order
  if (typeof args === "object" && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    const keys = names && names.length > 0 ? names : Object.keys(obj);
    return keys.map((k) => stringifyArg(obj[k]));
  }

  // Array args: stringify each
  if (Array.isArray(args)) {
    return args.map(stringifyArg);
  }

  return [stringifyArg(args)];
}

function namedArgs(args: unknown, names?: string[]): Record<string, string> {
  const out: Record<string, string> = {};

  if (args == null) return out;

  // String args + declared names: positional → named
  if (typeof args === "string" && names && names.length > 0) {
    const tokens = tokenizeShellArgs(args);
    for (let i = 0; i < names.length; i++) {
      if (i < tokens.length) out[names[i]!] = tokens[i]!;
    }
    return out;
  }

  // Object args: keys directly available as names
  if (typeof args === "object" && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = stringifyArg(v);
    }
    return out;
  }

  return out;
}

function argumentsAsString(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args === "number" || typeof args === "boolean") return String(args);
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function stringifyArg(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Minimal shell-style tokenizer — splits on whitespace, respects single
 * and double quotes (no escapes beyond standard quote-pairing). Matches
 * the spec's "shell-style quoting" for indexed argument access.
 */
function tokenizeShellArgs(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (/\s/.test(ch ?? "") && !inSingle && !inDouble) {
      if (buf !== "") {
        out.push(buf);
        buf = "";
      }
    } else {
      buf += ch;
    }
  }
  if (buf !== "") out.push(buf);
  return out;
}

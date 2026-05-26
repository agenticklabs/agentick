/**
 * ACL matcher — static config + per-session learned.
 *
 * The harness checks every operation against:
 *   1. Static config from `<Sandbox allow={...}>` — never prompts.
 *   2. Session-learned `allow-session` decisions — added at runtime
 *      after a `sandbox_permission` request resolved to one of the
 *      `allow-*` verbs.
 *   3. Session-learned `deny-session` decisions — silently refused.
 *   4. Otherwise → `null`, signaling "pending decision; ask the user".
 *
 * Pattern format on user-supplied strings:
 *   - bare string or `glob:<pattern>` — glob match (default)
 *   - `regex:<pattern>` — opt-in regex match (useful for exec)
 *   - absolute path — exact match for paths
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md §ACL
 */

import type { SandboxACL } from "@agentick/spec";

export type ACLDecision = "allow" | "deny" | "pending";

/**
 * Mutable per-session ACL state. The harness owns one of these and
 * `update`s it whenever a `sandbox_permission` response carries a
 * `*-session*` decision. Snapshot persistence is handled by the
 * caller (typically via the StateHarness).
 */
export class SessionACL {
  private readonly readAllows: string[] = [];
  private readonly writeAllows: string[] = [];
  private readonly execAllows: string[] = [];
  private readonly readDenies: string[] = [];
  private readonly writeDenies: string[] = [];
  private readonly execDenies: string[] = [];

  rememberAllow(kind: "read" | "write" | "exec", pattern: string): void {
    this.bucketFor(kind, "allow").push(pattern);
  }

  rememberDeny(kind: "read" | "write" | "exec", pattern: string): void {
    this.bucketFor(kind, "deny").push(pattern);
  }

  /**
   * Returns the bucket for a (kind, direction) pair. Internal helper.
   */
  private bucketFor(kind: "read" | "write" | "exec", dir: "allow" | "deny"): string[] {
    if (kind === "read") return dir === "allow" ? this.readAllows : this.readDenies;
    if (kind === "write") return dir === "allow" ? this.writeAllows : this.writeDenies;
    return dir === "allow" ? this.execAllows : this.execDenies;
  }

  /**
   * Evaluate a target against the session-learned allow + deny lists
   * AND the static config. Returns the first decision: explicit deny
   * wins over allow on the same target; otherwise allow wins. If
   * neither matches, returns "pending".
   */
  evaluate(
    static_: SandboxACL | undefined,
    kind: "read" | "write" | "exec",
    target: string,
  ): ACLDecision {
    // Static deny first (exec-only — read/write have no static deny).
    if (kind === "exec") {
      for (const p of static_?.exec?.deny ?? []) {
        if (matches(p, target)) return "deny";
      }
    }
    // Session-learned deny.
    for (const p of this.bucketFor(kind, "deny")) {
      if (matches(p, target)) return "deny";
    }
    // Static allow.
    const staticAllow =
      kind === "read" ? static_?.read : kind === "write" ? static_?.write : static_?.exec?.allow;
    for (const p of staticAllow ?? []) {
      if (matches(p, target)) return "allow";
    }
    // Session-learned allow.
    for (const p of this.bucketFor(kind, "allow")) {
      if (matches(p, target)) return "allow";
    }
    return "pending";
  }

  /** Snapshot for persistence via StateHarness. */
  exportSnapshot(): SessionACLSnapshot {
    return {
      readAllows: [...this.readAllows],
      writeAllows: [...this.writeAllows],
      execAllows: [...this.execAllows],
      readDenies: [...this.readDenies],
      writeDenies: [...this.writeDenies],
      execDenies: [...this.execDenies],
    };
  }

  importSnapshot(snap: SessionACLSnapshot): void {
    this.readAllows.length = 0;
    this.writeAllows.length = 0;
    this.execAllows.length = 0;
    this.readDenies.length = 0;
    this.writeDenies.length = 0;
    this.execDenies.length = 0;
    this.readAllows.push(...snap.readAllows);
    this.writeAllows.push(...snap.writeAllows);
    this.execAllows.push(...snap.execAllows);
    this.readDenies.push(...snap.readDenies);
    this.writeDenies.push(...snap.writeDenies);
    this.execDenies.push(...snap.execDenies);
  }
}

export interface SessionACLSnapshot {
  readonly readAllows: readonly string[];
  readonly writeAllows: readonly string[];
  readonly execAllows: readonly string[];
  readonly readDenies: readonly string[];
  readonly writeDenies: readonly string[];
  readonly execDenies: readonly string[];
}

// ============================================================================
// Pattern matching
// ============================================================================

/**
 * Match a target against a single pattern. Pattern format:
 *   - `regex:<re>` — JavaScript regex
 *   - `glob:<glob>` or bare string — glob (`*`, `**`, `?`)
 *   - leading `/` (absolute path) is treated as a glob too — `/etc/passwd`
 *     matches exactly itself.
 */
export function matches(pattern: string, target: string): boolean {
  if (pattern.startsWith("regex:")) {
    const body = pattern.slice("regex:".length);
    try {
      return new RegExp(body).test(target);
    } catch {
      return false;
    }
  }
  const glob = pattern.startsWith("glob:") ? pattern.slice("glob:".length) : pattern;
  return globMatch(glob, target);
}

/**
 * Minimal glob matcher: `*` → one segment of non-slash; `**` → any
 * (including slashes); `?` → one char. No bracket expressions or
 * extglobs — adopters who need those use `regex:`.
 */
function globMatch(glob: string, target: string): boolean {
  const re = globToRegExp(glob);
  return re.test(target);
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        // consume a following slash so `**/foo` matches "foo"
        if (glob[i] === "/") i += 1;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (/[\\^$.+(){}[\]|]/.test(c)) {
      out += `\\${c}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  out += "$";
  return new RegExp(out);
}

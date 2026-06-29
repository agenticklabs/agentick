/**
 * `roleBasedAuthz` — pattern-based `Authorizer` stage.
 *
 * Rules are `Record<pattern, allowedRoles[]>`. The pattern matches
 * the operation in `"{type}:{name}"` form (e.g., `"tool_call:search"`,
 * `"tool_call:*"`, `"prompt_get:weekly_status"`, `"*"`). Specificity
 * wins: exact-name beats wildcard-name, wildcard-name beats catch-all.
 * Missing rule = implicit deny.
 *
 * Roles read from `ctx.user.roles` by default. Adopters with custom
 * principal shapes supply a `getRoles(ctx)` callback.
 *
 * Ported from v1 `packages/mcp/src/server/security/stages.ts`.
 */

import type { McpRequestContext } from "@agentick/spec-next";

import type { Authorizer, OperationInfo } from "../stages.js";

export interface RoleBasedAuthzOptions {
  /**
   * Pattern → required-roles map. Keys are `"type:name"`, `"type:*"`,
   * or `"*"`. Values are role names; the user needs AT LEAST ONE.
   * Empty array means "any authenticated user".
   *
   *   {
   *     "tool_call:public_*": ["read", "write"],  // public tools — both roles allowed
   *     "tool_call:admin_*":  ["admin"],          // admin tools — admin only
   *     "prompt_get:*":       [],                 // any authenticated user can read prompts
   *     "*":                  ["admin"],          // catch-all: admins only
   *   }
   */
  readonly rules: Readonly<Record<string, readonly string[]>>;
  /** Override role extraction (default: `ctx.user?.roles ?? []`). */
  readonly getRoles?: (ctx: McpRequestContext) => readonly string[];
}

export function roleBasedAuthz(options: RoleBasedAuthzOptions): Authorizer {
  const getRoles = options.getRoles ?? defaultGetRoles;
  // Pre-compile rules with specificity scores for fast resolution.
  const compiled = compileRules(options.rules);

  return async (ctx, operation) => {
    const userRoles = getRoles(ctx);
    const required = matchRule(operation, compiled);
    if (required === null) {
      return {
        allowed: false,
        reason: `No rule matches ${operation.type}:${operation.name ?? "*"}`,
      };
    }
    if (required.length === 0) return { allowed: true };
    const ok = required.some((r) => userRoles.includes(r));
    if (!ok) {
      return {
        allowed: false,
        reason: `Requires one of: ${required.join(", ")}`,
      };
    }
    return { allowed: true };
  };
}

interface CompiledRule {
  readonly specificity: number;
  readonly type: string | "*";
  readonly name: string | "*";
  readonly roles: readonly string[];
}

function compileRules(rules: Readonly<Record<string, readonly string[]>>): readonly CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const [pattern, roles] of Object.entries(rules)) {
    if (pattern === "*") {
      out.push({ specificity: 0, type: "*", name: "*", roles });
      continue;
    }
    const colonIdx = pattern.indexOf(":");
    if (colonIdx < 0) {
      // No colon — invalid pattern; skip with a no-op (v1 logged here).
      continue;
    }
    const type = pattern.slice(0, colonIdx) || "*";
    const name = pattern.slice(colonIdx + 1) || "*";
    let specificity = 0;
    if (type !== "*") specificity += 2;
    if (name !== "*") specificity += 1;
    out.push({ specificity, type, name, roles });
  }
  // Higher specificity first — first-match-wins on tied specificity.
  out.sort((a, b) => b.specificity - a.specificity);
  return out;
}

function matchRule(
  operation: OperationInfo,
  rules: readonly CompiledRule[],
): readonly string[] | null {
  for (const rule of rules) {
    if (rule.type !== "*" && rule.type !== operation.type) continue;
    if (rule.name !== "*" && rule.name !== (operation.name ?? "")) continue;
    return rule.roles;
  }
  return null;
}

function defaultGetRoles(ctx: McpRequestContext): readonly string[] {
  return ctx.mcp.user?.roles ?? [];
}

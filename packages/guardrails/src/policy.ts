import type { GuardrailRule, GuardrailAction } from "./types.js";

/**
 * Match a tool name against a glob-like pattern.
 *
 * Supports `*` as a wildcard:
 * - `"search"` — exact match
 * - `"file_*"` — prefix match (file_read, file_write, ...)
 * - `"*_admin"` — suffix match
 * - `"*"` — matches everything
 */
export function matchPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;

  // Convert glob to regex: escape special chars, replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Evaluate a list of rules against a tool name. First match wins.
 * Returns the matching rule, or `null` if no rule matches.
 */
export function evaluateRules(name: string, rules: GuardrailRule[]): GuardrailRule | null {
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (matchPattern(name, pattern)) {
        return rule;
      }
    }
  }
  return null;
}

/**
 * Create a deny rule for the given patterns.
 */
export function deny(...patterns: string[]): GuardrailRule {
  return { patterns, action: "deny" as GuardrailAction };
}

/**
 * Create an allow rule for the given patterns.
 */
export function allow(...patterns: string[]): GuardrailRule {
  return { patterns, action: "allow" as GuardrailAction };
}

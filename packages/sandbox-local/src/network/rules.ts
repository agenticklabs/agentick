/**
 * Network Rule Matching Engine
 *
 * Evaluates requests against an ordered list of NetworkRules.
 * First match wins; default action is deny.
 */

import type { NetworkRule } from "@agentick/sandbox";

export interface RequestInfo {
  host: string;
  port: number;
  method: string;
  url: string;
}

export interface MatchResult {
  action: "allow" | "deny";
  rule?: NetworkRule;
}

/**
 * Match a request against an ordered list of rules.
 * First matching rule wins. Default: deny.
 */
export function matchRequest(request: RequestInfo, rules: NetworkRule[]): MatchResult {
  for (const rule of rules) {
    if (ruleMatches(request, rule)) {
      return { action: rule.action, rule };
    }
  }
  return { action: "deny" };
}

function ruleMatches(request: RequestInfo, rule: NetworkRule): boolean {
  // Domain check
  if (rule.domain !== undefined) {
    if (!matchDomain(request.host, rule.domain)) return false;
  }

  // Port check
  if (rule.port !== undefined) {
    if (request.port !== rule.port) return false;
  }

  // Method check
  if (rule.methods !== undefined && rule.methods.length > 0) {
    const upperMethod = request.method.toUpperCase();
    if (!rule.methods.some((m) => m.toUpperCase() === upperMethod)) return false;
  }

  // URL pattern check
  if (rule.urlPattern !== undefined) {
    try {
      const regex = new RegExp(rule.urlPattern);
      if (!regex.test(request.url)) return false;
    } catch {
      // Invalid regex — treat as no match
      return false;
    }
  }

  return true;
}

/**
 * Match a hostname against a domain pattern.
 * Supports wildcards: "*.example.com" matches "sub.example.com" but not "example.com".
 * Exact match: "example.com" matches only "example.com".
 */
function matchDomain(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();

  if (pat.startsWith("*.")) {
    const suffix = pat.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  return host === pat;
}

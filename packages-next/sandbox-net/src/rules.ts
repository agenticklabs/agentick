/**
 * Pure network-rule matching (ADR 59).
 *
 * Evaluates an egress request against an ordered list of {@link NetworkRule}s.
 * First matching rule wins; the default action is **deny**. OS-free — no
 * sockets, no proxy server — so every egress-enforcing provider (the local
 * HTTP proxy, a future docker/remote enforcer) shares one matcher without a
 * wrong-direction dependency on any one provider.
 *
 * Ported faithfully from v1 `@agentick/sandbox-local/network/rules.ts`,
 * retyped against the shared `spec-next` wire vocabulary.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 * @verifiedBy packages-next/sandbox-net-next/src/__tests__/rules.spec.ts
 */

import type { NetworkRule, ProxiedRequest } from "@agentick/spec-next";

/**
 * The fields of an egress request the matcher inspects — a subset of
 * {@link ProxiedRequest} (the full audit record adds timestamp / blocked /
 * matchedRule). Providers construct one per request and feed it to
 * {@link matchRequest}.
 */
export type NetworkRequest = Pick<ProxiedRequest, "host" | "port" | "method" | "url">;

export interface MatchResult {
  readonly action: "allow" | "deny";
  readonly rule?: NetworkRule;
}

/**
 * Match a request against an ordered rule list. First matching rule wins.
 * Default (no rule matches): deny.
 */
export function matchRequest(request: NetworkRequest, rules: readonly NetworkRule[]): MatchResult {
  for (const rule of rules) {
    if (ruleMatches(request, rule)) {
      return { action: rule.action, rule };
    }
  }
  return { action: "deny" };
}

function ruleMatches(request: NetworkRequest, rule: NetworkRule): boolean {
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
 *   - `"*.example.com"` matches `"sub.example.com"` but NOT `"example.com"`.
 *   - `"example.com"` matches only `"example.com"` (exact).
 *
 * Case-insensitive.
 */
export function matchDomain(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();

  if (pat.startsWith("*.")) {
    const suffix = pat.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  return host === pat;
}

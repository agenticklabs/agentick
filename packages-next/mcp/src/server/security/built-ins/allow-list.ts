/**
 * `allowListGuard` — IP / origin allowlist `ConnectionGuard`.
 *
 * Accepts connections whose remote address matches one of the supplied
 * IPv4 CIDRs, IPv6 prefixes, or whose origin matches one of the
 * supplied globs (e.g., `https://*.example.com`).
 *
 * Empty allowlist = reject everything. Use this when you need to
 * lock down a public-facing HTTP/WS server to specific known clients.
 *
 * Ported from v1 `packages/mcp/src/server/security/stages.ts`. IPv4
 * CIDR + IPv6 prefix support is included; full IPv6 CIDR (with
 * non-byte-aligned masks) intentionally simplified to byte-aligned
 * prefixes — adopters needing finer matching wrap with their own
 * library.
 */

import type { ConnectionGuard, McpConnectionInfo } from "../stages.js";

export interface AllowListGuardOptions {
  /** Allowed remote addresses — exact match, IPv4 CIDR, or IPv6 prefix. */
  readonly addresses?: readonly string[];
  /** Allowed origins — glob support: `*.example.com`, `https://*.example.com`. */
  readonly origins?: readonly string[];
  /**
   * Mode for combining `addresses` + `origins`:
   *   - `"any"` (default) — match either list
   *   - `"all"` — must match BOTH (rare; only useful for defense-in-depth)
   */
  readonly mode?: "any" | "all";
}

export function allowListGuard(options: AllowListGuardOptions): ConnectionGuard {
  const addresses = (options.addresses ?? []).map(parseAddressPattern).filter((m) => m !== null);
  const origins = (options.origins ?? []).map(globToRegex);
  const mode = options.mode ?? "any";

  return async (info: McpConnectionInfo) => {
    const addressMatch =
      addresses.length === 0
        ? null
        : addresses.some((matcher) => (info.remoteAddress ? matcher!(info.remoteAddress) : false));
    const originMatch =
      origins.length === 0
        ? null
        : origins.some((re) => (info.origin ? re.test(info.origin) : false));

    if (mode === "all") {
      return Boolean(addressMatch) && Boolean(originMatch);
    }
    // "any" — if either list is configured AND matches, accept; if both empty, reject.
    if (addressMatch === null && originMatch === null) return false;
    return Boolean(addressMatch) || Boolean(originMatch);
  };
}

type AddressMatcher = (remote: string) => boolean;

function parseAddressPattern(pattern: string): AddressMatcher | null {
  // CIDR — `ip/prefix`
  if (pattern.includes("/")) {
    const [base, prefixRaw] = pattern.split("/");
    if (!base || !prefixRaw) return null;
    const prefix = Number(prefixRaw);
    if (!Number.isFinite(prefix) || prefix < 0) return null;

    // IPv4 CIDR
    const ipv4 = ipv4ToInt(base);
    if (ipv4 !== null) {
      if (prefix > 32) return null;
      const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
      const baseMasked = ipv4 & mask;
      return (remote) => {
        const remoteInt = ipv4ToInt(remote);
        return remoteInt !== null && (remoteInt & mask) === baseMasked;
      };
    }

    // IPv6 prefix — byte-aligned only.
    const ipv6 = ipv6ToBits(base);
    if (ipv6 !== null) {
      if (prefix > 128 || prefix % 4 !== 0) return null;
      const want = ipv6.slice(0, prefix / 4);
      return (remote) => {
        const remoteBits = ipv6ToBits(remote);
        return remoteBits !== null && remoteBits.startsWith(want);
      };
    }
    return null;
  }

  // Exact match.
  return (remote) => remote === pattern;
}

function ipv4ToInt(addr: string): number | null {
  // Tolerate `::ffff:127.0.0.1` form.
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function ipv6ToBits(addr: string): string | null {
  // Tolerate IPv4-mapped IPv6 — convert to plain v6 hex.
  let work = addr;
  const v4MappedMatch = work.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    const v4Int = ipv4ToInt(v4MappedMatch[2]!);
    if (v4Int === null) return null;
    work = `${v4MappedMatch[1]}:${((v4Int >>> 16) & 0xffff).toString(16)}:${(v4Int & 0xffff).toString(16)}`;
  }
  // Expand `::` once.
  const parts = work.split("::");
  if (parts.length > 2) return null;
  let groups: string[];
  if (parts.length === 2) {
    const left = parts[0]!.split(":").filter(Boolean);
    const right = parts[1]!.split(":").filter(Boolean);
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill("0"), ...right];
  } else {
    groups = work.split(":");
    if (groups.length !== 8) return null;
  }
  let out = "";
  for (const g of groups) {
    if (g.length > 4) return null;
    const n = Number.parseInt(g || "0", 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    out += n.toString(16).padStart(4, "0");
  }
  return out;
}

function globToRegex(pattern: string): RegExp {
  // Escape regex metacharacters except `*`, then convert `*` to `.*`.
  const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

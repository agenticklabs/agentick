/**
 * Production security pipeline stages.
 *
 * Each factory returns a plain `ConnectionGuard`, `Authenticator`, `Authorizer`,
 * `RateLimiter`, or `InputSanitizer` function. Drop them into
 * `MCPServerOptions.security` — the pipeline handles rejection and
 * short-circuiting.
 *
 * All stages are pure, synchronous or async, and do not depend on any runtime
 * state other than what you configure at construction. No I/O, no external
 * dependencies. For OAuth-style bearer tokens you bring your own verifier;
 * for distributed rate limiting, swap in a Redis-backed limiter with the same
 * function signature.
 */

import type {
  Authenticator,
  Authorizer,
  ConnectionGuard,
  ConnectionInfo,
  InputSanitizer,
  OperationInfo,
  MCPRequestContext,
  RateLimiter,
} from "../../protocol/types.js";
import type { UserContext } from "@agentick/kernel";

// ============================================================================
// bearerTokenAuth — Authenticator factory
// ============================================================================

export interface BearerTokenAuthOptions {
  /**
   * Static token → user map. Useful for dev, internal tools, or fixed API keys.
   * Keys are raw token values (NOT "Bearer <token>"). Values become the
   * resolved user context.
   */
  tokens?: Record<string, UserContext>;

  /**
   * Custom async verifier for dynamic lookups (JWT, OAuth introspection, DB).
   * Receives the raw token (without "Bearer " prefix). Return the resolved
   * user on success, or `null` to reject.
   *
   * Called only if `tokens` does not contain the token.
   */
  verify?: (token: string) => Promise<UserContext | null> | UserContext | null;

  /**
   * Where to find the Authorization header. Default: `ctx.metadata.headers`
   * (case-insensitive lookup). Override for non-HTTP transports or if your
   * contextProvider stores headers differently.
   */
  extract?: (ctx: MCPRequestContext) => string | undefined;
}

/**
 * Bearer token authenticator. Reads the Authorization header from the request
 * context, extracts the token, and resolves it to a user.
 *
 * Requires your `contextProvider` to place headers (or the token itself) on
 * `ctx.metadata`. The default extractor looks for
 * `ctx.metadata.headers.authorization` (case-insensitive).
 *
 * ```typescript
 * const server = new MCPServer({
 *   ...,
 *   contextProvider: async (extra) => ({
 *     metadata: { headers: extra.requestInfo?.headers ?? {} },
 *   }),
 *   security: {
 *     authenticator: bearerTokenAuth({
 *       verify: async (token) => {
 *         const claims = await verifyJwt(token);
 *         return { id: claims.sub, roles: claims.roles };
 *       },
 *     }),
 *   },
 * });
 * ```
 */
export function bearerTokenAuth(options: BearerTokenAuthOptions): Authenticator {
  const { tokens, verify, extract = defaultExtract } = options;
  if (!tokens && !verify) {
    throw new Error("bearerTokenAuth requires at least one of `tokens` or `verify` to be provided");
  }

  return async (ctx) => {
    const header = extract(ctx);
    if (!header) {
      return { authenticated: false, reason: "Missing Authorization header" };
    }

    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return { authenticated: false, reason: "Expected 'Bearer <token>' in Authorization header" };
    }

    const token = match[1]!.trim();
    if (!token) {
      return { authenticated: false, reason: "Empty bearer token" };
    }

    if (tokens && tokens[token]) {
      ctx.user = tokens[token];
      return { authenticated: true };
    }

    if (verify) {
      try {
        const user = await verify(token);
        if (!user) {
          return { authenticated: false, reason: "Token rejected" };
        }
        ctx.user = user;
        return { authenticated: true };
      } catch {
        return { authenticated: false, reason: "Token verification failed" };
      }
    }

    return { authenticated: false, reason: "Unknown token" };
  };
}

function defaultExtract(ctx: MCPRequestContext): string | undefined {
  const headers = ctx.metadata?.headers as
    | Record<string, string | string[] | undefined>
    | undefined;
  if (!headers) return undefined;

  // Case-insensitive header lookup
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

// ============================================================================
// roleBasedAuthz — Authorizer factory
// ============================================================================

export interface RoleBasedAuthzOptions {
  /**
   * Rules map. Keys are operation patterns. Values are the roles that pass.
   *
   * Pattern syntax:
   *   - "tool_call:toolName" → exact tool call match
   *   - "tool_call:*"        → any tool call
   *   - "resource_read:*"    → any resource read
   *   - "resource_read:uri_prefix" → resource read whose name starts with prefix
   *   - "prompt_get:*"       → any prompt
   *   - "session_create"     → session creation
   *   - "*"                  → catch-all (applied if no specific rule matches)
   *
   * Rules are evaluated from most specific to least specific. The first
   * matching rule wins. Missing a matching rule means DENY.
   *
   * Empty `roles: []` for a pattern means "any authenticated user passes".
   */
  rules: Record<string, string[]>;

  /**
   * Function that returns the user's roles for a request. Default:
   * `ctx.user?.roles ?? []`. Override for multi-tenant or scope-based models.
   */
  getRoles?: (ctx: MCPRequestContext, op: OperationInfo) => string[] | undefined;
}

/**
 * Role-based access control.
 *
 * ```typescript
 * roleBasedAuthz({
 *   rules: {
 *     "tool_call:admin_reset": ["admin"],
 *     "tool_call:*": ["user", "admin"],
 *     "resource_read:*": [],              // any authenticated user
 *     "session_create": [],               // any authenticated user
 *   },
 * });
 * ```
 *
 * Specificity ordering (highest → lowest):
 *   1. `tool_call:specificTool`
 *   2. `tool_call:*`
 *   3. `*`
 *
 * A missing rule is an implicit deny — to allow everything, add `"*": []`.
 */
export function roleBasedAuthz(options: RoleBasedAuthzOptions): Authorizer {
  const { rules, getRoles = defaultGetRoles } = options;

  return async (ctx, op) => {
    const pattern = matchRule(op, rules);
    if (!pattern) {
      return {
        allowed: false,
        reason: `No authorization rule for ${op.type}${op.name ? `:${op.name}` : ""}`,
      };
    }

    const requiredRoles = rules[pattern]!;
    if (requiredRoles.length === 0) {
      // Empty roles array — any authenticated user passes
      return ctx.user ? { allowed: true } : { allowed: false, reason: "Authentication required" };
    }

    const userRoles = getRoles(ctx, op) ?? [];
    const hasRole = requiredRoles.some((r) => userRoles.includes(r));
    return hasRole
      ? { allowed: true }
      : { allowed: false, reason: `Requires one of: ${requiredRoles.join(", ")}` };
  };
}

function defaultGetRoles(ctx: MCPRequestContext): string[] | undefined {
  return ctx.user?.roles;
}

/** Find the most specific matching rule pattern. */
function matchRule(op: OperationInfo, rules: Record<string, string[]>): string | undefined {
  const specific = op.name ? `${op.type}:${op.name}` : undefined;
  const wildcard = `${op.type}:*`;
  const catchAll = "*";
  const bareType = op.type;

  if (specific && rules[specific]) return specific;
  if (rules[wildcard]) return wildcard;
  if (rules[bareType]) return bareType;
  if (rules[catchAll]) return catchAll;
  return undefined;
}

// ============================================================================
// slidingWindowLimiter — RateLimiter factory
// ============================================================================

export interface SlidingWindowLimiterOptions {
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Max requests allowed per window per key. */
  max: number;
  /**
   * Function that derives the rate-limit key from context + operation.
   * Default: `${ctx.user?.id ?? "anon"}:${op.type}`. Override to limit by
   * tool name, tenant, session, or any other dimension.
   */
  keyFn?: (ctx: MCPRequestContext, op: OperationInfo) => string;
  /**
   * Called with the rate-limit key when a request is rejected. Useful for
   * logging / metrics. Optional.
   */
  onReject?: (key: string, retryAfterMs: number) => void;
}

/**
 * In-memory sliding-window rate limiter. Tracks request timestamps per key,
 * trims entries older than `windowMs`, and rejects when the window count
 * exceeds `max`.
 *
 * ```typescript
 * slidingWindowLimiter({
 *   windowMs: 60_000,
 *   max: 100,
 *   keyFn: (ctx, op) => `${ctx.user?.id ?? "anon"}:${op.name ?? op.type}`,
 * });
 * ```
 *
 * For distributed rate limiting, replace this with a Redis-backed limiter
 * that implements the same `RateLimiter` function signature.
 *
 * **Memory characteristics:** O(max × active_keys) — each key retains at most
 * `max` timestamps. Inactive keys are garbage-collected on the next request
 * for a new key after `windowMs * 2` of inactivity (lazy cleanup to avoid a
 * background sweeper).
 */
export function slidingWindowLimiter(options: SlidingWindowLimiterOptions): RateLimiter {
  const { windowMs, max, keyFn = defaultKeyFn, onReject } = options;

  if (windowMs <= 0) throw new Error("slidingWindowLimiter: windowMs must be > 0");
  if (max <= 0) throw new Error("slidingWindowLimiter: max must be > 0");

  const buckets = new Map<string, number[]>();
  let lastCleanup = 0;

  return async (ctx, op) => {
    const now = Date.now();
    const key = keyFn(ctx, op);
    const cutoff = now - windowMs;

    // Lazy cleanup: every 2 * windowMs, prune empty buckets
    if (now - lastCleanup > windowMs * 2) {
      for (const [k, timestamps] of buckets) {
        const latest = timestamps[timestamps.length - 1];
        if (latest === undefined || latest < cutoff) {
          buckets.delete(k);
        }
      }
      lastCleanup = now;
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }

    // Trim expired timestamps from the front
    let i = 0;
    while (i < bucket.length && bucket[i]! < cutoff) i++;
    if (i > 0) bucket.splice(0, i);

    if (bucket.length >= max) {
      const oldest = bucket[0]!;
      const retryAfterMs = oldest + windowMs - now;
      onReject?.(key, retryAfterMs);
      return { allowed: false, retryAfterMs };
    }

    bucket.push(now);
    return { allowed: true };
  };
}

function defaultKeyFn(ctx: MCPRequestContext, op: OperationInfo): string {
  return `${ctx.user?.id ?? "anon"}:${op.type}`;
}

// ============================================================================
// allowListGuard — ConnectionGuard factory
// ============================================================================

export interface AllowListGuardOptions {
  /**
   * Allowed origin header values. Exact match or glob pattern (`*` wildcard).
   * Example: `["https://app.example.com", "https://*.example.com"]`
   *
   * If set, the origin must match at least one pattern. If unset, origin
   * is not checked.
   */
  origins?: string[];

  /**
   * Allowed remote IP addresses or CIDR ranges.
   * Supports IPv4 exact, IPv4 CIDR, IPv6 exact, IPv6 CIDR.
   * Example: `["127.0.0.1", "10.0.0.0/8", "::1", "fc00::/7"]`
   *
   * If set, the remoteAddress must match at least one entry. If unset,
   * remoteAddress is not checked.
   */
  remoteAddresses?: string[];

  /**
   * If true, requires BOTH origin and remoteAddress checks to pass.
   * If false (default), passes if EITHER check passes (or if only one is configured).
   */
  requireBoth?: boolean;
}

/**
 * Allow-list connection guard. Rejects connections whose origin or IP
 * address doesn't match the configured patterns.
 *
 * ```typescript
 * allowListGuard({
 *   origins: ["https://app.example.com", "https://*.example.com"],
 *   remoteAddresses: ["10.0.0.0/8", "127.0.0.1", "::1"],
 * });
 * ```
 */
export function allowListGuard(options: AllowListGuardOptions): ConnectionGuard {
  const { origins, remoteAddresses, requireBoth = false } = options;
  if (!origins && !remoteAddresses) {
    throw new Error("allowListGuard requires at least one of `origins` or `remoteAddresses`");
  }

  const originMatchers = origins?.map(globToRegex);
  const addressMatchers = remoteAddresses?.map(parseAddressPattern);

  return async (info: ConnectionInfo) => {
    const originOk = originMatchers
      ? info.origin !== undefined && originMatchers.some((r) => r.test(info.origin!))
      : undefined;

    const addrOk = addressMatchers
      ? info.remoteAddress !== undefined && addressMatchers.some((m) => m(info.remoteAddress!))
      : undefined;

    if (requireBoth) {
      return (originOk ?? true) && (addrOk ?? true);
    }

    // Either/or: if only one is configured, that one must pass.
    // If both are configured, either passing is sufficient.
    if (originOk === undefined) return addrOk ?? false;
    if (addrOk === undefined) return originOk ?? false;
    return originOk || addrOk;
  };
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // escape regex metachars
    .replace(/\*/g, ".*"); // * → .*
  return new RegExp(`^${escaped}$`, "i");
}

type AddressMatcher = (addr: string) => boolean;

function parseAddressPattern(pattern: string): AddressMatcher {
  // CIDR notation
  if (pattern.includes("/")) {
    const [base, bitsStr] = pattern.split("/");
    if (!base || !bitsStr) return () => false;
    const bits = Number.parseInt(bitsStr, 10);

    // IPv4 CIDR
    if (base.includes(".")) {
      const baseInt = ipv4ToInt(base);
      if (baseInt === null) return () => false;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const network = (baseInt & mask) >>> 0;
      return (addr) => {
        // Strip IPv4-mapped IPv6 prefix if present (::ffff:127.0.0.1)
        const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
        const addrInt = ipv4ToInt(v4);
        if (addrInt === null) return false;
        return (addrInt & mask) >>> 0 === network;
      };
    }

    // IPv6 CIDR — compare bit-prefix
    const baseBits = ipv6ToBits(base);
    if (!baseBits) return () => false;
    return (addr) => {
      const addrBits = ipv6ToBits(addr);
      if (!addrBits) return false;
      return baseBits.slice(0, bits) === addrBits.slice(0, bits);
    };
  }

  // Exact match — normalize IPv4-mapped addresses for loopback comparisons
  return (addr) => {
    if (addr === pattern) return true;
    // ::ffff:127.0.0.1 matches 127.0.0.1 and vice versa
    if (addr.startsWith("::ffff:") && addr.slice(7) === pattern) return true;
    if (pattern.startsWith("::ffff:") && pattern.slice(7) === addr) return true;
    return false;
  };
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function ipv6ToBits(addr: string): string | null {
  // Normalize :: shorthand
  if (!addr.includes(":")) return null;
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const full = [...left, ...new Array(missing).fill("0"), ...right];
  if (full.length !== 8) return null;

  let bits = "";
  for (const group of full) {
    const n = Number.parseInt(group, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    bits += n.toString(2).padStart(16, "0");
  }
  return bits;
}

// ============================================================================
// pathTraversalSanitizer — InputSanitizer factory
// ============================================================================

export interface PathTraversalSanitizerOptions {
  /**
   * Which input fields should be checked for path traversal. If omitted, all
   * string fields whose keys include "path", "file", "filename", "dir", or
   * "directory" (case-insensitive) are checked.
   */
  fields?: string[];

  /**
   * Optional allow-list of path prefixes. If set, sanitized paths must start
   * with one of these prefixes or the request is rejected. Useful when you
   * want to scope a `read_file` tool to a specific directory.
   *
   * Prefixes are compared after normalization.
   */
  allowedRoots?: string[];

  /**
   * Action when traversal is detected: "reject" (throw) or "strip" (remove
   * the offending `../` sequences and pass through). Default: "reject".
   */
  mode?: "reject" | "strip";
}

/**
 * Sanitize path-like fields in tool input to prevent directory traversal
 * attacks. Operates on specific fields (default: auto-detect by name).
 *
 * ```typescript
 * pathTraversalSanitizer({
 *   fields: ["path", "filename"],
 *   allowedRoots: ["/workspace/", "/tmp/"],
 *   mode: "reject",
 * });
 * ```
 *
 * What it detects:
 *   - Literal `..` path segments
 *   - URL-encoded `%2e%2e`
 *   - Double-URL-encoded sequences
 *   - Backslash variants on Windows-style paths
 *   - Null-byte truncation attempts
 *
 * **Important:** Path sanitization is a defense-in-depth measure, not a
 * substitute for real sandboxing. Use `@agentick/sandbox` or OS-level
 * chroot/namespace isolation for hard boundaries.
 */
export function pathTraversalSanitizer(
  options: PathTraversalSanitizerOptions = {},
): InputSanitizer {
  const { fields, allowedRoots, mode = "reject" } = options;

  return async (_ctx, _toolName, input) => {
    const keys = fields ?? detectPathFields(input);
    const result: Record<string, unknown> = { ...input };

    for (const key of keys) {
      const value = result[key];
      if (typeof value !== "string") continue;

      const sanitized = sanitizePath(value, mode);

      if (allowedRoots && allowedRoots.length > 0) {
        const withinRoot = allowedRoots.some((root) => {
          const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
          return sanitized === root.replace(/\/$/, "") || sanitized.startsWith(normalizedRoot);
        });
        if (!withinRoot) {
          throw new Error(`Path '${value}' is outside allowed roots: ${allowedRoots.join(", ")}`);
        }
      }

      result[key] = sanitized;
    }

    return result;
  };
}

function detectPathFields(input: Record<string, unknown>): string[] {
  const pathKeywords = ["path", "file", "filename", "dir", "directory"];
  return Object.keys(input).filter((key) => {
    const lower = key.toLowerCase();
    return pathKeywords.some((k) => lower.includes(k));
  });
}

function sanitizePath(value: string, mode: "reject" | "strip"): string {
  // Reject null bytes immediately — these truncate paths in C-based file APIs
  if (value.includes("\0")) {
    throw new Error("Path contains null byte");
  }

  // Decode URL-encoded sequences (handle double-encoding)
  let decoded = value;
  try {
    let next = decodeURIComponent(decoded);
    // Iterate in case of double-encoding, max 3 levels
    let rounds = 0;
    while (next !== decoded && rounds < 3) {
      decoded = next;
      next = decodeURIComponent(decoded);
      rounds++;
    }
  } catch {
    // Invalid encoding — treat as suspicious
    if (mode === "reject") {
      throw new Error("Path contains invalid URL encoding");
    }
  }

  // Normalize backslashes to forward slashes for consistent analysis
  const normalized = decoded.replace(/\\/g, "/");

  // Split into segments and detect traversal
  const segments = normalized.split("/");
  const hasTraversal = segments.some((seg) => seg === "..");

  if (hasTraversal) {
    if (mode === "reject") {
      throw new Error(`Path traversal detected in '${value}'`);
    }
    // Strip mode: resolve .. segments
    const stack: string[] = [];
    for (const seg of segments) {
      if (seg === "..") {
        stack.pop();
      } else if (seg !== "." && seg !== "") {
        stack.push(seg);
      }
    }
    return (normalized.startsWith("/") ? "/" : "") + stack.join("/");
  }

  return normalized;
}

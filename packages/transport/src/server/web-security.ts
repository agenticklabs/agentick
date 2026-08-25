/**
 * Shared web-security policy for the HTTP-facing server transports
 * (STATUS A2 §4c — the security-defaults pass).
 *
 * Every network-facing server edge (`transport-http`, `transport-websocket`)
 * runs its inbound crossing through one policy so the safe-by-default posture
 * is uniform and single-sourced. The rules below are DEFAULTS: each is
 * overridable through {@link WebSecurityOptions}, but the unconfigured policy
 * ships closed (capability, not opinion — ship the mechanism firmly with a
 * safe default the adopter can widen deliberately).
 *
 * The four wire-facing defaults:
 *
 *   1. **Cross-site rejection** — a request that is *clearly* cross-site
 *      (`Sec-Fetch-Site: cross-site`, or an `Origin` whose authority is
 *      neither same-origin nor in the explicit allowlist) is rejected. A
 *      request carrying neither header is a non-browser caller and is
 *      admitted (the local pole). This is the primary CSRF / drive-by
 *      defense for the exposed-loopback threat model (opencode CVE class:
 *      exposed server + a browser page = shell).
 *   2. **Host allow-list** — the effective `Host` must be a loopback name
 *      or an explicitly configured hostname. Blocks DNS-rebinding: an
 *      attacker DNS name resolving to `127.0.0.1` arrives with a foreign
 *      `Host` and is rejected.
 *   3. **Forwarded-header trust only from a loopback peer** — `X-Forwarded-
 *      Host` / `X-Forwarded-Proto` are honored ONLY when `trustProxy` is on
 *      AND the immediate TCP peer is loopback (the reverse-proxy pattern).
 *      A direct non-loopback peer cannot spoof its way past the host check.
 *   4. **CSRF token** — a per-process random token, issued on the bootstrap
 *      handshake (the GET notification stream / any read) and required in a
 *      custom header ({@link CSRF_HEADER}) on every mutation. A cross-origin
 *      page cannot read the token (CORS blocks the read) nor set the custom
 *      header on a simple request, so it cannot forge a mutation.
 *
 * CORS is NEVER permissive: {@link WebSecurityPolicy.corsHeadersFor} echoes an
 * explicitly-allowlisted origin and nothing else — there is no code path that
 * emits `Access-Control-Allow-Origin: *`.
 *
 * @see docs/proposals/v2/STATUS.md — ROADMAP A2
 */

import { randomBytes } from "node:crypto";

import { CSRF_HEADER } from "../shared/wire.js";

/**
 * The CSRF header is the request header carrying the token on mutations, and
 * the response header the server issues it on. A custom (non-CORS-safelisted)
 * header cannot be set cross-origin without a preflight, which the
 * non-permissive CORS policy denies — so its mere presence is CSRF-meaningful.
 * It lives in `shared/wire.ts` because the client has to send what this checks.
 */
export { CSRF_HEADER };

/**
 * Default bind address for port-owning server transports — loopback only.
 * Widening to a public interface is an explicit, documented opt-in (the
 * `host` field on the port config) and is the security boundary.
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** HTTP methods that mutate server state and therefore require the CSRF token. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Adopter-facing web-security configuration. All fields are optional; the
 * empty/omitted config yields the safe default posture. Flat by convention
 * (no nested `config` object) — the fields ride directly on each server's
 * options.
 */
export interface WebSecurityOptions {
  /**
   * Cross-origin allow-list. Omitted / empty → same-origin only. Entries are
   * full origins (`https://app.example.com`) or SUBDOMAIN PATTERNS with one
   * `*` confined to the leftmost hostname label —
   * `https://*.staging.example.com`, prefix form
   * `https://pr-*.staging.example.com`. The `*` never matches a dot (one
   * label deep), the scheme is required, and a pattern port must match
   * exactly. Admission through a pattern is bounded by DNS control of the
   * parent domain — the preview-deploy shape — at the documented cost that a
   * subdomain takeover on that zone becomes an allowlist bypass.
   *
   * Still NEVER `"*"`: a bare wildcard, a wildcard outside the leftmost
   * label, or a pattern with fewer than two literal labels after it
   * (`https://*.com`) is refused AT CONSTRUCTION with a thrown error — full
   * permissiveness is a security regression this policy refuses to express.
   * Patterns feed the ORIGIN checks only; they never widen the `Host`
   * allow-list (the DNS-rebinding defense stays explicit).
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Extra `Host` header values to accept beyond loopback + the hosts implied
   * by {@link allowedOrigins}. Hostnames or `host:port`. Required when serving
   * under a real hostname (behind a proxy or on a public bind).
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Trust `X-Forwarded-Host` / `X-Forwarded-Proto` — but ONLY when the
   * immediate TCP peer is loopback (the reverse-proxy pattern). Default
   * `false`: forwarded headers are ignored and the real `Host` governs.
   */
  readonly trustProxy?: boolean;
  /**
   * CSRF token requirement on mutations. Default `true`. Set `false` for a
   * non-browser deployment (a native client that cannot run the handshake, a
   * trusted service mesh) — the cross-site / host defenses stay in force.
   */
  readonly csrf?: boolean;
}

/** Verdict from a policy check. `ok: false` carries the wire status + reason. */
export interface WebSecurityVerdict {
  readonly ok: boolean;
  readonly status?: number;
  readonly reason?: string;
}

/**
 * The structural slice of a Node `http.IncomingMessage` the policy reads.
 * Kept structural so the policy is unit-testable with a plain object and the
 * package needs no `node:http` value import.
 */
export interface WebRequestLike {
  readonly method?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/** Effective host authority + protocol after applying forwarded-header trust. */
export interface EffectivePeer {
  readonly host: string | undefined;
  readonly proto: string;
}

export interface WebSecurityPolicy {
  /** The per-process CSRF token. Stable for the lifetime of the policy. */
  readonly csrfToken: string;
  /** Whether the CSRF token is required on mutations. */
  readonly csrfEnabled: boolean;
  /** Resolve the effective host/proto for a request (honors forwarded trust). */
  effectivePeer(req: WebRequestLike): EffectivePeer;
  /**
   * Host allow-list + cross-site gate. Shared by HTTP (per request) and
   * WebSocket (per upgrade). Does NOT check CSRF — issuance must happen after
   * this passes, so the two are separate steps.
   */
  checkAccess(req: WebRequestLike): WebSecurityVerdict;
  /**
   * CSRF gate — token required on mutation methods when enabled. Read methods
   * (GET/HEAD/OPTIONS) and a disabled policy always pass.
   */
  checkCsrf(req: WebRequestLike): WebSecurityVerdict;
  /**
   * CORS response headers for an allowlisted cross-origin request, or
   * `undefined` when the origin is same-origin (no CORS needed) or not
   * allowlisted (no headers emitted — the request is rejected elsewhere).
   * NEVER returns a wildcard `Access-Control-Allow-Origin`.
   */
  corsHeadersFor(
    origin: string | undefined,
    req: WebRequestLike,
  ): Record<string, string> | undefined;
}

/**
 * True when `addr` is an IPv4/IPv6 loopback address. Used both for the host
 * allow-list (loopback `Host` names) and for the forwarded-header trust gate
 * (the immediate peer must be loopback).
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1" || a === "127.0.0.1") return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) and the whole 127.0.0.0/8 block.
  if (a.startsWith("::ffff:")) return isLoopbackAddress(a.slice("::ffff:".length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Loopback hostnames (no port) accepted in the `Host` header by default. */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** First value of a possibly-array header, lowercased-key access assumed by node. */
function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Lowercased authority (`host[:port]`) of a raw `Host` header, brackets kept for IPv6. */
function normalizeAuthority(hostHeader: string): string {
  return hostHeader.trim().toLowerCase();
}

/** Extract the hostname (no port) from an authority, unwrapping `[::1]`. */
function hostnameOf(authority: string): string {
  const a = authority.trim().toLowerCase();
  if (a.startsWith("[")) {
    const end = a.indexOf("]");
    return end > 0 ? a.slice(1, end) : a;
  }
  const colon = a.indexOf(":");
  return colon >= 0 ? a.slice(0, colon) : a;
}

/** Authority (`host[:port]`, default ports dropped) of an `Origin` URL, or undefined. */
function originAuthority(origin: string): string | undefined {
  try {
    const u = new URL(origin);
    // `URL.host` includes a non-default port and drops default 80/443 — exactly
    // the normalization we want for same-origin authority comparison.
    return u.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Escape a literal for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile one `allowedOrigins` subdomain pattern (an entry containing `*`)
 * into an origin matcher, refusing every form that degenerates toward full
 * permissiveness. The rules are the {@link WebSecurityOptions.allowedOrigins}
 * contract; violations THROW so a misconfigured allowlist fails loud at
 * construction instead of shipping silently permissive.
 */
function compileOriginPattern(entry: string): (origin: URL) => boolean {
  const refuse = (why: string): never => {
    throw new Error(`allowedOrigins pattern "${entry}": ${why}`);
  };
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)$/.exec(entry);
  if (!m) refuse("must be scheme://host[:port] with no path");
  const [, scheme, authority] = m!;
  if (authority!.includes("[")) refuse("IPv6 literals cannot carry a wildcard");
  const colon = authority!.lastIndexOf(":");
  const hostname = colon >= 0 ? authority!.slice(0, colon) : authority!;
  const port = colon >= 0 ? authority!.slice(colon + 1) : "";
  if (port !== "" && !/^\d+$/.test(port)) refuse("port must be numeric");
  const labels = hostname.split(".");
  const [head, ...rest] = labels;
  if ((head!.match(/\*/g) ?? []).length !== 1 || rest.some((l) => l.includes("*"))) {
    refuse("exactly one * is allowed, confined to the leftmost hostname label");
  }
  if (rest.length < 2) refuse("at least two literal labels must follow the wildcard");
  if (rest.some((l) => l.length === 0)) refuse("empty hostname label");
  const [before, after] = head!.split("*");
  const label =
    before === "" && after === ""
      ? "[^.]+"
      : `${escapeRegExp(before!)}[^.]*${escapeRegExp(after!)}`;
  const hostRe = new RegExp(`^${label}\\.${rest.map(escapeRegExp).join("\\.")}$`);
  const defaultPort = scheme === "https" ? "443" : scheme === "http" ? "80" : "";
  const wantPort = port === "" || port === defaultPort ? "" : port;
  return (origin) => {
    if (origin.protocol !== `${scheme}:`) return false;
    if ((origin.port || "") !== wantPort) return false;
    return hostRe.test(origin.hostname);
  };
}

export function resolveWebSecurity(options?: WebSecurityOptions): WebSecurityPolicy {
  const entries = (options?.allowedOrigins ?? []).map((o) => o.toLowerCase());
  for (const entry of entries) {
    if (entry === "*") {
      throw new Error(
        'allowedOrigins: "*" is refused — a permissive origin disables the cross-site defense',
      );
    }
  }
  const allowedOrigins = new Set(entries.filter((o) => !o.includes("*")));
  const originPatterns = entries.filter((o) => o.includes("*")).map(compileOriginPattern);
  // Pattern entries deliberately excluded: a wildcard ORIGIN must not widen
  // the Host allow-list (DNS-rebinding defense) — hosts stay explicit.
  const allowedOriginAuthorities = new Set(
    [...allowedOrigins].map((o) => originAuthority(o)).filter((a): a is string => a !== undefined),
  );
  /** Exact allowlist hit, or a subdomain-pattern match. Input lowercased. */
  function originAllowed(originLower: string): boolean {
    if (allowedOrigins.has(originLower)) return true;
    if (originPatterns.length === 0) return false;
    try {
      const parsed = new URL(originLower);
      return originPatterns.some((match) => match(parsed));
    } catch {
      return false;
    }
  }
  const allowedHosts = new Set((options?.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const trustProxy = options?.trustProxy ?? false;
  const csrfEnabled = options?.csrf ?? true;
  const csrfToken = randomBytes(32).toString("base64url");

  function effectivePeer(req: WebRequestLike): EffectivePeer {
    const rawHost = firstHeader(req.headers.host);
    const proto = firstHeader(req.headers["x-forwarded-proto"]);
    const fwdHost = firstHeader(req.headers["x-forwarded-host"]);
    const peerLoopback = isLoopbackAddress(req.socket?.remoteAddress);
    if (trustProxy && peerLoopback && fwdHost) {
      return {
        host: normalizeAuthority(fwdHost.split(",")[0]!),
        proto: (proto?.split(",")[0]?.trim() ?? "http").toLowerCase(),
      };
    }
    return {
      host: rawHost ? normalizeAuthority(rawHost) : undefined,
      proto: "http",
    };
  }

  function hostAllowed(effectiveHost: string | undefined): boolean {
    if (effectiveHost === undefined) return false; // HTTP/1.1 requires Host; missing → reject.
    if (allowedHosts.has(effectiveHost)) return true;
    const hostname = hostnameOf(effectiveHost);
    if (allowedHosts.has(hostname)) return true;
    if (isLoopbackHostname(hostname)) return true;
    if (allowedOriginAuthorities.has(effectiveHost)) return true;
    return false;
  }

  function checkAccess(req: WebRequestLike): WebSecurityVerdict {
    const { host } = effectivePeer(req);

    if (!hostAllowed(host)) {
      return { ok: false, status: 403, reason: `host not allowed: ${host ?? "<missing>"}` };
    }

    const secFetchSite = firstHeader(req.headers["sec-fetch-site"])?.toLowerCase();
    const origin = firstHeader(req.headers.origin);

    // A browser cross-site fetch-metadata signal, not overridden by an
    // explicit origin allowlist entry, is a hard reject.
    if (secFetchSite === "cross-site") {
      if (!(origin && originAllowed(origin.toLowerCase()))) {
        return { ok: false, status: 403, reason: "cross-site request rejected" };
      }
    }

    if (origin !== undefined) {
      const o = origin.toLowerCase();
      const oAuthority = originAuthority(o);
      const sameOrigin = oAuthority !== undefined && host !== undefined && oAuthority === host;
      if (!sameOrigin && !originAllowed(o)) {
        return { ok: false, status: 403, reason: `origin not allowed: ${origin}` };
      }
    }

    return { ok: true };
  }

  function checkCsrf(req: WebRequestLike): WebSecurityVerdict {
    if (!csrfEnabled) return { ok: true };
    const method = (req.method ?? "GET").toUpperCase();
    if (!MUTATION_METHODS.has(method)) return { ok: true };
    const presented = firstHeader(req.headers[CSRF_HEADER]);
    if (presented !== csrfToken) {
      return { ok: false, status: 403, reason: "missing or invalid CSRF token" };
    }
    return { ok: true };
  }

  function corsHeadersFor(
    origin: string | undefined,
    req: WebRequestLike,
  ): Record<string, string> | undefined {
    if (origin === undefined) return undefined;
    const o = origin.toLowerCase();
    const { host } = effectivePeer(req);
    const oAuthority = originAuthority(o);
    // Same-origin needs no CORS headers.
    if (oAuthority !== undefined && host !== undefined && oAuthority === host) return undefined;
    // Cross-origin: emit headers ONLY for an allowlisted origin (exact or
    // pattern-matched). Never a wildcard header — we echo the REQUEST's exact
    // origin, so the response is as narrow as the caller.
    if (!originAllowed(o)) return undefined;
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": `Content-Type, Mcp-Session-Id, Authorization, ${CSRF_HEADER}`,
      "Access-Control-Expose-Headers": `Mcp-Session-Id, ${CSRF_HEADER}`,
      Vary: "Origin",
    };
  }

  return {
    csrfToken,
    csrfEnabled,
    effectivePeer,
    checkAccess,
    checkCsrf,
    corsHeadersFor,
  };
}

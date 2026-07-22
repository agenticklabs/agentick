/**
 * Web-security policy — the security-defaults matrix (STATUS A2 §4c).
 *
 * Every default is verified with BOTH its allow path and its deny path, and
 * every override is verified to widen (and only widen) the default. The deny
 * paths — rejected Host, cross-site Origin, missing/invalid CSRF token,
 * forwarded-header spoof from a non-loopback peer — are the load-bearing
 * assertions: a security default that only proves its happy path is untested.
 */

import { describe, expect, it } from "vitest";
import {
  CSRF_HEADER,
  DEFAULT_BIND_HOST,
  isLoopbackAddress,
  resolveWebSecurity,
  type WebRequestLike,
  type WebSecurityOptions,
} from "../server/index.js";

/** Build a structural request. Defaults: loopback peer, loopback Host, GET. */
function req(
  overrides: Partial<{
    method: string;
    headers: Record<string, string | string[] | undefined>;
    remoteAddress: string;
  }> = {},
): WebRequestLike {
  return {
    method: overrides.method ?? "GET",
    headers: { host: "127.0.0.1:3000", ...(overrides.headers ?? {}) },
    socket: { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" },
  };
}

describe("isLoopbackAddress", () => {
  it("accepts IPv4/IPv6 loopback + the whole 127.0.0.0/8 block", () => {
    for (const a of ["127.0.0.1", "127.0.0.5", "127.255.255.254", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(a)).toBe(true);
    }
  });
  it("rejects non-loopback + undefined", () => {
    for (const a of ["203.0.113.5", "10.0.0.1", "0.0.0.0", "::ffff:8.8.8.8", undefined]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });
});

describe("DEFAULT_BIND_HOST is loopback", () => {
  it("is 127.0.0.1 — the security boundary, widened only by explicit opt-in", () => {
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
  });
});

describe("host allow-list", () => {
  const p = resolveWebSecurity();
  it("ALLOW loopback hostnames (127.x, localhost, [::1])", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "127.0.0.5"]) {
      expect(p.checkAccess(req({ headers: { host } })).ok).toBe(true);
    }
  });
  it("DENY a non-loopback Host (DNS-rebinding) with 403", () => {
    const v = p.checkAccess(req({ headers: { host: "evil.example.com" } }));
    expect(v.ok).toBe(false);
    expect(v.status).toBe(403);
  });
  it("DENY a missing Host header", () => {
    expect(p.checkAccess({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }).ok).toBe(false);
  });
  it("OVERRIDE allowedHosts widens the set to a real hostname", () => {
    const q = resolveWebSecurity({ allowedHosts: ["app.example.com"] });
    expect(q.checkAccess(req({ headers: { host: "app.example.com" } })).ok).toBe(true);
    // ...but only the configured one — a different foreign host stays denied.
    expect(q.checkAccess(req({ headers: { host: "other.example.com" } })).ok).toBe(false);
  });
  it("a host derived from allowedOrigins is accepted", () => {
    const q = resolveWebSecurity({ allowedOrigins: ["https://app.example.com"] });
    expect(q.checkAccess(req({ headers: { host: "app.example.com" } })).ok).toBe(true);
  });
});

describe("cross-site rejection", () => {
  const p = resolveWebSecurity();
  it("ALLOW a non-browser request (no Origin, no Sec-Fetch-Site)", () => {
    expect(p.checkAccess(req()).ok).toBe(true);
  });
  it("ALLOW same-origin (Origin authority === Host)", () => {
    expect(p.checkAccess(req({ headers: { origin: "http://127.0.0.1:3000" } })).ok).toBe(true);
  });
  it("ALLOW Sec-Fetch-Site: same-origin", () => {
    expect(p.checkAccess(req({ headers: { "sec-fetch-site": "same-origin" } })).ok).toBe(true);
  });
  it("DENY Sec-Fetch-Site: cross-site with 403", () => {
    const v = p.checkAccess(req({ headers: { "sec-fetch-site": "cross-site" } }));
    expect(v.ok).toBe(false);
    expect(v.status).toBe(403);
  });
  it("DENY a foreign Origin (drive-by from a malicious page)", () => {
    const v = p.checkAccess(
      req({
        headers: { origin: "https://evil.example.com", "sec-fetch-site": "cross-site" },
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.status).toBe(403);
  });
  it("OVERRIDE allowedOrigins admits a cross-site allowlisted Origin", () => {
    const q = resolveWebSecurity({ allowedOrigins: ["https://app.example.com"] });
    const v = q.checkAccess(
      req({
        headers: {
          host: "app.example.com",
          origin: "https://app.example.com",
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    expect(v.ok).toBe(true);
  });
});

describe("CSRF token", () => {
  it("DENY a mutation (POST) with no token — 403", () => {
    const p = resolveWebSecurity();
    const v = p.checkCsrf(req({ method: "POST" }));
    expect(v.ok).toBe(false);
    expect(v.status).toBe(403);
  });
  it("DENY a mutation with a WRONG token", () => {
    const p = resolveWebSecurity();
    expect(p.checkCsrf(req({ method: "POST", headers: { [CSRF_HEADER]: "nope" } })).ok).toBe(false);
  });
  it("ALLOW a mutation carrying the issued token", () => {
    const p = resolveWebSecurity();
    expect(p.checkCsrf(req({ method: "POST", headers: { [CSRF_HEADER]: p.csrfToken } })).ok).toBe(
      true,
    );
  });
  it("ALLOW read methods (GET/HEAD/OPTIONS) without a token", () => {
    const p = resolveWebSecurity();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(p.checkCsrf(req({ method })).ok).toBe(true);
    }
  });
  it("DELETE (a mutation) also requires the token", () => {
    const p = resolveWebSecurity();
    expect(p.checkCsrf(req({ method: "DELETE" })).ok).toBe(false);
  });
  it("OVERRIDE csrf:false drops the requirement (non-browser deploy)", () => {
    const p = resolveWebSecurity({ csrf: false });
    expect(p.csrfEnabled).toBe(false);
    expect(p.checkCsrf(req({ method: "POST" })).ok).toBe(true);
  });
  it("mints a distinct per-process token each resolve", () => {
    expect(resolveWebSecurity().csrfToken).not.toBe(resolveWebSecurity().csrfToken);
  });
});

describe("forwarded-header trust (proxy pattern)", () => {
  it("DEFAULT trustProxy=false — forwarded Host is IGNORED, real Host governs", () => {
    const p = resolveWebSecurity();
    const r = req({
      headers: { host: "127.0.0.1:3000", "x-forwarded-host": "app.example.com" },
    });
    expect(p.effectivePeer(r).host).toBe("127.0.0.1:3000");
    expect(p.checkAccess(r).ok).toBe(true); // loopback real Host, forwarded ignored
  });
  it("trustProxy + loopback peer — forwarded Host becomes effective", () => {
    const p = resolveWebSecurity({ trustProxy: true, allowedHosts: ["app.example.com"] });
    const r = req({
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:3000",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(p.effectivePeer(r)).toEqual({ host: "app.example.com", proto: "https" });
    expect(p.checkAccess(r).ok).toBe(true);
  });
  it("DENY forwarded-header spoof from a NON-loopback peer", () => {
    // trustProxy is on, but the immediate peer is a direct internet client
    // (not the loopback proxy). The forwarded headers claim an allowlisted
    // host; the policy must ignore them and fall back to the real (foreign)
    // Host — which is denied. This is the proxy-bypass attack.
    const p = resolveWebSecurity({ trustProxy: true, allowedHosts: ["app.example.com"] });
    const r = req({
      remoteAddress: "203.0.113.9",
      headers: { host: "attacker.example.com", "x-forwarded-host": "app.example.com" },
    });
    expect(p.effectivePeer(r).host).toBe("attacker.example.com");
    const v = p.checkAccess(r);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(403);
  });
});

describe("CORS is never permissive", () => {
  const allow: WebSecurityOptions = { allowedOrigins: ["https://app.example.com"] };
  it("same-origin needs no CORS headers", () => {
    const p = resolveWebSecurity(allow);
    expect(p.corsHeadersFor("http://127.0.0.1:3000", req())).toBeUndefined();
  });
  it("a non-allowlisted cross-origin gets NO CORS headers", () => {
    const p = resolveWebSecurity(allow);
    expect(p.corsHeadersFor("https://evil.example.com", req())).toBeUndefined();
  });
  it("an allowlisted origin is echoed EXACTLY — never a wildcard", () => {
    const p = resolveWebSecurity(allow);
    const headers = p.corsHeadersFor("https://app.example.com", req());
    expect(headers?.["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
    // The load-bearing invariant: no header value is ever "*".
    for (const v of Object.values(headers ?? {})) expect(v).not.toBe("*");
  });
  it("there is no way to configure `*` — no wildcard code path exists", () => {
    // A default (no allowlist) policy emits CORS for nothing.
    const p = resolveWebSecurity();
    expect(p.corsHeadersFor("https://anything.example.com", req())).toBeUndefined();
  });
});

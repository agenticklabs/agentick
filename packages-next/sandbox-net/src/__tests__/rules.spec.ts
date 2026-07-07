/**
 * `matchRequest` / `matchDomain` — the pure egress matcher (ADR 59).
 *
 * Pins the load-bearing invariants: first-match-wins ordering, default-deny,
 * `*.domain` wildcard semantics, and the per-field predicates (port, method,
 * urlPattern) the local proxy and docker/remote enforcers all share.
 */

import { describe, expect, it } from "vitest";
import type { NetworkRule } from "@agentick/spec-next";
import { matchDomain, matchRequest, type NetworkRequest } from "../rules.js";

const req = (over: Partial<NetworkRequest> = {}): NetworkRequest => ({
  host: "api.github.com",
  port: 443,
  method: "GET",
  url: "https://api.github.com/user",
  ...over,
});

describe("matchDomain", () => {
  it("matches exact domains case-insensitively", () => {
    expect(matchDomain("Example.com", "example.com")).toBe(true);
    expect(matchDomain("example.com", "example.org")).toBe(false);
  });

  it("*.domain matches subdomains but NOT the apex", () => {
    expect(matchDomain("sub.example.com", "*.example.com")).toBe(true);
    expect(matchDomain("a.b.example.com", "*.example.com")).toBe(true);
    expect(matchDomain("example.com", "*.example.com")).toBe(false);
  });
});

describe("matchRequest — ordering + default", () => {
  it("defaults to deny when no rule matches", () => {
    expect(matchRequest(req(), [])).toEqual({ action: "deny" });
    expect(matchRequest(req(), [{ action: "allow", domain: "other.com" }])).toEqual({
      action: "deny",
    });
  });

  it("first matching rule wins", () => {
    const rules: NetworkRule[] = [
      { action: "deny", domain: "*.github.com" },
      { action: "allow", domain: "api.github.com" },
    ];
    const result = matchRequest(req(), rules);
    expect(result.action).toBe("deny");
    expect(result.rule).toBe(rules[0]);
  });

  it("returns the matched allow rule", () => {
    const rule: NetworkRule = { action: "allow", domain: "api.github.com" };
    expect(matchRequest(req(), [rule])).toEqual({ action: "allow", rule });
  });
});

describe("matchRequest — per-field predicates", () => {
  it("filters by port", () => {
    const rule: NetworkRule = { action: "allow", domain: "api.github.com", port: 8080 };
    expect(matchRequest(req({ port: 443 }), [rule]).action).toBe("deny");
    expect(matchRequest(req({ port: 8080 }), [rule]).action).toBe("allow");
  });

  it("filters by method (case-insensitive)", () => {
    const rule: NetworkRule = { action: "allow", domain: "api.github.com", methods: ["post"] };
    expect(matchRequest(req({ method: "GET" }), [rule]).action).toBe("deny");
    expect(matchRequest(req({ method: "POST" }), [rule]).action).toBe("allow");
  });

  it("filters by urlPattern regex; invalid regex is treated as no-match", () => {
    const ok: NetworkRule = { action: "allow", urlPattern: "/user$" };
    expect(matchRequest(req(), [ok]).action).toBe("allow");
    const bad: NetworkRule = { action: "allow", urlPattern: "(" };
    expect(matchRequest(req(), [bad]).action).toBe("deny");
  });
});

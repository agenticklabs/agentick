import { describe, it, expect } from "vitest";
import { matchRequest } from "../network/rules.js";
import type { NetworkRule } from "@agentick/sandbox";

describe("matchRequest", () => {
  it("returns deny with no rules", () => {
    const result = matchRequest(
      { host: "example.com", port: 80, method: "GET", url: "http://example.com/" },
      [],
    );
    expect(result.action).toBe("deny");
    expect(result.rule).toBeUndefined();
  });

  it("matches exact domain", () => {
    const rules: NetworkRule[] = [{ action: "allow", domain: "api.github.com" }];
    const result = matchRequest(
      { host: "api.github.com", port: 443, method: "GET", url: "https://api.github.com/repos" },
      rules,
    );
    expect(result.action).toBe("allow");
    expect(result.rule).toBe(rules[0]);
  });

  it("does not match different domain", () => {
    const rules: NetworkRule[] = [{ action: "allow", domain: "api.github.com" }];
    const result = matchRequest(
      { host: "evil.com", port: 443, method: "GET", url: "https://evil.com/" },
      rules,
    );
    expect(result.action).toBe("deny");
  });

  it("matches wildcard domain", () => {
    const rules: NetworkRule[] = [{ action: "allow", domain: "*.github.com" }];

    expect(
      matchRequest(
        { host: "api.github.com", port: 443, method: "GET", url: "https://api.github.com/" },
        rules,
      ).action,
    ).toBe("allow");

    // Wildcard should NOT match the root domain itself
    expect(
      matchRequest(
        { host: "github.com", port: 443, method: "GET", url: "https://github.com/" },
        rules,
      ).action,
    ).toBe("deny");
  });

  it("matches by port", () => {
    const rules: NetworkRule[] = [{ action: "allow", port: 8080 }];

    expect(
      matchRequest(
        { host: "localhost", port: 8080, method: "GET", url: "http://localhost:8080/" },
        rules,
      ).action,
    ).toBe("allow");

    expect(
      matchRequest(
        { host: "localhost", port: 3000, method: "GET", url: "http://localhost:3000/" },
        rules,
      ).action,
    ).toBe("deny");
  });

  it("matches by HTTP method", () => {
    const rules: NetworkRule[] = [{ action: "allow", methods: ["GET", "HEAD"] }];

    expect(
      matchRequest(
        { host: "example.com", port: 80, method: "GET", url: "http://example.com/" },
        rules,
      ).action,
    ).toBe("allow");

    expect(
      matchRequest(
        { host: "example.com", port: 80, method: "POST", url: "http://example.com/" },
        rules,
      ).action,
    ).toBe("deny");
  });

  it("matches by URL pattern (regex)", () => {
    const rules: NetworkRule[] = [{ action: "allow", urlPattern: "/api/v[12]/" }];

    expect(
      matchRequest(
        { host: "example.com", port: 443, method: "GET", url: "https://example.com/api/v1/users" },
        rules,
      ).action,
    ).toBe("allow");

    expect(
      matchRequest(
        { host: "example.com", port: 443, method: "GET", url: "https://example.com/admin/" },
        rules,
      ).action,
    ).toBe("deny");
  });

  it("first match wins (deny before allow)", () => {
    const rules: NetworkRule[] = [
      { action: "deny", domain: "evil.example.com" },
      { action: "allow", domain: "*.example.com" },
    ];

    expect(
      matchRequest(
        { host: "evil.example.com", port: 443, method: "GET", url: "https://evil.example.com/" },
        rules,
      ).action,
    ).toBe("deny");

    expect(
      matchRequest(
        { host: "good.example.com", port: 443, method: "GET", url: "https://good.example.com/" },
        rules,
      ).action,
    ).toBe("allow");
  });

  it("combines domain, port, and method filters", () => {
    const rules: NetworkRule[] = [
      { action: "allow", domain: "api.example.com", port: 443, methods: ["GET"] },
    ];

    // All conditions match
    expect(
      matchRequest(
        { host: "api.example.com", port: 443, method: "GET", url: "https://api.example.com/" },
        rules,
      ).action,
    ).toBe("allow");

    // Wrong method
    expect(
      matchRequest(
        { host: "api.example.com", port: 443, method: "POST", url: "https://api.example.com/" },
        rules,
      ).action,
    ).toBe("deny");

    // Wrong port
    expect(
      matchRequest(
        { host: "api.example.com", port: 80, method: "GET", url: "http://api.example.com/" },
        rules,
      ).action,
    ).toBe("deny");
  });

  it("handles case-insensitive domain matching", () => {
    const rules: NetworkRule[] = [{ action: "allow", domain: "API.GitHub.com" }];
    expect(
      matchRequest(
        { host: "api.github.com", port: 443, method: "GET", url: "https://api.github.com/" },
        rules,
      ).action,
    ).toBe("allow");
  });

  it("handles case-insensitive method matching", () => {
    const rules: NetworkRule[] = [{ action: "allow", methods: ["get"] }];
    expect(
      matchRequest(
        { host: "example.com", port: 80, method: "GET", url: "http://example.com/" },
        rules,
      ).action,
    ).toBe("allow");
  });

  it("treats invalid regex as no match", () => {
    const rules: NetworkRule[] = [{ action: "allow", urlPattern: "[invalid" }];
    expect(
      matchRequest(
        { host: "example.com", port: 80, method: "GET", url: "http://example.com/" },
        rules,
      ).action,
    ).toBe("deny");
  });
});

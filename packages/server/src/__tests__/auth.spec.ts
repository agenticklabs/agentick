import { describe, it, expect } from "vitest";
import { extractToken, validateAuth, wwwAuthenticateHeader, type AuthConfig } from "../auth.js";

describe("extractToken", () => {
  it("extracts Bearer token from Authorization header", () => {
    expect(extractToken({ headers: { authorization: "Bearer abc123" } })).toBe("abc123");
  });

  it("returns undefined when no Authorization header", () => {
    expect(extractToken({ headers: {} })).toBeUndefined();
  });

  it("returns undefined for non-Bearer auth", () => {
    expect(extractToken({ headers: { authorization: "Basic abc123" } })).toBeUndefined();
  });
});

describe("validateAuth", () => {
  it("returns valid when no auth configured", async () => {
    const result = await validateAuth(undefined, undefined);
    expect(result.valid).toBe(true);
  });

  it("returns valid for type: none", async () => {
    const result = await validateAuth(undefined, { type: "none" });
    expect(result.valid).toBe(true);
  });

  describe("type: token", () => {
    const config: AuthConfig = { type: "token", token: "secret123" };

    it("rejects when no token provided", async () => {
      const result = await validateAuth(undefined, config);
      expect(result.valid).toBe(false);
    });

    it("rejects wrong token", async () => {
      const result = await validateAuth("wrong", config);
      expect(result.valid).toBe(false);
    });

    it("accepts correct token", async () => {
      const result = await validateAuth("secret123", config);
      expect(result.valid).toBe(true);
    });
  });

  describe("type: custom", () => {
    it("receives undefined when no token provided", async () => {
      let receivedToken: string | undefined = "should-be-overwritten";

      const config: AuthConfig = {
        type: "custom",
        validate: async (token) => {
          receivedToken = token;
          return { valid: true };
        },
      };

      const result = await validateAuth(undefined, config);
      expect(result.valid).toBe(true);
      expect(receivedToken).toBeUndefined();
    });

    it("can allow anonymous access (no token → valid)", async () => {
      const config: AuthConfig = {
        type: "custom",
        validate: async (token) => {
          if (!token) return { valid: true }; // anonymous
          return { valid: false };
        },
      };

      const result = await validateAuth(undefined, config);
      expect(result.valid).toBe(true);
    });

    it("can reject bad tokens", async () => {
      const config: AuthConfig = {
        type: "custom",
        validate: async (token) => {
          if (!token) return { valid: true };
          if (token === "good") return { valid: true, user: { id: "u1", roles: ["admin"] } };
          return { valid: false };
        },
      };

      const result = await validateAuth("bad-token", config);
      expect(result.valid).toBe(false);
    });

    it("can validate good tokens with user context", async () => {
      const config: AuthConfig = {
        type: "custom",
        validate: async (token) => {
          if (!token) return { valid: true };
          if (token === "good") return { valid: true, user: { id: "u1", roles: ["admin"] } };
          return { valid: false };
        },
      };

      const result = await validateAuth("good", config);
      expect(result.valid).toBe(true);
      expect(result.user).toEqual({ id: "u1", roles: ["admin"] });
    });
  });

  describe("hydrateUser", () => {
    it("calls hydrateUser when auth succeeds", async () => {
      const config: AuthConfig = {
        type: "token",
        token: "secret",
        hydrateUser: async () => ({ id: "hydrated-user", roles: ["admin"] }),
      };

      const result = await validateAuth("secret", config);
      expect(result.valid).toBe(true);
      expect(result.user?.id).toBe("hydrated-user");
    });

    it("does not call hydrateUser when auth fails", async () => {
      let called = false;
      const config: AuthConfig = {
        type: "token",
        token: "secret",
        hydrateUser: async () => {
          called = true;
          return { id: "should-not-be-called" };
        },
      };

      const result = await validateAuth("wrong", config);
      expect(result.valid).toBe(false);
      expect(called).toBe(false);
    });
  });
});

describe("wwwAuthenticateHeader", () => {
  it("returns bare Bearer when no config", () => {
    expect(wwwAuthenticateHeader(undefined)).toBe("Bearer");
  });

  it("returns bare Bearer when no resource configured", () => {
    const config: AuthConfig = { type: "token", token: "secret" };
    expect(wwwAuthenticateHeader(config)).toBe("Bearer");
  });

  it("includes resource parameter when configured", () => {
    const config: AuthConfig = {
      type: "token",
      token: "secret",
      resource: "https://example.com/api/v2/mcp",
    };
    expect(wwwAuthenticateHeader(config)).toBe('Bearer resource="https://example.com/api/v2/mcp"');
  });

  it("works with custom auth type", () => {
    const config: AuthConfig = {
      type: "custom",
      validate: async () => ({ valid: true }),
      resource: "https://mcp.knowify.com/api",
    };
    expect(wwwAuthenticateHeader(config)).toBe('Bearer resource="https://mcp.knowify.com/api"');
  });

  it("returns bare Bearer for type: none with no resource", () => {
    const config: AuthConfig = { type: "none" };
    expect(wwwAuthenticateHeader(config)).toBe("Bearer");
  });

  it("includes resource even for type: none", () => {
    const config: AuthConfig = {
      type: "none",
      resource: "https://example.com/mcp",
    };
    expect(wwwAuthenticateHeader(config)).toBe('Bearer resource="https://example.com/mcp"');
  });
});

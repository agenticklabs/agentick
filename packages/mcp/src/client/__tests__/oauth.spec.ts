/**
 * OAuth Tests
 *
 * Tests the OAuthProvider interface, SDK adapter, DefaultOAuthProvider,
 * and the auth flow integration in MCPClient._doConnect.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createSDKProvider,
  DefaultOAuthProvider,
  type OAuthProvider,
  type OAuthTokens,
  type OAuthClientInformationMixed,
  type OAuthDiscoveryState,
} from "../oauth.js";
import { MCPClient } from "../client.js";

// ============================================================================
// createSDKProvider — adapter tests
// ============================================================================

describe("createSDKProvider", () => {
  function createMockProvider(overrides?: Partial<OAuthProvider>): OAuthProvider {
    return {
      clientMetadata: {
        client_name: "test",
        redirect_uris: ["http://localhost/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      redirectUrl: "http://localhost/callback",
      loadTokens: vi.fn().mockReturnValue(undefined),
      saveTokens: vi.fn(),
      loadClientInfo: vi.fn().mockReturnValue(undefined),
      saveClientInfo: vi.fn(),
      redirectToAuthorization: vi.fn(),
      waitForAuthorizationCode: vi.fn().mockResolvedValue("test-code"),
      ...overrides,
    };
  }

  it("should pass through clientMetadata and redirectUrl", () => {
    const provider = createMockProvider();
    const sdk = createSDKProvider(provider);

    expect(sdk.clientMetadata).toBe(provider.clientMetadata);
    expect(sdk.redirectUrl).toBe(provider.redirectUrl);
  });

  it("should delegate tokens() to loadTokens()", async () => {
    const tokens: OAuthTokens = { access_token: "abc", token_type: "bearer" };
    const provider = createMockProvider({ loadTokens: vi.fn().mockReturnValue(tokens) });
    const sdk = createSDKProvider(provider);

    expect(await sdk.tokens()).toBe(tokens);
  });

  it("should delegate saveTokens()", async () => {
    const provider = createMockProvider();
    const sdk = createSDKProvider(provider);
    const tokens: OAuthTokens = { access_token: "abc", token_type: "bearer" };

    await sdk.saveTokens(tokens);
    expect(provider.saveTokens).toHaveBeenCalledWith(tokens);
  });

  it("should delegate clientInformation() to loadClientInfo()", async () => {
    const info = { client_id: "test-id" } as OAuthClientInformationMixed;
    const provider = createMockProvider({ loadClientInfo: vi.fn().mockReturnValue(info) });
    const sdk = createSDKProvider(provider);

    expect(await sdk.clientInformation()).toBe(info);
  });

  it("should delegate saveClientInformation() to saveClientInfo()", async () => {
    const provider = createMockProvider();
    const sdk = createSDKProvider(provider);
    const info = { client_id: "test-id" } as OAuthClientInformationMixed;

    await sdk.saveClientInformation!(info);
    expect(provider.saveClientInfo).toHaveBeenCalledWith(info);
  });

  it("should delegate redirectToAuthorization()", async () => {
    const provider = createMockProvider();
    const sdk = createSDKProvider(provider);
    const url = new URL("https://auth.example.com/authorize");

    await sdk.redirectToAuthorization(url);
    expect(provider.redirectToAuthorization).toHaveBeenCalledWith(url);
  });

  it("should delegate invalidateCredentials to onInvalidateCredentials", async () => {
    const onInvalidate = vi.fn();
    const provider = createMockProvider({ onInvalidateCredentials: onInvalidate });
    const sdk = createSDKProvider(provider);

    await sdk.invalidateCredentials!("tokens");
    expect(onInvalidate).toHaveBeenCalledWith("tokens");
  });

  it("should not throw if onInvalidateCredentials is not defined", () => {
    const provider = createMockProvider();
    const sdk = createSDKProvider(provider);

    expect(() => sdk.invalidateCredentials!("all")).not.toThrow();
  });

  // ── PKCE in-memory defaults ───────────────────────────────────────────

  describe("PKCE defaults", () => {
    it("should use in-memory storage when provider has no PKCE hooks", async () => {
      const provider = createMockProvider();
      const sdk = createSDKProvider(provider);

      await sdk.saveCodeVerifier("verifier-123");
      expect(await sdk.codeVerifier()).toBe("verifier-123");
    });

    it("should delegate to provider PKCE hooks when defined", async () => {
      let stored = "";
      const provider = createMockProvider({
        saveCodeVerifier: vi.fn((v) => {
          stored = v;
        }),
        loadCodeVerifier: vi.fn(() => stored),
      });
      const sdk = createSDKProvider(provider);

      await sdk.saveCodeVerifier("verifier-456");
      expect(provider.saveCodeVerifier).toHaveBeenCalledWith("verifier-456");
      expect(await sdk.codeVerifier()).toBe("verifier-456");
      expect(provider.loadCodeVerifier).toHaveBeenCalled();
    });
  });

  // ── Discovery cache in-memory defaults ────────────────────────────────

  describe("discovery cache defaults", () => {
    it("should use in-memory storage when provider has no discovery hooks", async () => {
      const provider = createMockProvider();
      const sdk = createSDKProvider(provider);

      const state: OAuthDiscoveryState = {
        authorizationServerUrl: "https://auth.example.com",
      };
      await sdk.saveDiscoveryState!(state);
      expect(await sdk.discoveryState!()).toBe(state);
    });

    it("should delegate to provider discovery hooks when defined", async () => {
      let stored: OAuthDiscoveryState | undefined;
      const provider = createMockProvider({
        saveDiscoveryState: vi.fn((s) => {
          stored = s;
        }),
        loadDiscoveryState: vi.fn(() => stored),
      });
      const sdk = createSDKProvider(provider);

      const state: OAuthDiscoveryState = {
        authorizationServerUrl: "https://auth.example.com",
      };
      await sdk.saveDiscoveryState!(state);
      expect(provider.saveDiscoveryState).toHaveBeenCalledWith(state);
      expect(await sdk.discoveryState!()).toBe(state);
    });
  });
});

// ============================================================================
// DefaultOAuthProvider
// ============================================================================

describe("DefaultOAuthProvider", () => {
  it("should generate default client metadata from server name", () => {
    const provider = new DefaultOAuthProvider({
      serverName: "my-server",
      serverUrl: "https://example.com/mcp",
    });

    expect(provider.clientMetadata.client_name).toBe("my-server");
    expect(provider.clientMetadata.grant_types).toEqual(["authorization_code"]);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("should use custom client metadata when provided", () => {
    const custom = {
      client_name: "Custom App",
      redirect_uris: ["https://myapp.com/callback"],
      grant_types: ["authorization_code"] as string[],
      response_types: ["code"] as string[],
      token_endpoint_auth_method: "client_secret_basic",
    };
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
      clientMetadata: custom,
    });

    expect(provider.clientMetadata).toBe(custom);
  });

  it("should use custom redirect URL when provided", () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
      redirectUrl: "https://myapp.com/oauth/callback",
    });

    expect(provider.redirectUrl).toBe("https://myapp.com/oauth/callback");
  });

  it("should default redirect URL to localhost", () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    expect(provider.redirectUrl).toBe("http://127.0.0.1:0/callback");
  });

  // ── In-memory token storage ───────────────────────────────────────────

  it("should store and retrieve tokens in memory", () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    expect(provider.loadTokens()).toBeUndefined();

    const tokens: OAuthTokens = { access_token: "abc", token_type: "bearer" };
    provider.saveTokens(tokens);
    expect(provider.loadTokens()).toBe(tokens);
  });

  // ── In-memory client info storage ─────────────────────────────────────

  it("should store and retrieve client info in memory", () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    expect(provider.loadClientInfo()).toBeUndefined();

    const info = { client_id: "test-id" } as OAuthClientInformationMixed;
    provider.saveClientInfo(info);
    expect(provider.loadClientInfo()).toBe(info);
  });

  // ── Authorization flow ────────────────────────────────────────────────

  it("should call onAuthorizationNeeded when redirecting", async () => {
    const onAuth = vi.fn();
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
      onAuthorizationNeeded: onAuth,
    });

    const url = new URL("https://auth.example.com/authorize");
    await provider.redirectToAuthorization(url);
    expect(onAuth).toHaveBeenCalledWith(url);
  });

  it("should not throw when no onAuthorizationNeeded is set", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    const url = new URL("https://auth.example.com/authorize");
    await expect(provider.redirectToAuthorization(url)).resolves.toBeUndefined();
  });

  // ── waitForAuthorizationCode / resolveAuthorizationCode ───────────────

  it("should resolve waitForAuthorizationCode when code is provided", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    // redirectToAuthorization creates the pending promise
    await provider.redirectToAuthorization(new URL("https://auth.example.com"));

    // Simulate callback arriving asynchronously
    setTimeout(() => provider.resolveAuthorizationCode("auth-code-123"), 10);

    const code = await provider.waitForAuthorizationCode();
    expect(code).toBe("auth-code-123");
  });

  it("should resolve with undefined when authorization is cancelled", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    await provider.redirectToAuthorization(new URL("https://auth.example.com"));

    setTimeout(() => provider.cancelAuthorization(), 10);

    const code = await provider.waitForAuthorizationCode();
    expect(code).toBeUndefined();
  });

  it("should return undefined from waitForAuthorizationCode if redirect was never called", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    const code = await provider.waitForAuthorizationCode();
    expect(code).toBeUndefined();
  });

  it("should handle multiple auth cycles correctly", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.com",
    });

    // First cycle
    await provider.redirectToAuthorization(new URL("https://auth.example.com"));
    setTimeout(() => provider.resolveAuthorizationCode("code-1"), 10);
    expect(await provider.waitForAuthorizationCode()).toBe("code-1");

    // Second cycle (e.g., reauth after token expiry)
    await provider.redirectToAuthorization(new URL("https://auth.example.com"));
    setTimeout(() => provider.resolveAuthorizationCode("code-2"), 10);
    expect(await provider.waitForAuthorizationCode()).toBe("code-2");
  });
});

// ============================================================================
// MCPClient auth resolution
// ============================================================================

describe("MCPClient auth config resolution", () => {
  // We test the resolution logic indirectly by verifying the transport
  // creation doesn't throw for various auth configs. The actual OAuth
  // flow is tested via the DefaultOAuthProvider tests above.

  it("should accept auth: { type: 'none' } without error", () => {
    const client = new MCPClient();
    // Accessing private method via prototype for white-box testing
    const resolve = (client as any).resolveAuthProvider.bind(client);

    const result = resolve({
      serverName: "test",
      transport: "streamable-http",
      connection: { url: "https://example.com" },
      auth: { type: "none" },
    });

    expect(result.sdkProvider).toBeUndefined();
    expect(result.oauthProvider).toBeUndefined();
  });

  it("should skip OAuth for bearer auth", () => {
    const client = new MCPClient();
    const resolve = (client as any).resolveAuthProvider.bind(client);

    const result = resolve({
      serverName: "test",
      transport: "streamable-http",
      connection: { url: "https://example.com" },
      auth: { type: "bearer", token: "static-token" },
    });

    expect(result.sdkProvider).toBeUndefined();
    expect(result.oauthProvider).toBeUndefined();
  });

  it("should create default OAuth provider for HTTP transport with no auth config", () => {
    const client = new MCPClient();
    const resolve = (client as any).resolveAuthProvider.bind(client);

    const result = resolve({
      serverName: "test-server",
      transport: "streamable-http",
      connection: { url: "https://example.com/mcp" },
    });

    expect(result.sdkProvider).toBeDefined();
    expect(result.oauthProvider).toBeDefined();
    expect(result.oauthProvider).toBeInstanceOf(DefaultOAuthProvider);
  });

  it("should not create OAuth provider for stdio transport with no auth config", () => {
    const client = new MCPClient();
    const resolve = (client as any).resolveAuthProvider.bind(client);

    const result = resolve({
      serverName: "test",
      transport: "stdio",
      connection: { command: "node", args: ["server.js"] },
    });

    expect(result.sdkProvider).toBeUndefined();
    expect(result.oauthProvider).toBeUndefined();
  });

  it("should not create OAuth provider for in-process transport with no auth config", () => {
    const client = new MCPClient();
    const resolve = (client as any).resolveAuthProvider.bind(client);

    const result = resolve({
      serverName: "test",
      transport: "in-process",
      connection: { transport: {} },
    });

    expect(result.sdkProvider).toBeUndefined();
    expect(result.oauthProvider).toBeUndefined();
  });

  it("should use custom OAuth provider when provided", () => {
    const client = new MCPClient();
    const resolve = (client as any).resolveAuthProvider.bind(client);

    const customProvider: OAuthProvider = {
      clientMetadata: {
        client_name: "custom",
        redirect_uris: ["https://myapp.com/cb"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      redirectUrl: "https://myapp.com/cb",
      loadTokens: () => undefined,
      saveTokens: () => {},
      loadClientInfo: () => undefined,
      saveClientInfo: () => {},
      redirectToAuthorization: () => {},
      waitForAuthorizationCode: () => Promise.resolve("code"),
    };

    const result = resolve({
      serverName: "test",
      transport: "sse",
      connection: { url: "https://example.com" },
      auth: { type: "oauth", provider: customProvider },
    });

    expect(result.sdkProvider).toBeDefined();
    expect(result.oauthProvider).toBe(customProvider);
  });

  it("should create default provider for SSE transport too", () => {
    const client = new MCPClient();
    const resolve = (client as any).resolveAuthProvider.bind(client);

    const result = resolve({
      serverName: "test",
      transport: "sse",
      connection: { url: "https://example.com/sse" },
    });

    expect(result.sdkProvider).toBeDefined();
    expect(result.oauthProvider).toBeInstanceOf(DefaultOAuthProvider);
  });
});

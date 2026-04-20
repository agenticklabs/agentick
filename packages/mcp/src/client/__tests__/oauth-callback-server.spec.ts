/**
 * OAuthCallbackServer Tests
 *
 * Tests the localhost callback server that receives OAuth redirects,
 * extracts authorization codes, and serves customizable success/error pages.
 */

import { describe, it, expect, afterEach } from "vitest";
import { OAuthCallbackServer } from "../oauth-callback-server.js";

let server: OAuthCallbackServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe("OAuthCallbackServer", () => {
  it("should start on a random port and return a redirect URL", async () => {
    server = new OAuthCallbackServer();
    const url = await server.start();

    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/callback");
    expect(Number(url.port)).toBeGreaterThan(0);
  });

  it("should resolve with the authorization code from the callback", async () => {
    server = new OAuthCallbackServer();
    const url = await server.start();

    const codePromise = server.waitForCode();

    // Simulate the OAuth redirect
    const callbackUrl = new URL(url.toString());
    callbackUrl.searchParams.set("code", "test-auth-code");
    callbackUrl.searchParams.set("state", "test-state");
    await fetch(callbackUrl.toString());

    const code = await codePromise;
    expect(code).toBe("test-auth-code");
  });

  it("should serve success HTML after receiving code", async () => {
    server = new OAuthCallbackServer();
    const url = await server.start();
    server.serverName = "Test Server";

    const codePromise = server.waitForCode();

    const callbackUrl = new URL(url.toString());
    callbackUrl.searchParams.set("code", "abc");
    const response = await fetch(callbackUrl.toString());

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Authorization Complete");
    expect(html).toContain("Test Server");

    await codePromise;
  });

  it("should serve custom success HTML when provided", async () => {
    server = new OAuthCallbackServer({
      successHtml: "<h1>Custom Success</h1>",
    });
    const url = await server.start();
    const codePromise = server.waitForCode();

    const callbackUrl = new URL(url.toString());
    callbackUrl.searchParams.set("code", "abc");
    const response = await fetch(callbackUrl.toString());

    const html = await response.text();
    expect(html).toBe("<h1>Custom Success</h1>");

    await codePromise;
  });

  it("should serve custom success HTML from function", async () => {
    server = new OAuthCallbackServer({
      successHtml: (name) => `<h1>Connected to ${name}</h1>`,
    });
    server.serverName = "MyServer";
    const url = await server.start();
    const codePromise = server.waitForCode();

    const callbackUrl = new URL(url.toString());
    callbackUrl.searchParams.set("code", "abc");
    const response = await fetch(callbackUrl.toString());

    const html = await response.text();
    expect(html).toBe("<h1>Connected to MyServer</h1>");

    await codePromise;
  });

  it("should resolve with undefined on OAuth error callback", async () => {
    server = new OAuthCallbackServer();
    const url = await server.start();
    const codePromise = server.waitForCode();

    const callbackUrl = new URL(url.toString());
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("error_description", "User denied access");
    await fetch(callbackUrl.toString());

    const code = await codePromise;
    expect(code).toBeUndefined();
  });

  it("should return 400 when no code param is present", async () => {
    server = new OAuthCallbackServer();
    const url = await server.start();

    const response = await fetch(url.toString());
    expect(response.status).toBe(400);

    const html = await response.text();
    expect(html).toContain("No authorization code received");
  });

  it("should return 404 for non-callback paths", async () => {
    server = new OAuthCallbackServer();
    const url = await server.start();

    const otherUrl = new URL(url.toString());
    otherUrl.pathname = "/other";
    const response = await fetch(otherUrl.toString());
    expect(response.status).toBe(404);
  });

  it("should use custom path when configured", async () => {
    server = new OAuthCallbackServer({ path: "/oauth/done" });
    const url = await server.start();

    expect(url.pathname).toBe("/oauth/done");

    const codePromise = server.waitForCode();
    const callbackUrl = new URL(url.toString());
    callbackUrl.searchParams.set("code", "xyz");
    await fetch(callbackUrl.toString());

    expect(await codePromise).toBe("xyz");
  });

  it("should timeout and resolve with undefined", async () => {
    server = new OAuthCallbackServer({ timeout: 100 });
    await server.start();

    const code = await server.waitForCode();
    expect(code).toBeUndefined();
  });

  it("should stop cleanly", async () => {
    server = new OAuthCallbackServer();
    await server.start();
    await server.stop();

    // Double stop should not throw
    await server.stop();
    server = undefined;
  });
});

/**
 * `McpClientHarness` credentials integration — #277b Commit B.
 *
 * Three concerns pinned:
 *
 *   1. `DefaultOAuthProvider` reads through a `CredentialsHarness`
 *      when wired with `credentials` + `keyOf`. Tokens / client info
 *      written via `saveTokens` / `saveClientInfo` land in the
 *      substrate store; subsequent reads hit the same store.
 *   2. The provider's non-interactive guard throws
 *      `McpCredentialsRequiredError` from `redirectToAuthorization`
 *      when `interactive: false`. Discriminates `missing` vs
 *      `expired` based on whether `onInvalidateCredentials("tokens")`
 *      fired previously.
 *   3. The harness's `connect()` catch buckets that thrown error
 *      into `credentials-missing` / `credentials-expired` status,
 *      walking the cause chain so SDK wrappers don't hide the lift.
 *
 * The full OAuth handshake against a live HTTP transport is out of
 * scope here (covered by the SDK's own tests + integration suites);
 * these tests target the new seams.
 */

import { describe, expect, it } from "vitest";

import { fakeCredentialsHarness, fakeCredentialProvider } from "@agentick/credentials/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { McpCredentialsRequiredError } from "@agentick/spec";

import { DefaultOAuthProvider } from "../oauth/default-provider.js";
import { InMemoryMcpTransport, McpClientHarness, NoneAuth } from "../index.js";

describe("DefaultOAuthProvider — credentials read-through", () => {
  it("tokens round-trip via the substrate store", async () => {
    const { harness: creds } = fakeCredentialsHarness({
      providers: [fakeCredentialProvider({ namespace: "mcp" })],
    });
    const provider = new DefaultOAuthProvider({
      serverName: "linear",
      serverUrl: "https://example.invalid",
      credentials: creds,
      keyOf: (field) => `mcp:linear:${field}`,
    });

    expect(await provider.loadTokens()).toBeUndefined();
    await provider.saveTokens({ access_token: "tok-1", token_type: "Bearer" });
    expect(await provider.loadTokens()).toEqual({ access_token: "tok-1", token_type: "Bearer" });

    // Direct store inspection — the provider wrote to the canonical
    // namespace / key.
    expect(await creds.get("mcp", "mcp:linear:tokens")).toEqual({
      access_token: "tok-1",
      token_type: "Bearer",
    });

    await creds.close();
  });

  it("client info round-trips independently of tokens", async () => {
    const { harness: creds } = fakeCredentialsHarness({
      providers: [fakeCredentialProvider({ namespace: "mcp" })],
    });
    const provider = new DefaultOAuthProvider({
      serverName: "linear",
      serverUrl: "https://example.invalid",
      credentials: creds,
      keyOf: (field) => `mcp:linear:${field}`,
    });

    await provider.saveClientInfo({ client_id: "cid", redirect_uris: ["http://x"] });
    expect((await provider.loadClientInfo())?.client_id).toBe("cid");
    expect(await provider.loadTokens()).toBeUndefined();

    await creds.close();
  });

  it("onInvalidateCredentials('tokens') deletes from the store", async () => {
    const { harness: creds } = fakeCredentialsHarness({
      providers: [fakeCredentialProvider({ namespace: "mcp" })],
    });
    const provider = new DefaultOAuthProvider({
      serverName: "linear",
      serverUrl: "https://example.invalid",
      credentials: creds,
      keyOf: (field) => `mcp:linear:${field}`,
    });
    await provider.saveTokens({ access_token: "tok", token_type: "Bearer" });

    await provider.onInvalidateCredentials("tokens");

    expect(await provider.loadTokens()).toBeUndefined();
    expect(await creds.has("mcp", "mcp:linear:tokens")).toBe(false);

    await creds.close();
  });

  it("rejects `credentials` set without `keyOf`", () => {
    const { harness: creds } = fakeCredentialsHarness({
      providers: [fakeCredentialProvider({ namespace: "mcp" })],
    });
    expect(
      () =>
        new DefaultOAuthProvider({
          serverName: "linear",
          serverUrl: "https://example.invalid",
          credentials: creds,
        }),
    ).toThrow(/keyOf/);
    void creds.close();
  });
});

describe("DefaultOAuthProvider — non-interactive guard", () => {
  it("throws McpCredentialsRequiredError(kind=missing) before invalidation", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "linear",
      serverUrl: "https://example.invalid",
      interactive: false,
    });

    await expect(
      provider.redirectToAuthorization(new URL("https://x.invalid")),
    ).rejects.toMatchObject({
      _tag: "McpCredentialsRequiredError",
      serverId: "linear",
      kind: "missing",
    });
  });

  it("throws McpCredentialsRequiredError(kind=expired) after token invalidation", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "linear",
      serverUrl: "https://example.invalid",
      interactive: false,
    });
    await provider.onInvalidateCredentials("tokens");

    await expect(
      provider.redirectToAuthorization(new URL("https://x.invalid")),
    ).rejects.toMatchObject({
      _tag: "McpCredentialsRequiredError",
      serverId: "linear",
      kind: "expired",
    });
  });

  it("interactive=true (default) fires the elicit / falls back to onAuthorizationNeeded", async () => {
    const urls: string[] = [];
    const provider = new DefaultOAuthProvider({
      serverName: "linear",
      serverUrl: "https://example.invalid",
      onAuthorizationNeeded: (url) => {
        urls.push(url.toString());
      },
    });

    await provider.redirectToAuthorization(new URL("https://x.invalid/auth"));

    expect(urls).toEqual(["https://x.invalid/auth"]);
  });
});

describe("McpClientHarness — connect() failure classifier", () => {
  it("classifies thrown McpCredentialsRequiredError(missing) → credentials-missing", async () => {
    // Construct a "transport" whose start() throws the credentials
    // error directly — the SDK Client surfaces it through
    // `client.connect()`. The harness's classifier walks the cause
    // chain and buckets accordingly.
    const failingTransport = {
      async start(): Promise<void> {
        throw new McpCredentialsRequiredError({ serverId: "linear", kind: "missing" });
      },
      async send(): Promise<void> {
        /* unreachable */
      },
      async close(): Promise<void> {
        /* idempotent */
      },
    };

    const harness = new McpClientHarness(
      `test:linear`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "linear",
        transport: failingTransport,
        auth: new NoneAuth(),
        elicitAddress: "elicit:test",
        clientInfo: { name: "linear", version: "1.0.0" },
      },
    );

    await expect(harness.connect()).rejects.toBeDefined();
    expect(harness.status).toEqual({ kind: "credentials-missing" });

    await harness.close();
  });

  it("classifies kind=expired → credentials-expired with reason", async () => {
    const failingTransport = {
      async start(): Promise<void> {
        throw new McpCredentialsRequiredError({ serverId: "linear", kind: "expired" });
      },
      async send(): Promise<void> {
        /* unreachable */
      },
      async close(): Promise<void> {
        /* idempotent */
      },
    };

    const harness = new McpClientHarness(
      `test:linear`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "linear",
        transport: failingTransport,
        auth: new NoneAuth(),
        elicitAddress: "elicit:test",
        clientInfo: { name: "linear", version: "1.0.0" },
      },
    );

    await expect(harness.connect()).rejects.toBeDefined();
    expect(harness.status.kind).toBe("credentials-expired");
    if (harness.status.kind === "credentials-expired") {
      expect(typeof harness.status.reason).toBe("string");
    }

    await harness.close();
  });

  it("walks .cause chain to find the credentials error under SDK wrappers", async () => {
    // Simulate SDK wrapping: a generic Error whose .cause is the
    // credentials error. The classifier must still detect it.
    const cred = new McpCredentialsRequiredError({ serverId: "linear", kind: "missing" });
    const wrapped = new Error("SDK wrapper");
    (wrapped as { cause: unknown }).cause = cred;

    const failingTransport = {
      async start(): Promise<void> {
        throw wrapped;
      },
      async send(): Promise<void> {
        /* unreachable */
      },
      async close(): Promise<void> {
        /* idempotent */
      },
    };

    const harness = new McpClientHarness(
      `test:linear`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "linear",
        transport: failingTransport,
        auth: new NoneAuth(),
        elicitAddress: "elicit:test",
        clientInfo: { name: "linear", version: "1.0.0" },
      },
    );

    await expect(harness.connect()).rejects.toBeDefined();
    expect(harness.status).toEqual({ kind: "credentials-missing" });

    await harness.close();
  });

  it("non-credentials failure falls through to error status", async () => {
    const [clientTransport] = InMemoryMcpTransport.createLinkedPair();
    const harness = new McpClientHarness(
      `test:x`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "x",
        transport: clientTransport,
        auth: new NoneAuth(),
        elicitAddress: "elicit:test",
        clientInfo: { name: "x", version: "1.0.0" },
      },
    );
    // Close the transport pre-connect to force a generic failure.
    await clientTransport.close();

    await expect(harness.connect()).rejects.toBeDefined();
    expect(harness.status.kind).toBe("error");

    await harness.close();
  });
});

describe("McpClientHarness — reauthenticate rebuilds with interactive=true", () => {
  it("calls rebuildTransport({ interactive: true }) when wired", async () => {
    const interactiveValues: boolean[] = [];

    // Always-failing transport so connect() exits quickly; we only
    // care about the rebuild flag.
    const mkFailingTransport = () => ({
      async start(): Promise<void> {
        throw new Error("test failure");
      },
      async send(): Promise<void> {
        /* unreachable */
      },
      async close(): Promise<void> {
        /* idempotent */
      },
    });

    const initial = mkFailingTransport();
    const harness = new McpClientHarness(
      `test:linear`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "linear",
        transport: initial,
        auth: new NoneAuth(),
        elicitAddress: "elicit:test",
        clientInfo: { name: "linear", version: "1.0.0" },
        rebuildTransport: async ({ interactive }) => {
          interactiveValues.push(interactive);
          return mkFailingTransport();
        },
      },
    );

    // Initial optimistic connect fails (not via rebuild).
    await expect(harness.connect()).rejects.toBeDefined();
    expect(interactiveValues).toEqual([]);

    // Reauthenticate must run the rebuild closure with interactive=true.
    await expect(harness.reauthenticate()).rejects.toBeDefined();
    expect(interactiveValues).toEqual([true]);

    await harness.close();
  });

  it("falls back to reconnect when rebuildTransport is unwired", async () => {
    const [clientTransport] = InMemoryMcpTransport.createLinkedPair();
    const harness = new McpClientHarness(
      `test:x`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        serverId: "x",
        transport: clientTransport,
        auth: new NoneAuth(),
        elicitAddress: "elicit:test",
        clientInfo: { name: "x", version: "1.0.0" },
      },
    );
    // No rebuild closure — reauth degenerates to disconnect+connect.
    await clientTransport.close();
    await expect(harness.reauthenticate()).rejects.toBeDefined();
    // Status reflects the final connect's failure, not a reauth-
    // specific error.
    expect(harness.status.kind === "error" || harness.status.kind === "credentials-missing").toBe(
      true,
    );

    await harness.close();
  });
});

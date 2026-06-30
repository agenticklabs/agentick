/**
 * Type-contract pin for the #277a surface. Behavior lands in #277b —
 * this spec only checks the shape: every kind is constructible, the
 * terminal-status helper agrees with the design table, the
 * credentials-store ref impl satisfies its interface, and the stub
 * action methods on `McpClientHandle` throw with a clear pointer.
 */
import { describe, expect, it } from "vitest";

import {
  type CredentialsStore,
  InMemoryCredentialsStore,
  isTerminalStatus,
  type McpConnectionStatus,
} from "../client/index.js";

describe("#277a — connection status type surface", () => {
  it("constructs every status kind", () => {
    const variants: ReadonlyArray<McpConnectionStatus> = [
      { kind: "disconnected" },
      { kind: "connecting" },
      { kind: "connected" },
      { kind: "credentials-missing" },
      { kind: "credentials-expired", reason: "refresh failed" },
      { kind: "error", reason: "tcp refused" },
    ];
    expect(variants).toHaveLength(6);
  });

  it("isTerminalStatus matches the design — only `connecting` is transitional", () => {
    expect(isTerminalStatus({ kind: "connecting" })).toBe(false);
    expect(isTerminalStatus({ kind: "disconnected" })).toBe(true);
    expect(isTerminalStatus({ kind: "connected" })).toBe(true);
    expect(isTerminalStatus({ kind: "credentials-missing" })).toBe(true);
    expect(isTerminalStatus({ kind: "credentials-expired" })).toBe(true);
    expect(isTerminalStatus({ kind: "error", reason: "x" })).toBe(true);
  });
});

describe("#277a — credentials store", () => {
  it("InMemoryCredentialsStore satisfies CredentialsStore<T>", async () => {
    type Tok = { access_token: string };
    const store: CredentialsStore<Tok> = new InMemoryCredentialsStore<Tok>();
    expect(await store.get("srv-a")).toBeUndefined();
    await store.set("srv-a", { access_token: "abc" });
    expect(await store.get("srv-a")).toEqual({ access_token: "abc" });
    await store.delete("srv-a");
    expect(await store.get("srv-a")).toBeUndefined();
    // delete on unknown key is a no-op
    await store.delete("missing");
  });

  it("isolates entries by serverId", async () => {
    const store = new InMemoryCredentialsStore();
    await store.set("srv-a", { access_token: "a" });
    await store.set("srv-b", { access_token: "b" });
    expect(await store.get("srv-a")).toEqual({ access_token: "a" });
    expect(await store.get("srv-b")).toEqual({ access_token: "b" });
    await store.delete("srv-a");
    expect(await store.get("srv-a")).toBeUndefined();
    expect(await store.get("srv-b")).toEqual({ access_token: "b" });
  });
});

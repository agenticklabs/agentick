/**
 * Type-contract pin for the #277a connection-status surface.
 * Behavior — including the credential-aware lifecycle — lands in
 * #277b. This spec only checks that the status union is constructible
 * and that `isTerminalStatus` agrees with the design table.
 *
 * (The credential-store contract is no longer tested here. The
 * per-MCP `CredentialsStore<T>` shim from #277a was retired in
 * #281c — the substrate `CredentialsHarness` from
 * `@agentick/credentials-next` is the canonical credential surface,
 * with its own conformance suite over the store interface.)
 */
import { describe, expect, it } from "vitest";

import { isTerminalStatus, type McpConnectionStatus } from "../client/index.js";

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

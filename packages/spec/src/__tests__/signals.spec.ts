/**
 * Runtime signal family name/query builders (ADR 64) — pure shape.
 *
 * These are firewall helpers with no runtime dependency, so the pure
 * claims (canonical name construction + the cross-surface query shape)
 * are pinned here. The *matching* claim — that `logEventQuery()` /
 * `progressEventQuery()` actually accept names emitted across multiple
 * surfaces — is verified against the real matcher in
 * `@agentick/runtime` (`compileQuery`), where that dependency lives:
 * packages/runtime/src/__tests__/signals.spec.ts.
 */

import { describe, expect, it } from "vitest";

import {
  SIGNAL_NAME_DOMAIN,
  logEventName,
  logEventQuery,
  progressEventName,
  progressEventQuery,
} from "../data/signals.js";

describe("signal name construction (ADR 64)", () => {
  it("uses the `signal` name domain as the middle segment", () => {
    expect(SIGNAL_NAME_DOMAIN).toBe("signal");
    expect(logEventName("tool")).toBe("tool:signal:log");
    expect(logEventName("mcp")).toBe("mcp:signal:log");
    expect(progressEventName("session")).toBe("session:signal:progress");
  });
});

describe("signal query builders (ADR 64)", () => {
  it("logEventQuery matches log across all surfaces via a single-segment wildcard", () => {
    expect(logEventQuery()).toEqual({ name: { wildcard: "*:signal:log" } });
  });

  it("progressEventQuery matches progress across all surfaces", () => {
    expect(progressEventQuery()).toEqual({ name: { wildcard: "*:signal:progress" } });
  });
});

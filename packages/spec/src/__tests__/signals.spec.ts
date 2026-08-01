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
  isProgressEventName,
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

describe("isProgressEventName — the predicate form of the query", () => {
  it("accepts a progress signal from ANY surface", () => {
    for (const surface of ["tool", "mcp", "session", "tasks"]) {
      expect(isProgressEventName(progressEventName(surface))).toBe(true);
    }
  });

  it("refuses everything else, including the family's other signal", () => {
    expect(isProgressEventName(logEventName("tool"))).toBe(false);
    expect(isProgressEventName("session:execution:event")).toBe(false);
    expect(isProgressEventName("session:channel:task-status")).toBe(false);
  });

  it("matches the wildcard EXACTLY — `*` is one segment, not a suffix", () => {
    // A consumer discriminating a mixed stream must not admit a name that
    // merely ends the right way; `endsWith` would take this one.
    expect(isProgressEventName("a:b:signal:progress")).toBe(false);
    expect(isProgressEventName("signal:progress")).toBe(false);
  });
});

/**
 * `parseTraceparent` — the ONE parser, and it runs on untrusted input.
 *
 * A browser sends this header, so every case here is an attacker-reachable
 * input, not a hypothetical.
 */

import { describe, expect, it } from "vitest";

import { formatTraceparent, parseTraceparent } from "../wire/json-rpc.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

describe("parseTraceparent", () => {
  it("parses the canonical sampled form", () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: true,
    });
  });

  it("reads the sampled bit rather than assuming it", () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.sampled).toBe(false);
    // Any odd flags byte sets the bit — `03` is sampled plus a flag we ignore.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-03`)?.sampled).toBe(true);
  });

  it("accepts a FUTURE version — the spec says be lenient forward", () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01`)?.traceId).toBe(TRACE);
  });

  it("rejects version ff, which the spec reserves", () => {
    expect(parseTraceparent(`ff-${TRACE}-${SPAN}-01`)).toBeUndefined();
  });

  it("rejects all-zero ids — the spec's way of saying NO span", () => {
    // Parenting under one produces a trace nobody can join.
    expect(parseTraceparent(`00-${"0".repeat(32)}-${SPAN}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE}-${"0".repeat(16)}-01`)).toBeUndefined();
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseTraceparent(`  00-${TRACE.toUpperCase()}-${SPAN}-01  `)?.traceId).toBe(TRACE);
  });

  it("returns undefined for junk rather than throwing", () => {
    // Untrusted input: a malformed value is a fact about the caller, never a
    // reason to fail their request.
    for (const bad of [
      undefined,
      "",
      "not-a-traceparent",
      `00-${TRACE}-${SPAN}`,
      `00-${TRACE}-${SPAN}-01-extra`,
      `00-${TRACE.slice(0, 31)}-${SPAN}-01`,
      `00-${TRACE}-${SPAN}-0z`,
      `<script>alert(1)</script>`,
    ]) {
      expect(() => parseTraceparent(bad as string | undefined)).not.toThrow();
      expect(parseTraceparent(bad as string | undefined)).toBeUndefined();
    }
  });
});

describe("formatTraceparent", () => {
  it("round-trips", () => {
    for (const sampled of [true, false]) {
      const ctx = { traceId: TRACE, spanId: SPAN, sampled };
      expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
    }
  });
});

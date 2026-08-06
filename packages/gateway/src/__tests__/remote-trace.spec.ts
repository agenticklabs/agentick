import { describe, expect, it } from "vitest";

import { remoteTrace } from "../remote-trace.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const SAMPLED = `00-${TRACE}-${SPAN}-01`;

const withHeader = (traceparent: string) => ({ _meta: { traceparent } });

describe("remoteTrace", () => {
  it("links by default — the caller is untrusted, so its sampling choice is not adopted", () => {
    expect(remoteTrace(withHeader(SAMPLED), undefined)).toEqual({ traceLink: SAMPLED });
  });

  it("parents only when the operator opts in", () => {
    expect(remoteTrace(withHeader(SAMPLED), "parent")).toEqual({ traceparent: SAMPLED });
  });

  it("drops the header entirely under `ignore` — two independent trees", () => {
    expect(remoteTrace(withHeader(SAMPLED), "ignore")).toEqual({});
  });

  it("preserves the caller's sampled bit rather than re-deciding it", () => {
    const unsampled = `00-${TRACE}-${SPAN}-00`;
    expect(remoteTrace(withHeader(unsampled), "link")).toEqual({ traceLink: unsampled });
  });

  it("normalises through the parser — a valid-but-ugly header reaches the substrate canonical", () => {
    const ugly = `  00-${TRACE.toUpperCase()}-${SPAN}-01  `;
    expect(remoteTrace(withHeader(ugly), "link")).toEqual({ traceLink: SAMPLED });
  });

  it.each([
    ["malformed", "not-a-traceparent"],
    ["reserved version ff", `ff-${TRACE}-${SPAN}-01`],
    ["all-zero trace id", `00-${"0".repeat(32)}-${SPAN}-01`],
    ["all-zero span id", `00-${TRACE}-${"0".repeat(16)}-01`],
  ])("ignores an unusable header (%s) instead of failing the request", (_label, header) => {
    expect(remoteTrace(withHeader(header), "parent")).toEqual({});
  });

  it.each([
    ["absent params", undefined],
    ["no _meta", {}],
    ["no traceparent", { _meta: {} }],
  ])("returns nothing when there is no header at all (%s)", (_label, params) => {
    expect(remoteTrace(params, "parent")).toEqual({});
  });
});

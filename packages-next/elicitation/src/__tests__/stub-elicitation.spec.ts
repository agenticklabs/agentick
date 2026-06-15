/**
 * Tests for `stubElicitation()` — the canned-answer test double.
 *
 * Covers protocol shape, default behavior, custom canned result, and
 * the `onElicit` spy hook.
 */

import { describe, expect, it, vi } from "vitest";
import type { ElicitationRequest, StandardSchemaV1 } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { stubElicitation } from "../testing/stub-elicitation.js";

function approvalSchema(): StandardSchemaV1<unknown, { readonly approved: boolean }> {
  return jsonSchema<{ readonly approved: boolean }>(
    { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    {
      validator: (raw) =>
        typeof (raw as { approved?: unknown }).approved === "boolean"
          ? { value: { approved: (raw as { approved: boolean }).approved } }
          : { issues: [{ message: "missing `approved`" }] },
    },
  );
}

describe("stubElicitation — protocol shape", () => {
  it("satisfies ElicitationHarnessProtocol structurally", () => {
    const s = stubElicitation();
    expect(typeof s.id).toBe("string");
    expect(s.ready).toBeInstanceOf(Promise);
    expect(typeof s.elicit).toBe("function");
    expect(typeof s.respond).toBe("function");
    expect(typeof s.close).toBe("function");
  });

  it("id defaults to 'stub-elicitation' and respects the override", () => {
    expect(stubElicitation().id).toBe("stub-elicitation");
    expect(stubElicitation({ id: "custom" }).id).toBe("custom");
  });

  it("ready resolves immediately", async () => {
    await expect(stubElicitation().ready).resolves.toBeUndefined();
  });
});

describe("stubElicitation — default canned result", () => {
  it("returns declined with the default reason when no result is supplied", async () => {
    const s = stubElicitation();
    const result = await s.elicit({ message: "?", schema: approvalSchema() });
    expect(result.outcome).toBe("declined");
    if (result.outcome === "declined") {
      expect(result.reason).toBe("stub-elicitation default");
    }
  });
});

describe("stubElicitation — custom canned result", () => {
  it("returns the supplied result on every elicit", async () => {
    const s = stubElicitation({
      result: { outcome: "accepted", value: { approved: true } },
    });
    const a = await s.elicit({ message: "?", schema: approvalSchema() });
    const b = await s.elicit({ message: "??", schema: approvalSchema() });
    expect(a.outcome).toBe("accepted");
    expect(b.outcome).toBe("accepted");
    if (a.outcome === "accepted") expect(a.value).toEqual({ approved: true });
    if (b.outcome === "accepted") expect(b.value).toEqual({ approved: true });
  });

  it("surfaces failed results with their failure shape", async () => {
    const s = stubElicitation({
      result: { outcome: "failed", failure: { kind: "timeout" } },
    });
    const r = await s.elicit({ message: "?", schema: approvalSchema() });
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.failure.kind).toBe("timeout");
  });
});

describe("stubElicitation — onElicit spy hook", () => {
  it("fires with the request and opts on every elicit", async () => {
    const spy = vi.fn();
    const s = stubElicitation({ onElicit: spy });
    const req: ElicitationRequest = {
      message: "Confirm",
      schema: approvalSchema(),
      hints: { kind: "tool_confirmation" },
    };
    await s.elicit(req, { timeoutMs: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(req, { timeoutMs: 100 });
  });
});

describe("stubElicitation — respond + close are no-ops", () => {
  it("respond() resolves without effect", async () => {
    const s = stubElicitation();
    await expect(
      s.respond({ correlationId: "req:anything", outcome: "declined" }),
    ).resolves.toBeUndefined();
  });

  it("close() resolves without effect", async () => {
    const s = stubElicitation();
    await expect(s.close()).resolves.toBeUndefined();
  });
});

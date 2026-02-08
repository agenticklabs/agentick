import { describe, it, expect, vi } from "vitest";
import { toolGuardrail } from "./tool";
import { deny, allow } from "./policy";
import { GuardrailDenied } from "./errors";
import { GuardError, isGuardError } from "@tentickle/shared";
import type { ProcedureEnvelope } from "@tentickle/kernel";

/**
 * Helper to invoke a middleware with a fake envelope.
 */
function invoke(
  middleware: ReturnType<typeof toolGuardrail>,
  opts: {
    toolName?: string;
    input?: unknown;
    operationName?: string;
  } = {},
) {
  const args = [opts.input ?? {}];
  const envelope = {
    sourceType: "procedure" as const,
    operationName: opts.operationName ?? "tool:run",
    args,
    context: {} as any,
    metadata: { toolName: opts.toolName ?? "search", id: opts.toolName ?? "search" },
  } satisfies ProcedureEnvelope<any[]>;

  const next = vi.fn(async () => "next-result");

  const promise = middleware(args, envelope, next);
  return { promise, next };
}

describe("toolGuardrail", () => {
  it("deny rule throws GuardrailDenied with correct toolName and reason", async () => {
    const mw = toolGuardrail({ rules: [deny("search")] });
    const { promise } = invoke(mw, { toolName: "search" });

    await expect(promise).rejects.toThrow(GuardrailDenied);
    await expect(promise).rejects.toThrow('Tool "search" denied: denied by rule');
  });

  it("deny rule with custom reason", async () => {
    const rules = [{ patterns: ["search"], action: "deny" as const, reason: "No searching" }];
    const mw = toolGuardrail({ rules });
    const { promise } = invoke(mw, { toolName: "search" });

    await expect(promise).rejects.toThrow('Tool "search" denied: No searching');
  });

  it("allow rule calls next() and skips classifier", async () => {
    const classify = vi.fn(async () => ({ action: "deny" as const, reason: "should not reach" }));
    const mw = toolGuardrail({ rules: [allow("search")], classify });
    const { promise, next } = invoke(mw, { toolName: "search" });

    const result = await promise;
    expect(result).toBe("next-result");
    expect(next).toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("no matching rule + no classifier → allows (calls next)", async () => {
    const mw = toolGuardrail({ rules: [deny("exec_*")] });
    const { promise, next } = invoke(mw, { toolName: "search" });

    await promise;
    expect(next).toHaveBeenCalled();
  });

  it("classifier deny → throws GuardrailDenied", async () => {
    const classify = vi.fn(async () => ({ action: "deny" as const, reason: "Bad input" }));
    const mw = toolGuardrail({ classify });
    const { promise } = invoke(mw, { toolName: "search" });

    await expect(promise).rejects.toThrow(GuardrailDenied);
    await expect(promise).rejects.toThrow('Tool "search" denied: Bad input');
  });

  it("classifier allow → calls next", async () => {
    const classify = vi.fn(async () => ({ action: "allow" as const }));
    const mw = toolGuardrail({ classify });
    const { promise, next } = invoke(mw, { toolName: "search" });

    await promise;
    expect(next).toHaveBeenCalled();
  });

  it("classifier returns null → allows (default)", async () => {
    const classify = vi.fn(async () => null);
    const mw = toolGuardrail({ classify });
    const { promise, next } = invoke(mw, { toolName: "search" });

    await promise;
    expect(next).toHaveBeenCalled();
  });

  it("rules evaluated before classifier (allow rule skips classifier)", async () => {
    const classify = vi.fn(async () => ({ action: "deny" as const }));
    const mw = toolGuardrail({ rules: [allow("search")], classify });
    const { promise, next } = invoke(mw, { toolName: "search" });

    await promise;
    expect(next).toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("onDeny callback fires with toolName and reason", async () => {
    const onDeny = vi.fn();
    const mw = toolGuardrail({ rules: [deny("search")], onDeny });
    const { promise } = invoke(mw, { toolName: "search" });

    await promise.catch(() => {}); // suppress rejection
    expect(onDeny).toHaveBeenCalledWith("search", "denied by rule");
  });

  it("onDeny fires for classifier denials too", async () => {
    const onDeny = vi.fn();
    const classify = vi.fn(async () => ({ action: "deny" as const, reason: "Classifier says no" }));
    const mw = toolGuardrail({ classify, onDeny });
    const { promise } = invoke(mw, { toolName: "exec" });

    await promise.catch(() => {});
    expect(onDeny).toHaveBeenCalledWith("exec", "Classifier says no");
  });

  it("non-tool procedures pass through (operationName !== 'tool:run')", async () => {
    const mw = toolGuardrail({ rules: [deny("*")] });
    const { promise, next } = invoke(mw, {
      toolName: "search",
      operationName: "model:generate",
    });

    await promise;
    expect(next).toHaveBeenCalled();
  });

  it("GuardrailDenied extends GuardError (instanceof checks)", () => {
    const err = new GuardrailDenied("search", "no");
    expect(err instanceof GuardError).toBe(true);
    expect(err instanceof GuardrailDenied).toBe(true);
    expect(isGuardError(err)).toBe(true);
    expect(err.code).toBe("GUARD_DENIED");
    expect(err.guardType).toBe("guardrail");
    expect(err.toolName).toBe("search");
  });

  it("multiple rules: first match wins regardless of action", async () => {
    const mw = toolGuardrail({
      rules: [allow("search"), deny("search")],
    });
    const { promise, next } = invoke(mw, { toolName: "search" });

    await promise;
    expect(next).toHaveBeenCalled(); // allow wins
  });
});

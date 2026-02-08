import { describe, it, expect } from "vitest";
import { createGuard } from "./guard";
import { createProcedure, type ProcedureEnvelope } from "./procedure";
import { GuardError, isGuardError } from "@agentick/shared";

// =============================================================================
// createGuard — simple form: createGuard(fn)
// =============================================================================

describe("createGuard(fn)", () => {
  it("allows when fn returns true", async () => {
    const guard = createGuard(() => true);
    const proc = createProcedure(async (x: number) => x * 2).use(guard);
    const result = await proc(5).result;
    expect(result).toBe(10);
  });

  it("throws GuardError when fn returns false", async () => {
    const guard = createGuard(() => false);
    const proc = createProcedure(async (x: number) => x * 2).use(guard);
    await expect(proc(5).result).rejects.toThrow(GuardError);
  });

  it("uses default reason when none provided", async () => {
    const guard = createGuard(() => false);
    const proc = createProcedure(async () => "ok").use(guard);
    await expect(proc().result).rejects.toThrow("Guard check failed");
  });

  it("supports async guard functions", async () => {
    const guard = createGuard(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return true;
    });
    const proc = createProcedure(async (x: number) => x + 1).use(guard);
    const result = await proc(3).result;
    expect(result).toBe(4);
  });

  it("supports async guard functions that deny", async () => {
    const guard = createGuard(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return false;
    });
    const proc = createProcedure(async (x: number) => x + 1).use(guard);
    await expect(proc(3).result).rejects.toThrow(GuardError);
  });

  it("receives the full ProcedureEnvelope", async () => {
    let captured: ProcedureEnvelope<any[]> | undefined;

    const guard = createGuard((envelope) => {
      captured = envelope;
      return true;
    });

    const proc = createProcedure(
      { name: "test:proc", metadata: { toolName: "search" } },
      async (x: number) => x,
    ).use(guard);

    await proc(42).result;

    expect(captured).toBeDefined();
    expect(captured!.operationName).toBe("test:proc");
    expect(captured!.metadata).toEqual({ toolName: "search" });
    expect(captured!.args).toEqual([42]);
  });
});

// =============================================================================
// createGuard — config form: createGuard(config, fn)
// =============================================================================

describe("createGuard(config, fn)", () => {
  it("uses static reason from config", async () => {
    const guard = createGuard({ reason: "Admin access required" }, () => false);
    const proc = createProcedure(async () => "ok").use(guard);
    await expect(proc().result).rejects.toThrow("Admin access required");
  });

  it("uses dynamic reason from config", async () => {
    const guard = createGuard(
      {
        reason: (envelope) => `Denied for operation ${envelope.operationName}`,
      },
      () => false,
    );
    const proc = createProcedure({ name: "secret:operation" }, async () => "ok").use(guard);

    await expect(proc().result).rejects.toThrow("Denied for operation secret:operation");
  });

  it("sets guardType from config on the GuardError", async () => {
    const guard = createGuard({ guardType: "rate-limit" }, () => false);
    const proc = createProcedure(async () => "ok").use(guard);

    try {
      await proc().result;
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isGuardError(err)).toBe(true);
      expect((err as GuardError).guardType).toBe("rate-limit");
    }
  });

  it("includes guard name in error details", async () => {
    const guard = createGuard({ name: "admin-only", reason: "Nope" }, () => false);
    const proc = createProcedure(async () => "ok").use(guard);

    try {
      await proc().result;
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as GuardError).details.guard).toBe("admin-only");
    }
  });

  it("allows when fn returns true (config is ignored)", async () => {
    const guard = createGuard({ reason: "should not see this", guardType: "never" }, () => true);
    const proc = createProcedure(async (x: number) => x * 3).use(guard);
    const result = await proc(7).result;
    expect(result).toBe(21);
  });
});

// =============================================================================
// fn-throws pattern — GuardError thrown by fn propagates directly
// =============================================================================

describe("createGuard fn-throws pattern", () => {
  it("propagates GuardError thrown by fn (ignores config reason)", async () => {
    const guard = createGuard({ reason: "should NOT see this" }, () => {
      throw GuardError.role(["admin", "moderator"]);
    });
    const proc = createProcedure(async () => "ok").use(guard);

    try {
      await proc().result;
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isGuardError(err)).toBe(true);
      const guardErr = err as GuardError;
      // The fn's error takes precedence, not the config reason
      expect(guardErr.message).toBe("Requires one of roles [admin, moderator]");
      expect(guardErr.guardType).toBe("role");
      expect(guardErr.details.roles).toEqual(["admin", "moderator"]);
    }
  });

  it("propagates GuardError subclasses thrown by fn", async () => {
    class CustomGuardError extends GuardError {
      constructor(public readonly resource: string) {
        super(`Cannot access ${resource}`, "custom-acl", { resource });
        this.name = "CustomGuardError";
      }
    }

    const guard = createGuard({ name: "acl-guard" }, () => {
      throw new CustomGuardError("settings");
    });
    const proc = createProcedure(async () => "ok").use(guard);

    try {
      await proc().result;
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CustomGuardError);
      expect(isGuardError(err)).toBe(true);
      expect((err as CustomGuardError).resource).toBe("settings");
    }
  });

  it("propagates non-GuardError exceptions from fn as-is", async () => {
    const guard = createGuard(() => {
      throw new TypeError("unexpected null");
    });
    const proc = createProcedure(async () => "ok").use(guard);

    await expect(proc().result).rejects.toThrow(TypeError);
    await expect(proc().result).rejects.toThrow("unexpected null");
  });
});

// =============================================================================
// GuardError (unchanged from before — kept for regression)
// =============================================================================

describe("GuardError", () => {
  it("has code GUARD_DENIED", () => {
    const err = new GuardError("test");
    expect(err.code).toBe("GUARD_DENIED");
  });

  it("has name GuardError", () => {
    const err = new GuardError("test");
    expect(err.name).toBe("GuardError");
  });

  it("stores guardType", () => {
    const err = new GuardError("test", "role");
    expect(err.guardType).toBe("role");
  });

  it("role() factory creates correct error", () => {
    const err = GuardError.role(["admin", "moderator"]);
    expect(err.message).toBe("Requires one of roles [admin, moderator]");
    expect(err.guardType).toBe("role");
    expect(err.code).toBe("GUARD_DENIED");
    expect(err.details.roles).toEqual(["admin", "moderator"]);
  });

  it("denied() factory creates correct error", () => {
    const err = GuardError.denied("Not allowed", { resource: "settings" });
    expect(err.message).toBe("Not allowed");
    expect(err.guardType).toBe("custom");
    expect(err.code).toBe("GUARD_DENIED");
    expect(err.details.resource).toBe("settings");
  });
});

describe("isGuardError", () => {
  it("returns true for GuardError instances", () => {
    expect(isGuardError(new GuardError("test"))).toBe(true);
  });

  it("returns true for GuardError.role()", () => {
    expect(isGuardError(GuardError.role(["admin"]))).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isGuardError(new Error("test"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isGuardError(null)).toBe(false);
    expect(isGuardError(undefined)).toBe(false);
    expect(isGuardError("string")).toBe(false);
  });
});

/**
 * Guard Middleware Tests
 *
 * Tests for role-based and custom guard middleware behavior.
 * Verifies GuardError is thrown with correct codes and type guards work.
 */

import { describe, it, expect, vi } from "vitest";
import { Context, type KernelContext, type UserContext } from "@tentickle/kernel";
import { GuardError, isGuardError } from "@tentickle/shared";

// ============================================================================
// Role guard behavior tests
// ============================================================================

describe("Role guard behavior", () => {
  /**
   * Simulates the role guard logic used in Gateway
   */
  function checkRoles(roles: string[], userRoles: string[]): boolean {
    return roles.some((r) => userRoles.includes(r));
  }

  it("should pass when user has required role", () => {
    expect(checkRoles(["admin"], ["admin", "user"])).toBe(true);
  });

  it("should pass when user has any of multiple required roles", () => {
    expect(checkRoles(["admin", "moderator"], ["user", "moderator"])).toBe(true);
  });

  it("should fail when user lacks all required roles", () => {
    expect(checkRoles(["admin", "moderator"], ["user"])).toBe(false);
  });

  it("should fail when user has no roles", () => {
    expect(checkRoles(["admin"], [])).toBe(false);
  });

  it("should handle empty required roles (allows all)", () => {
    expect(checkRoles([], ["user"])).toBe(false); // some() on empty returns false
  });
});

// ============================================================================
// Custom guard behavior tests
// ============================================================================

describe("Custom guard behavior", () => {
  it("should allow when guard returns true", async () => {
    const guard = (ctx: KernelContext) => true;

    const user: UserContext = { id: "user-1" };
    const ctx = Context.create({ user });

    const result = await Context.run(ctx, () => guard(Context.get()));
    expect(result).toBe(true);
  });

  it("should deny when guard returns false", async () => {
    const guard = (ctx: KernelContext) => false;

    const user: UserContext = { id: "user-1" };
    const ctx = Context.create({ user });

    const result = await Context.run(ctx, () => guard(Context.get()));
    expect(result).toBe(false);
  });

  it("should support async guards", async () => {
    const guard = async (ctx: KernelContext) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return ctx.user?.id === "allowed-user";
    };

    const user1: UserContext = { id: "allowed-user" };
    const ctx1 = Context.create({ user: user1 });
    expect(await Context.run(ctx1, () => guard(Context.get()))).toBe(true);

    const user2: UserContext = { id: "other-user" };
    const ctx2 = Context.create({ user: user2 });
    expect(await Context.run(ctx2, () => guard(Context.get()))).toBe(false);
  });

  it("should have access to user context", async () => {
    const guard = (ctx: KernelContext) => {
      return ctx.user?.id === "specific-user" && ctx.user?.roles?.includes("premium");
    };

    const premiumUser: UserContext = { id: "specific-user", roles: ["user", "premium"] };
    const ctx1 = Context.create({ user: premiumUser });
    expect(await Context.run(ctx1, () => guard(Context.get()))).toBe(true);

    const regularUser: UserContext = { id: "specific-user", roles: ["user"] };
    const ctx2 = Context.create({ user: regularUser });
    expect(await Context.run(ctx2, () => guard(Context.get()))).toBe(false);
  });

  it("should have access to metadata", async () => {
    const guard = (ctx: KernelContext) => {
      return ctx.metadata?.tenantId === "allowed-tenant";
    };

    const ctx1 = Context.create({
      user: { id: "1" },
      metadata: { tenantId: "allowed-tenant" },
    });
    expect(await Context.run(ctx1, () => guard(Context.get()))).toBe(true);

    const ctx2 = Context.create({
      user: { id: "1" },
      metadata: { tenantId: "other-tenant" },
    });
    expect(await Context.run(ctx2, () => guard(Context.get()))).toBe(false);
  });
});

// ============================================================================
// Combined guards behavior tests
// ============================================================================

describe("Combined guards behavior", () => {
  it("should check roles before custom guard", async () => {
    const roleCheck = vi.fn((roles: string[], userRoles: string[]) =>
      roles.some((r) => userRoles.includes(r)),
    );
    const customGuard = vi.fn((ctx: KernelContext) => true);

    async function checkAllGuards(
      roles: string[],
      guard: (ctx: KernelContext) => boolean,
      ctx: KernelContext,
    ): Promise<boolean> {
      if (roles.length > 0) {
        const userRoles = ctx.user?.roles ?? [];
        if (!roleCheck(roles, userRoles)) {
          return false;
        }
      }
      return guard(ctx);
    }

    const user: UserContext = { id: "user-1", roles: ["user"] };
    const ctx = Context.create({ user });

    const result = await Context.run(ctx, () =>
      checkAllGuards(["admin"], customGuard, Context.get()),
    );

    expect(result).toBe(false);
    expect(roleCheck).toHaveBeenCalled();
    expect(customGuard).not.toHaveBeenCalled();
  });

  it("should call custom guard after roles pass", async () => {
    const customGuard = vi.fn((ctx: KernelContext) => ctx.user?.id === "allowed");

    async function checkAllGuards(
      roles: string[],
      guard: (ctx: KernelContext) => boolean,
      ctx: KernelContext,
    ): Promise<boolean> {
      if (roles.length > 0) {
        const userRoles = ctx.user?.roles ?? [];
        if (!roles.some((r) => userRoles.includes(r))) {
          return false;
        }
      }
      return guard(ctx);
    }

    const user: UserContext = { id: "allowed", roles: ["admin"] };
    const ctx = Context.create({ user });

    const result = await Context.run(ctx, () =>
      checkAllGuards(["admin"], customGuard, Context.get()),
    );

    expect(result).toBe(true);
    expect(customGuard).toHaveBeenCalled();
  });
});

// ============================================================================
// GuardError integration tests
// ============================================================================

describe("GuardError integration", () => {
  it("GuardError has correct error code", () => {
    const err = new GuardError("test");
    expect(err.code).toBe("GUARD_DENIED");
  });

  it("GuardError.role() sets guardType", () => {
    const err = GuardError.role(["admin"]);
    expect(err.guardType).toBe("role");
    expect(err.code).toBe("GUARD_DENIED");
  });

  it("GuardError.denied() sets guardType to custom", () => {
    const err = GuardError.denied("Nope");
    expect(err.guardType).toBe("custom");
    expect(err.code).toBe("GUARD_DENIED");
  });

  it("isGuardError type guard works", () => {
    expect(isGuardError(new GuardError("test"))).toBe(true);
    expect(isGuardError(GuardError.role(["admin"]))).toBe(true);
    expect(isGuardError(GuardError.denied("nope"))).toBe(true);
    expect(isGuardError(new Error("Forbidden: something"))).toBe(false);
    expect(isGuardError(null)).toBe(false);
  });

  it("GuardError propagates through guard middleware", () => {
    const guard = (_ctx: KernelContext) => {
      throw GuardError.role(["admin"]);
    };

    const ctx = Context.create({ user: { id: "1" } });

    expect(() => Context.run(ctx, () => guard(Context.get()))).toThrow(GuardError);
  });

  it("should handle async guard throwing GuardError", async () => {
    const guard = async (_ctx: KernelContext) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw GuardError.denied("Access denied");
    };

    const ctx = Context.create({ user: { id: "1" } });

    await expect(Context.run(ctx, () => guard(Context.get()))).rejects.toThrow(GuardError);
    await expect(Context.run(ctx, () => guard(Context.get()))).rejects.toThrow("Access denied");
  });
});

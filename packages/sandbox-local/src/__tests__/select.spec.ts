import { describe, it, expect } from "vitest";
import { selectExecutor } from "../executor/select";
import { BaseExecutor } from "../executor/base";
import { DarwinExecutor } from "../executor/darwin";
import { BwrapExecutor, UnshareExecutor } from "../executor/linux";

describe("selectExecutor", () => {
  it("returns BaseExecutor for 'none'", () => {
    const executor = selectExecutor("none");
    expect(executor).toBeInstanceOf(BaseExecutor);
    expect(executor.strategy).toBe("none");
  });

  it("returns DarwinExecutor for 'seatbelt'", () => {
    const executor = selectExecutor("seatbelt");
    expect(executor).toBeInstanceOf(DarwinExecutor);
    expect(executor.strategy).toBe("seatbelt");
  });

  it("returns BwrapExecutor for 'bwrap'", () => {
    const executor = selectExecutor("bwrap");
    expect(executor).toBeInstanceOf(BwrapExecutor);
    expect(executor.strategy).toBe("bwrap");
  });

  it("returns UnshareExecutor for 'unshare'", () => {
    const executor = selectExecutor("unshare");
    expect(executor).toBeInstanceOf(UnshareExecutor);
    expect(executor.strategy).toBe("unshare");
  });

  it("passes cgroup manager to linux executors", () => {
    // BwrapExecutor and UnshareExecutor accept optional cgroup
    const bwrap = selectExecutor("bwrap", undefined);
    expect(bwrap).toBeInstanceOf(BwrapExecutor);
    const unshare = selectExecutor("unshare", undefined);
    expect(unshare).toBeInstanceOf(UnshareExecutor);
  });
});

import { describe, it } from "vitest";
import { CgroupManager } from "../linux/cgroup";

describe("CgroupManager", () => {
  it("creates without error even when cgroups unavailable", async () => {
    const manager = new CgroupManager("test-001");
    // On macOS or systems without cgroup write access, this should degrade gracefully
    await manager.create({ memory: 512 * 1024 * 1024, maxProcesses: 10 });
    // addProcess should also be a no-op
    await manager.addProcess(999999);
    // destroy should be a no-op
    await manager.destroy();
  });

  it("destroy is idempotent", async () => {
    const manager = new CgroupManager("test-002");
    await manager.create({});
    await manager.destroy();
    await manager.destroy(); // Should not throw
  });
});

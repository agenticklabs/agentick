import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, destroyWorkspace, resolveMounts } from "../workspace";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

describe("createWorkspace", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const p of created) {
      await rm(p, { recursive: true, force: true }).catch(() => {});
    }
    created.length = 0;
  });

  it("auto-creates a temp workspace", async () => {
    const result = await createWorkspace(true);
    created.push(result.path);

    expect(result.autoCreated).toBe(true);
    expect(result.path).toContain("agentick-sandbox-");
    await access(result.path); // Should not throw
  });

  it("auto-creates workspace when undefined", async () => {
    const result = await createWorkspace(undefined);
    created.push(result.path);

    expect(result.autoCreated).toBe(true);
  });

  it("uses explicit path", async () => {
    const explicit = join(tmpdir(), `sandbox-explicit-${randomBytes(4).toString("hex")}`);
    created.push(explicit);

    const result = await createWorkspace(explicit);
    expect(result.autoCreated).toBe(false);
    await access(result.path);
  });

  it("respects custom tmpBase", async () => {
    const customBase = join(tmpdir(), `sandbox-base-${randomBytes(4).toString("hex")}`);
    await mkdir(customBase, { recursive: true });
    created.push(customBase);

    const result = await createWorkspace(true, customBase);
    created.push(result.path);

    expect(result.path).toContain(customBase);
  });
});

describe("destroyWorkspace", () => {
  it("removes auto-created workspace", async () => {
    const result = await createWorkspace(true);
    await destroyWorkspace(result.path, true);
    await expect(access(result.path)).rejects.toThrow("ENOENT");
  });

  it("does not remove non-auto-created workspace", async () => {
    const explicit = join(tmpdir(), `sandbox-nodelete-${randomBytes(4).toString("hex")}`);
    await mkdir(explicit, { recursive: true });
    try {
      await destroyWorkspace(explicit, false);
      await access(explicit); // Should still exist
    } finally {
      await rm(explicit, { recursive: true, force: true });
    }
  });
});

describe("resolveMounts", () => {
  it("resolves valid mounts", async () => {
    const mountDir = join(tmpdir(), `sandbox-mount-${randomBytes(4).toString("hex")}`);
    await mkdir(mountDir, { recursive: true });

    try {
      const mounts = await resolveMounts([{ host: mountDir, sandbox: "/mnt/data", mode: "ro" }]);
      expect(mounts).toHaveLength(1);
      expect(mounts[0].mode).toBe("ro");
      expect(mounts[0].sandboxPath).toBe("/mnt/data");
    } finally {
      await rm(mountDir, { recursive: true, force: true });
    }
  });

  it("throws on inaccessible host path", async () => {
    await expect(
      resolveMounts([{ host: "/nonexistent/path/xxx", sandbox: "/mnt/data" }]),
    ).rejects.toThrow("not accessible");
  });

  it("defaults mode to rw", async () => {
    const mountDir = join(tmpdir(), `sandbox-mount-${randomBytes(4).toString("hex")}`);
    await mkdir(mountDir, { recursive: true });

    try {
      const mounts = await resolveMounts([{ host: mountDir, sandbox: "/mnt/data" }]);
      expect(mounts[0].mode).toBe("rw");
    } finally {
      await rm(mountDir, { recursive: true, force: true });
    }
  });
});

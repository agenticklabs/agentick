import { describe, it, expect } from "vitest";
import { buildBwrapArgs } from "../linux/bwrap";
import type { SpawnOptions } from "../executor/types";

function makeOptions(overrides?: Partial<SpawnOptions>): SpawnOptions {
  return {
    cwd: "/workspace",
    env: {},
    workspacePath: "/workspace",
    mounts: [],
    permissions: {
      readPaths: ["/workspace"],
      writePaths: ["/workspace"],
      network: false,
      childProcess: true,
    },
    ...overrides,
  };
}

describe("buildBwrapArgs", () => {
  it("includes unshare-all by default", () => {
    const args = buildBwrapArgs(makeOptions());
    expect(args).toContain("--unshare-all");
  });

  it("does not include share-net when network denied", () => {
    const args = buildBwrapArgs(
      makeOptions({ permissions: { ...makeOptions().permissions, network: false } }),
    );
    expect(args).not.toContain("--share-net");
  });

  it("includes share-net when network allowed", () => {
    const args = buildBwrapArgs(
      makeOptions({
        permissions: { ...makeOptions().permissions, network: true },
      }),
    );
    expect(args).toContain("--share-net");
  });

  it("includes share-net when network is rule array", () => {
    const args = buildBwrapArgs(
      makeOptions({
        permissions: {
          ...makeOptions().permissions,
          network: [{ action: "allow", domain: "example.com" }],
        },
      }),
    );
    expect(args).toContain("--share-net");
  });

  it("binds workspace read-write", () => {
    const args = buildBwrapArgs(makeOptions());
    const bindIdx = args.indexOf("--bind");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(args[bindIdx + 1]).toBe("/workspace");
  });

  it("binds system dirs read-only", () => {
    const args = buildBwrapArgs(makeOptions());
    const roBind = args.indexOf("--ro-bind");
    expect(roBind).toBeGreaterThan(-1);
    // /usr should be one of the first ro-bind entries
    expect(args[roBind + 1]).toBe("/usr");
  });

  it("sets up proc, dev, tmpfs", () => {
    const args = buildBwrapArgs(makeOptions());
    expect(args).toContain("--proc");
    expect(args).toContain("--dev");
    expect(args).toContain("--tmpfs");
  });

  it("includes safety flags", () => {
    const args = buildBwrapArgs(makeOptions());
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
  });

  it("sets chdir to cwd", () => {
    const args = buildBwrapArgs(makeOptions({ cwd: "/workspace/subdir" }));
    const chdirIdx = args.indexOf("--chdir");
    expect(args[chdirIdx + 1]).toBe("/workspace/subdir");
  });

  it("handles ro mounts", () => {
    const args = buildBwrapArgs(
      makeOptions({
        mounts: [{ hostPath: "/data", sandboxPath: "/mnt/data", mode: "ro" }],
      }),
    );
    // Find the ro-bind for our mount (after system dirs)
    const lastRoBind = args.lastIndexOf("--ro-bind");
    expect(args[lastRoBind + 1]).toBe("/data");
    expect(args[lastRoBind + 2]).toBe("/mnt/data");
  });

  it("handles rw mounts", () => {
    const args = buildBwrapArgs(
      makeOptions({
        mounts: [{ hostPath: "/data", sandboxPath: "/mnt/data", mode: "rw" }],
      }),
    );
    // Find bind entries — the last --bind should be our mount (after workspace)
    let lastBindIdx = -1;
    for (let i = args.length - 1; i >= 0; i--) {
      if (args[i] === "--bind") {
        lastBindIdx = i;
        break;
      }
    }
    expect(args[lastBindIdx + 1]).toBe("/data");
    expect(args[lastBindIdx + 2]).toBe("/mnt/data");
  });
});

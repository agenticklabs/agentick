import { describe, it, expect } from "vitest";
import { buildUnshareArgs } from "../linux/unshare.js";
import type { SpawnOptions } from "../executor/types.js";

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

describe("buildUnshareArgs", () => {
  it("includes mount, pid, and fork flags", () => {
    const args = buildUnshareArgs(makeOptions());
    expect(args).toContain("--mount");
    expect(args).toContain("--pid");
    expect(args).toContain("--fork");
  });

  it("includes user namespace flags", () => {
    const args = buildUnshareArgs(makeOptions());
    expect(args).toContain("--user");
    expect(args).toContain("--map-root-user");
  });

  it("includes --net when network denied", () => {
    const args = buildUnshareArgs(makeOptions());
    expect(args).toContain("--net");
  });

  it("does not include --net when network allowed", () => {
    const args = buildUnshareArgs(
      makeOptions({
        permissions: { ...makeOptions().permissions, network: true },
      }),
    );
    expect(args).not.toContain("--net");
  });

  it("does not include --net when network is rule array", () => {
    const args = buildUnshareArgs(
      makeOptions({
        permissions: {
          ...makeOptions().permissions,
          network: [{ action: "allow", domain: "example.com" }],
        },
      }),
    );
    expect(args).not.toContain("--net");
  });

  it("returns args in correct order", () => {
    const args = buildUnshareArgs(makeOptions());
    // mount, pid, fork should come before net and user
    const mountIdx = args.indexOf("--mount");
    const netIdx = args.indexOf("--net");
    const userIdx = args.indexOf("--user");
    expect(mountIdx).toBeLessThan(netIdx);
    expect(netIdx).toBeLessThan(userIdx);
  });
});

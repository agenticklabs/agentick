import { describe, it, expect } from "vitest";
import { compileSeatbeltProfile } from "../seatbelt/profile";
import type { SpawnOptions } from "../executor/types";

function makeOptions(overrides?: Partial<SpawnOptions>): SpawnOptions {
  return {
    cwd: "/tmp/workspace",
    env: {},
    workspacePath: "/tmp/workspace",
    mounts: [],
    permissions: {
      readPaths: ["/tmp/workspace"],
      writePaths: ["/tmp/workspace"],
      network: false,
      childProcess: true,
    },
    ...overrides,
  };
}

describe("compileSeatbeltProfile", () => {
  it("generates a valid profile with default options", () => {
    const profile = compileSeatbeltProfile(makeOptions());

    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process*)");
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain('(subpath "/tmp/workspace")');
    expect(profile).toContain("(deny network*)");
  });

  it("denies reads to all sensitive paths", () => {
    const profile = compileSeatbeltProfile(makeOptions());

    expect(profile).toContain('(deny file-read* (subpath "/Users"))');
    expect(profile).toContain('(deny file-read* (subpath "/private/var/root"))');
    expect(profile).toContain('(deny file-read* (subpath "/Volumes"))');
    expect(profile).toContain('(deny file-read* (subpath "/Network"))');
    expect(profile).toContain('(deny file-read* (subpath "/Library/Keychains"))');
    expect(profile).toContain('(deny file-read* (subpath "/private/var/db/dslocal"))');
  });

  it("re-allows workspace reads after deny", () => {
    const profile = compileSeatbeltProfile(makeOptions());

    // Workspace re-allow should come after the deny
    const denyIdx = profile.indexOf('(deny file-read* (subpath "/Users"))');
    const allowIdx = profile.indexOf('(allow file-read* (subpath "/tmp/workspace"))');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(denyIdx);
  });

  it("restricts file writes to workspace and temp", () => {
    const profile = compileSeatbeltProfile(makeOptions());

    const writeLines = profile
      .split("\n")
      .filter((l) => l.includes("file-write*") && l.includes("allow"));
    expect(writeLines.some((l) => l.includes("/tmp/workspace"))).toBe(true);
    expect(writeLines.some((l) => l.includes("/private/tmp"))).toBe(true);
    expect(writeLines.some((l) => l.includes('"/dev"'))).toBe(true);
  });

  it("denies network when net is false", () => {
    const profile = compileSeatbeltProfile(makeOptions());
    expect(profile).toContain("(deny network*)");
  });

  it("allows network when net is true", () => {
    const profile = compileSeatbeltProfile(
      makeOptions({
        permissions: {
          readPaths: [],
          writePaths: [],
          network: true,
          childProcess: true,
        },
      }),
    );
    expect(profile).toContain("(allow network*)");
    expect(profile).not.toContain("(deny network*)");
  });

  it("allows network when net is NetworkRule[]", () => {
    const profile = compileSeatbeltProfile(
      makeOptions({
        permissions: {
          readPaths: [],
          writePaths: [],
          network: [{ action: "allow", domain: "example.com" }],
          childProcess: true,
        },
      }),
    );
    expect(profile).toContain("(allow network*)");
  });

  it("does not add write for read-only mounts", () => {
    const profile = compileSeatbeltProfile(
      makeOptions({
        mounts: [{ hostPath: "/data/shared", sandboxPath: "/mnt/shared", mode: "ro" }],
      }),
    );
    // ro mount should have read re-allow but not write
    expect(profile).toContain('(allow file-read* (subpath "/data/shared"))');
    const writeLines = profile
      .split("\n")
      .filter((l) => l.includes("file-write*") && l.includes("allow"));
    expect(writeLines.some((l) => l.includes("/data/shared"))).toBe(false);
  });

  it("adds read and write for read-write mounts", () => {
    const profile = compileSeatbeltProfile(
      makeOptions({
        mounts: [{ hostPath: "/data/rw", sandboxPath: "/mnt/rw", mode: "rw" }],
      }),
    );
    expect(profile).toContain('(allow file-read* (subpath "/data/rw"))');
    expect(profile).toContain('(allow file-write* (subpath "/data/rw"))');
  });

  it("re-allows reads for mounts under /Users", () => {
    const profile = compileSeatbeltProfile(
      makeOptions({
        mounts: [{ hostPath: "/Users/shared/data", sandboxPath: "/mnt/data", mode: "ro" }],
      }),
    );
    // Mount read should come after /Users deny (more specific wins)
    expect(profile).toContain('(deny file-read* (subpath "/Users"))');
    expect(profile).toContain('(allow file-read* (subpath "/Users/shared/data"))');
  });
});

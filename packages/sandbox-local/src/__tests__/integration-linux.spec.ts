/**
 * Linux Sandbox Integration Tests
 *
 * These tests verify that bwrap/unshare actually enforce filesystem and
 * network restrictions. They only run on Linux.
 *
 * TODO: Implement when we have a Linux CI environment to verify against.
 * Tests should mirror integration-darwin.spec.ts:
 *
 * - runs basic commands under bwrap
 * - allows reading and writing within workspace
 * - denies writing files outside workspace
 * - denies network access when net is false
 * - verify cgroup limits (memory, process count) when available
 */

import { describe, it } from "vitest";
import { isLinux } from "../testing";

describe.skipIf(!isLinux)("linux sandbox enforcement", () => {
  it.todo("runs basic commands under bwrap");
  it.todo("allows reading and writing within workspace");
  it.todo("denies writing files outside workspace");
  it.todo("denies network access when net is false");
  it.todo("enforces cgroup memory limits");
});

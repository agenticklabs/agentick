/**
 * The default provider — resolved at install, never a build dependency.
 *
 * `@agentick/code-host` depends on this package, so a manifest edge back would
 * be a cycle; the specifier is a variable and the import is optional. These
 * pins hold both arms: what an adopter who has it gets, and what an adopter who
 * does not gets instead.
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";
import type { SessionInstaller } from "@agentick/spec";

import { DEFAULT_RUNTIME_PACKAGE, resolveDefaultRuntime } from "../default-runtime.js";
import { fakeCodeHarness } from "../testing/index.js";

// The default provider is session-blind — its resolve ignores the installer —
// so a bare stub stands in for the argument the host path never reads.
const noInstaller = {} as SessionInstaller;

describe("the default runtime", () => {
  it("resolves to the host runtime when the package is present", async () => {
    const runtime = await resolveDefaultRuntime().resolve(noInstaller);

    // Named for the engine running this process — the point of the default is
    // that it introduces no engine the adopter had not already accepted.
    expect(runtime.capabilities.name).toMatch(/^host:/);
    await runtime.dispose();
  });

  it("names the package it looks for, so the failure mode is greppable", () => {
    expect(DEFAULT_RUNTIME_PACKAGE).toBe("@agentick/code-host");
  });

  it("an unresolved default leaves the harness INERT, and the error names the install", async () => {
    // The state `withCode()` produces when the import finds nothing: mounted,
    // present, and honest about being unable to run anything.
    const { harness, close } = await fakeCodeHarness();

    expect(harness.hasRuntime()).toBe(false);
    await expect(harness.execute({ source: "anything" })).rejects.toMatchObject({
      _tag: "CodeProviderMissing",
      message: expect.stringContaining(DEFAULT_RUNTIME_PACKAGE),
    });

    await close();
  });
});

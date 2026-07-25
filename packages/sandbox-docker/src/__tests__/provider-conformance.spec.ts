/**
 * The docker provider runs the shared provider conformance suite (#218)
 * against a REAL container — real `docker exec`, real volumes, real atomic
 * writes. Not a fake (ADR 59).
 *
 * GATED on docker availability: a `docker info` (`/_ping`) probe decides
 * whether to run. Where docker is absent (most CI), the suite is registered
 * as skipped rather than failing — the ADR calls for real docker in the
 * conformance test, so there is no fake fallback. The gate is threaded as
 * the conformance `skip` option / `describe.skipIf` (not a top-level `if`
 * around the test calls, which the linter forbids).
 *
 * Beyond the shared suite, this file pins docker's two CAPABILITY-TIER
 * boundaries the ADR flags for docker specifically:
 *   - runtime `addMount`/`removeMount`/`listMounts` → `SandboxUnsupportedError`
 *     (docker can't remount a running container);
 *   - a per-domain `NetworkRule[]` → `SandboxUnsupportedError` at `create`
 *     (the coarse `NetworkMode` tier can't express it) — asserted WITHOUT
 *     docker, since it fails fast before any daemon call.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SandboxUnsupportedError } from "@agentick/sandbox";
import { runSandboxProviderConformance } from "@agentick/sandbox/testing";
import type { SandboxHandle } from "@agentick/sandbox";
import { DockerAPI } from "../docker-api.js";
import { dockerProvider } from "../provider.js";

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.SANDBOX_DOCKER_TEST_IMAGE ?? "node:22-slim";

// Availability probe — a real daemon must answer within the timeout, else
// the whole suite is skipped (no fake fallback; ADR 59 wants real docker).
const dockerAvailable = await new DockerAPI(SOCKET).probe();

// ── Network capability tier — asserted WITHOUT docker (fails fast) ───
describe("docker provider — network capability tier", () => {
  it("throws SandboxUnsupportedError for a per-domain NetworkRule[]", async () => {
    const provider = dockerProvider({ socketPath: SOCKET, image: IMAGE });
    await expect(
      provider.create({
        workspace: true,
        allow: { network: [{ action: "allow", domain: "api.github.com" }] },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedError);
  });
});

// ── Shared #218 contract against a real container (gated) ───
runSandboxProviderConformance(() => dockerProvider({ socketPath: SOCKET, image: IMAGE }), {
  label: "docker",
  skip: !dockerAvailable,
});

// ── Docker-specific: the mount capability tier throws (gated) ───
// The shared suite tolerates BOTH honest answers (undefined OR throws);
// this pins docker's throwing case explicitly.
describe.skipIf(!dockerAvailable)("docker provider — mount capability tier", () => {
  const live: SandboxHandle[] = [];
  afterEach(async () => {
    await Promise.all(live.map((h) => h.destroy().catch(() => {})));
    live.length = 0;
  });

  it("addMount/removeMount/listMounts throw SandboxUnsupportedError", async () => {
    const provider = dockerProvider({ socketPath: SOCKET, image: IMAGE });
    const sb = await provider.create({ workspace: true });
    live.push(sb);

    await expect(sb.addMount!({ hostPath: "/tmp", sandboxPath: "mnt" })).rejects.toBeInstanceOf(
      SandboxUnsupportedError,
    );
    await expect(sb.removeMount!("mnt")).rejects.toBeInstanceOf(SandboxUnsupportedError);
    await expect(sb.listMounts!()).rejects.toBeInstanceOf(SandboxUnsupportedError);
  });
});

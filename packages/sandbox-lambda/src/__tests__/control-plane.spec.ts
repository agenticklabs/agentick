/**
 * Two layers of control-plane coverage (ADR 60):
 *
 *  1. **Orchestration (no AWS)** — verifies `provider.create()` drives the
 *     control plane in the ADR order (`runMicrovm → waitRunning →
 *     createAuthToken → handle`) and terminates on `destroy()`, using a
 *     recording spy composed over the loopback fake. The handle is real (a
 *     loopback agent), so the orchestration is proven end-to-end without AWS.
 *
 *  2. **AWS-integration conformance** — runs the shared #218 suite against a
 *     REAL microVM via the default {@link awsLambdaMicrovmsControlPlane}. GATED
 *     on real AWS availability (creds + a configured image ARN). Where AWS is
 *     absent (this env, most CI) the suite registers as skipped — no fake
 *     fallback (the ADR wants a real microVM here), mirroring docker's
 *     `docker info` gate.
 */

import { describe, expect, it } from "vitest";
import { runSandboxProviderConformance } from "@agentick/sandbox/testing";
import type { LambdaMicrovmsControlPlane } from "../control-plane.js";
import { lambdaProvider } from "../provider.js";
import { fakeLambdaMicrovmsControlPlane } from "../testing/index.js";

// ── Orchestration — create() call order via a spy over the loopback fake ───
describe("lambda provider — create() orchestration", () => {
  it("drives runMicrovm → waitRunning → createAuthToken → handle, then terminate on destroy", async () => {
    const fake = fakeLambdaMicrovmsControlPlane();
    const calls: string[] = [];
    const spy: LambdaMicrovmsControlPlane = {
      runMicrovm: (o) => {
        calls.push("runMicrovm");
        return fake.runMicrovm(o);
      },
      waitRunning: (id, o) => {
        calls.push("waitRunning");
        return fake.waitRunning(id, o);
      },
      createAuthToken: (id, o) => {
        calls.push("createAuthToken");
        return fake.createAuthToken(id, o);
      },
      terminateMicrovm: (id) => {
        calls.push("terminateMicrovm");
        return fake.terminateMicrovm(id);
      },
    };

    const provider = lambdaProvider({ imageIdentifier: "loopback", controlPlane: spy });
    const sb = await provider.create({ workspace: true });

    // Orchestration order (before any handle op).
    expect(calls).toEqual(["runMicrovm", "waitRunning", "createAuthToken"]);
    expect(sb.workspacePath).toBeTruthy();

    // The handle is real — it talks to the loopback agent.
    const echo = await sb.exec("echo orchestrated");
    expect(echo.stdout.trim()).toBe("orchestrated");

    await sb.destroy();
    expect(calls).toContain("terminateMicrovm");

    await fake.stopAll();
  });

  it("passes create-time env through the run-hook to every exec", async () => {
    const controlPlane = fakeLambdaMicrovmsControlPlane();
    const provider = lambdaProvider({ imageIdentifier: "loopback", controlPlane });
    const sb = await provider.create({ workspace: true, env: { SEEDED: "yes" } });
    const out = await sb.exec("echo $SEEDED");
    expect(out.stdout.trim()).toBe("yes");
    await sb.destroy();
    await controlPlane.stopAll();
  });
});

// ── AWS-integration conformance — gated on real AWS (registers skipped here) ───
const awsAvailable = Boolean(
  process.env.SANDBOX_LAMBDA_TEST_IMAGE &&
  (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION),
);

runSandboxProviderConformance(
  () =>
    lambdaProvider({
      imageIdentifier: process.env.SANDBOX_LAMBDA_TEST_IMAGE ?? "",
      aws: { region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION },
      ...(process.env.SANDBOX_LAMBDA_INTERNET_EGRESS_CONNECTOR
        ? { internetEgressConnector: process.env.SANDBOX_LAMBDA_INTERNET_EGRESS_CONNECTOR }
        : {}),
    }),
  { label: "lambda (aws)", skip: !awsAvailable },
);
